import { Injectable } from '@nestjs/common';
import {
  CreateTicketDto,
  GetMyTicketsDto,
  WithdrawTicketDto,
} from './dto/create-ticket.dto';
import { isTransitionAllowed } from '../ticket-admin/status-transitions';
import { PrismaService } from '../../prisma.service';
import { generateTicketId, l1CodeToTicketCategory } from '../../common/utils/id-generator';
import { maskEmail, maskMobile } from '../../common/utils/pii-masker';
import { NotificationQueue } from '../notification/notification.queue';
import type { TicketAttachment } from '@prisma/client';

import {
  ApiResponse,
  AppLogger,
  ErrorCode,
  BoltpeException,
  S3UploadUtil,
} from '@boltpe/shared';

// SLA response/resolution targets by priority level

const SLA_BANDS: Record<number, { firstResponseSec: number; resolutionSec: number }> = {
  1: { firstResponseSec: 30 * 60, resolutionSec: 4 * 3600 },     // Priority 1: 30 min / 4h
  2: { firstResponseSec: 2 * 3600, resolutionSec: 24 * 3600 },   // Priority 2: 2h / 24h
  3: { firstResponseSec: 8 * 3600, resolutionSec: 72 * 3600 },   // Priority 3: 8h / 72h
  4: { firstResponseSec: 24 * 3600, resolutionSec: 120 * 3600 }, // Priority 4: 24h / 120h
};
/** Fallback queue for a category with no routingSkill set — e.g. a chatbot-only
 *  category, or one created before routing moved onto the L1. */
const DEFAULT_ROUTING_SKILL = 'General triage';

const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'PENDING_PARTNER', 'REOPENED'];
const MAX_OPEN_TICKETS = 20;
const DUPLICATE_WINDOW_HOURS = 24;

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']);
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB — PRD limit

export const MAX_ATTACHMENTS_PER_TICKET = 5;

/** "30 minutes" / "4 hours" — used in the ticket confirmation email. */
function formatDuration(seconds: number): string {
  if (seconds < 3600) {
    const mins = Math.round(seconds / 60);
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  const hours = Math.round(seconds / 3600);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

@Injectable()
export class TicketService {
  private readonly logger = new AppLogger(
    'ticket-service',
    process.env.NODE_ENV || 'development',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationQueue,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // GET /tickets/categories(L1)
  // ─────────────────────────────────────────────────────────────────────────
  async getL1Categories(botId?: string) {
    this.logger.info('[TICKET][CATEGORIES-L1] Fetching', { botId });

    const botFilter = botId
      ? { OR: [{ botId }, { botId: null }] }
      : { botId: null };

    const categories = await this.prisma.issueCategoryL1.findMany({
      where: { isActive: true, ...botFilter },
      orderBy: { sortOrder: 'asc' },
    });

    this.logger.info('[TICKET][CATEGORIES-L1] Success', { count: categories.length });
    return ApiResponse.success(categories, 'L1 categories fetched');
  }

// ─────────────────────────────────────────────────────────────────────────
  // POST /tickets — Layer 1
// ─────────────────────────────────────────────────────────────────────────

    async createTicket(
    dto: CreateTicketDto,
    ctx: { customerId: string; botId: string; idempotencyKey: string; customerName?: string },
    files: Express.Multer.File[] = [],
  ) {
    const { customerId, botId } = ctx;

    this.logger.info('[TICKET][CREATE-L1] Starting', { customerId, l1: dto.l1CategoryCode });

    // ── Idempotent replay ───────────────────────────────────────────────────
    // The gateway enforces X-Idempotency-Key on this route and idempotencyKey is
    // UNIQUE on ticket. Returning the ticket the first attempt created makes a
    // client retry a success, instead of failing the duplicate check (or, when
    // duplicateOverride is set, tripping the unique constraint). Runs before the
    // ceiling and duplicate checks so a retry is never rejected by them.
    if (ctx.idempotencyKey) {
      const replay = await this.prisma.ticket.findUnique({
        where: { idempotencyKey: ctx.idempotencyKey },
        include: { attachments: true },
      });
      if (replay) {
        this.logger.info('[TICKET][CREATE-L1] Idempotent replay — returning existing ticket', {
          customerId,
          ticketId: replay.ticketId,
        });
        // Same shape as a fresh create, so a retry is indistinguishable to the caller.
        return ApiResponse.success(
          { ...replay, attachmentsFailed: false },
          'Ticket created (Layer 2)',
        );
      }
    }

    // Validate attachments before touching the database: a rejected file should
    // not leave a ticket behind, and an upload must never run inside the
    // transaction below.
    if (files.length > MAX_ATTACHMENTS_PER_TICKET) {
      this.logger.warn('[TICKET][CREATE-L1] Rejected — too many attachments', { count: files.length });
      throw new BoltpeException(ErrorCode.VALIDATION_ERROR);
    }
    this.assertFilesValid(files);

    // Tickets are raised against an L1 category only — the L2 level exists for
    // the chatbot's intent classification, not for the Write-to-us form.
    const l1 = await this.prisma.issueCategoryL1.findUnique({
      where: { code: dto.l1CategoryCode },
    });
    if (!l1?.isActive) {
      this.logger.warn('[TICKET][CREATE-L1] Category not found or retired', {
        l1CategoryCode: dto.l1CategoryCode,
      });
      throw new BoltpeException(ErrorCode.RESOURCE_NOT_FOUND);
    }

        // ── Open ticket ceiling ─────────────────────────────────────────────────
    const openCount = await this.prisma.ticket.count({
      where: { customerId, botId, status: { in: OPEN_STATUSES as any } },
    });
    if (openCount >= MAX_OPEN_TICKETS) {
      this.logger.warn('[TICKET][CREATE-L6] Open ticket ceiling reached', { customerId, openCount });
      throw new BoltpeException(ErrorCode.VALIDATION_ERROR); // TEMP — swap once TICKET_XXX codes exist
    }

    // ── Duplicate check (skipped if client already confirmed override) ─────
    if (!dto.duplicateOverride) {
      const since = new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 60 * 60 * 1000);
      const duplicate = await this.prisma.ticket.findFirst({
        where: {
          customerId,
          botId,
          l1CategoryCode: dto.l1CategoryCode,
          status: { in: OPEN_STATUSES as any },
          createdAt: { gte: since },
        },
      });
      if (duplicate) {
        this.logger.warn('[TICKET][CREATE-L6] Duplicate open ticket detected', {
          customerId,
          existingTicketId: duplicate.ticketId,
        });
        throw new BoltpeException(ErrorCode.DUPLICATE_TRANSACTION); // TEMP — swap to DUPLICATE_TICKET once TICKET_XXX codes exist
      }
    }

    // Need the bot's short botCode (e.g. "BOLTPE") for the ticket ID — botId is the UUID, not the code.

    const bot = await this.prisma.botConfiguration.findUnique({
      where: { id: botId },
      select: { botCode: true },
    });
    const botCode = bot?.botCode ?? 'BOLTPE';

    const wordCount = dto.description.trim().split(/\s+/).filter(Boolean).length;
    const category = l1CodeToTicketCategory(l1.code);
    const ticketId = generateTicketId(botCode, category);
    const idempotencyKey = ctx.idempotencyKey ?? crypto.randomUUID(); // prefer the real client key now that the gateway enforces X-Idempotency-Key on this route

        const slaBand = SLA_BANDS[l1.defaultPriority] ?? SLA_BANDS[3];
    const now = new Date();

    // The id is generated up front so attachments can be uploaded against it
    // before the transaction opens.
    const internalTicketId = crypto.randomUUID();

    // Upload first, deliberately. The PRD treats a ticket and its attachment as
    // one unit: if the upload fails the customer is asked to retry and no
    // ticket is left behind. The external call stays outside the transaction so
    // it never holds a database connection open.
    const attachmentRows = files.length
      ? await this.uploadFiles(files, internalTicketId).catch((error) => {
          this.logger.error(
            '[TICKET][CREATE-L1] Attachment upload failed — no ticket created',
            error as Error,
            { customerId, count: files.length },
          );
          throw new BoltpeException(ErrorCode.EXTERNAL_SERVICE_ERROR);
        })
      : [];

        const createTicketTransaction = () => this.prisma.$transaction(async (tx) => {
      const newTicket = await tx.ticket.create({
        data: {
          id: internalTicketId,
          ticketId,
          botId,
          customerId,
          creationSource: 'USER',
          priorityLevel: l1.defaultPriority,
          l1CategoryCode: l1.code,
          routingSkill: l1.routingSkill ?? DEFAULT_ROUTING_SKILL,
          description: dto.description,
          wordCount,
          contactEmailOverride: dto.contactEmailOverride,
          contactMobileOverride: dto.contactMobileOverride,
          idempotencyKey,
        },
      });

      await tx.ticketSlaTimer.create({
        data: {
          ticketId: newTicket.id,
          priorityLevel: l1.defaultPriority,
          targetFirstResponseSeconds: slaBand.firstResponseSec,
          targetResolutionSeconds: slaBand.resolutionSec,
          timerStartedAt: now,
          slaApplicable: true,
          neverAutoResolve: l1.neverAutoResolve,
        },
      });

      await tx.ticketMessage.create({
        data: {
          ticketId: newTicket.id,
          senderType: 'CUSTOMER',
          senderId: customerId,
          content: dto.description,
        },
      });

      if (attachmentRows.length) {
        await tx.ticketAttachment.createMany({
          data: attachmentRows.map((row) => ({ ticketId: newTicket.id, ...row })),
        });
      }

      // Opening entry, so the timeline the customer sees starts at "raised"
      // rather than at the first agent action.
      await tx.ticketHistory.create({
        data: {
          ticketId: newTicket.id,
          oldStatus: null,
          newStatus: 'OPEN',
          changedBy: customerId,
        },
      });

      return newTicket;
    });

    let ticket;
    try {
      ticket = await createTicketTransaction();
    } catch (error) {
      // A concurrent retry carrying the same key won the race and already
      // inserted the row. Return that ticket; anything else is re-thrown.
      if (ctx.idempotencyKey && (error as { code?: string })?.code === 'P2002') {
        const winner = await this.prisma.ticket.findUnique({
          where: { idempotencyKey: ctx.idempotencyKey },
          include: { attachments: true },
        });
        if (winner) {
          this.logger.info('[TICKET][CREATE-L1] Idempotency race — returning existing ticket', {
            customerId,
            ticketId: winner.ticketId,
          });
          return ApiResponse.success(
            { ...winner, attachmentsFailed: false },
            'Ticket created (Layer 2)',
          );
        }
      }
      throw error;
    }

    // Attachments were uploaded before the transaction and written inside it,
    // so by this point they are committed with the ticket.
    const attachments = await this.prisma.ticketAttachment.findMany({
      where: { ticketId: ticket.id },
    });

    // Fire-and-forget. queueTicketCreated already swallows its own failures,
    // but the ticket must not depend on that promise: a notification is never
    // worth failing a ticket the customer has already successfully raised.
    try {
      await this.notifications.queueTicketCreated({
        ticketId: ticket.ticketId,
        customerEmail: dto.contactEmailOverride ?? '',
        // Contact details go to the internal support inbox only — the
        // customer-facing template is sent separately and carries none.
        customerName: ctx.customerName ?? '',
        customerMobile: dto.contactMobileOverride ?? '',
        categoryName: l1.displayName,
        routingSkill: l1.routingSkill ?? DEFAULT_ROUTING_SKILL,
        priorityLevel: l1.defaultPriority,
        firstResponseHours: formatDuration(slaBand.firstResponseSec),
        resolutionHours: formatDuration(slaBand.resolutionSec),
      });
    } catch (error) {
      this.logger.error(
        '[TICKET][CREATE-L1] Notification could not be queued — ticket is unaffected',
        error as Error,
        { ticketId: ticket.ticketId },
      );
    }

    this.logger.info('[TICKET][CREATE-L2] Success', {
      ticketId: ticket.ticketId,
      attachments: attachments.length,
    });
    // attachmentsFailed is always false now: a failed upload aborts before the
    // ticket exists. Kept on the response so existing clients do not break.
    return ApiResponse.success(
      { ...ticket, attachments, attachmentsFailed: false },
      'Ticket created (Layer 2)',
    );
    
  }

    // ─────────────────────────────────────────────────────────────────────────
  // GET /tickets — My Tickets list
  // ─────────────────────────────────────────────────────────────────────────
  async getMyTickets(customerId: string, botId: string, filters: GetMyTicketsDto = {}) {
    const { status, l1CategoryCode, l2SubCategoryCode, page = 1, limit = 20 } = filters;

    this.logger.info('[TICKET][LIST] Fetching', { customerId, botId, page, limit });

    // Ownership is always enforced; the rest are optional narrowing filters.
    const where: any = { customerId, botId };
    if (status) where.status = status;
    if (l1CategoryCode) where.l1CategoryCode = l1CategoryCode;
    if (l2SubCategoryCode) where.l2SubCategoryCode = l2SubCategoryCode;

    const [tickets, total] = await this.prisma.$transaction([
      this.prisma.ticket.findMany({
        where,
        select: {
          ticketId: true,
          status: true,
          l1CategoryCode: true,
          l2SubCategoryCode: true,
          priorityLevel: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    this.logger.info('[TICKET][LIST] Success', { customerId, count: tickets.length, total });
    return ApiResponse.success(
      { tickets, pagination: { page, limit, total, hasMore: page * limit < total } },
      'Tickets fetched',
    );
  }

    // ─────────────────────────────────────────────────────────────────────────
  // GET /tickets/:ticketId — Full detail + conversation thread
  // ─────────────────────────────────────────────────────────────────────────
  async getTicketDetail(ticketId: string, customerId: string) {
    this.logger.info('[TICKET][DETAIL] Fetching', { ticketId, customerId });

    const ticket = await this.prisma.ticket.findFirst({
      where: { ticketId, customerId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        slaTimer: true,
        attachments: true,
        // internalNote is deliberately not selected — it is admin-only and
        // must never reach a customer-facing response.
        history: {
          orderBy: { changedAt: 'asc' },
          select: {
            oldStatus: true,
            newStatus: true,
            remark: true,
            changedAt: true,
          },
        },
      },
    });

    if (!ticket) {
      this.logger.warn('[TICKET][DETAIL] Not found or not owned by requester', { ticketId, customerId });
      throw new BoltpeException(ErrorCode.RESOURCE_NOT_FOUND); // TEMP — swap to TICKET_NOT_FOUND once TICKET_XXX codes exist
    }

    const maskedTicket = {
      ...ticket,
      contactEmailOverride: ticket.contactEmailOverride ? maskEmail(ticket.contactEmailOverride) : null,
      contactMobileOverride: ticket.contactMobileOverride ? maskMobile(ticket.contactMobileOverride) : null,
    };

    this.logger.info('[TICKET][DETAIL] Success', { ticketId, messageCount: ticket.messages.length });
    return ApiResponse.success(maskedTicket, 'Ticket fetched');
  }
  async addAttachments(ticketId: string, files: Express.Multer.File[], customerId: string) {
    this.logger.info('[TICKET][ATTACHMENT] Adding', { ticketId, customerId, count: files?.length });

    if (!files || files.length === 0) {
      throw new BoltpeException(ErrorCode.MISSING_REQUIRED_FIELD);
    }

    const ticket = await this.prisma.ticket.findFirst({
      where: { ticketId, customerId },
    });
    if (!ticket) {
      this.logger.warn('[TICKET][ATTACHMENT] Not found or not owned by requester', { ticketId, customerId });
      throw new BoltpeException(ErrorCode.RESOURCE_NOT_FOUND); // TEMP — swap to TICKET_NOT_FOUND
    }

    const existingCount = await this.prisma.ticketAttachment.count({
      where: { ticketId: ticket.id, isDeleted: false },
    });
    if (existingCount + files.length > MAX_ATTACHMENTS_PER_TICKET) {
      this.logger.warn('[TICKET][ATTACHMENT] Rejected — would exceed max attachments', {
        ticketId, existingCount, incoming: files.length,
      });
      throw new BoltpeException(ErrorCode.VALIDATION_ERROR); // TEMP — swap once TICKET_XXX codes exist
    }

    this.assertFilesValid(files);
    const attachments = await this.storeAttachments(files, ticket.id);

    this.logger.info('[TICKET][ATTACHMENT] Success', { ticketId, count: attachments.length });
    return ApiResponse.success(attachments, 'Attachments added');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /tickets/:ticketId/withdraw
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Lets a customer withdraw their own ticket — "never mind, sorted it".
   *
   * Terminal: WITHDRAWN has no onward transitions and reopen only accepts
   * RESOLVED or CLOSED, so a withdrawn ticket stays withdrawn. The customer
   * raises a new ticket if the issue comes back.
   *
   * No notification is sent: the customer performed this themselves, and
   * emailing them about their own action is noise.
   */
  async withdrawTicket(ticketId: string, customerId: string, dto: WithdrawTicketDto) {
    this.logger.info('[TICKET][WITHDRAW] Attempting', { ticketId, customerId });

    const ticket = await this.prisma.ticket.findFirst({ where: { ticketId, customerId } });
    if (!ticket) {
      this.logger.warn('[TICKET][WITHDRAW] Not found or not owned by requester', {
        ticketId,
        customerId,
      });
      throw new BoltpeException(ErrorCode.RESOURCE_NOT_FOUND);
    }

    // Same rules the agent side obeys: an already-resolved, closed or
    // withdrawn ticket cannot be withdrawn.
    if (!isTransitionAllowed(ticket.status, 'WITHDRAWN')) {
      this.logger.warn('[TICKET][WITHDRAW] Rejected — not in a withdrawable state', {
        ticketId,
        status: ticket.status,
      });
      throw new BoltpeException(ErrorCode.VALIDATION_ERROR);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.ticket.update({
        where: { ticketId },
        data: {
          status: 'WITHDRAWN',
          withdrawnAt: new Date(),
          withdrawalReason: dto.reason ?? null,
        },
      });

      await tx.ticketHistory.create({
        data: {
          ticketId: ticket.id,
          oldStatus: ticket.status,
          newStatus: 'WITHDRAWN',
          remark: dto.reason ?? null,
          changedBy: customerId,
        },
      });

      return result;
    });

    this.logger.info('[TICKET][WITHDRAW] Success', { ticketId, from: ticket.status });
    return ApiResponse.success(updated, 'Ticket withdrawn');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Attachment helpers — shared by createTicket and addAttachments
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Validates every file before any upload starts, so a bad file in the batch
   * cannot leave earlier files orphaned in S3.
   */
  private assertFilesValid(files: Express.Multer.File[]) {
    for (const file of files) {
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        this.logger.warn('[TICKET][ATTACHMENT] Rejected — invalid file type', { mimetype: file.mimetype });
        throw new BoltpeException(ErrorCode.INVALID_INPUT);
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        this.logger.warn('[TICKET][ATTACHMENT] Rejected — file too large', { size: file.size });
        throw new BoltpeException(ErrorCode.INVALID_INPUT);
      }
    }
  }

  /** Uploads each validated file and records it against the ticket. */
  private async storeAttachments(
    files: Express.Multer.File[],
    internalTicketId: string,
  ): Promise<TicketAttachment[]> {
    const uploaded = await this.uploadFiles(files, internalTicketId);
    const attachments: TicketAttachment[] = [];
    for (const row of uploaded) {
      attachments.push(
        await this.prisma.ticketAttachment.create({
          data: { ticketId: internalTicketId, ...row },
        }),
      );
    }
    return attachments;
  }

  /**
   * Uploads to S3 and returns the rows to persist — no database writes.
   *
   * Separated so ticket creation can upload *before* opening its transaction:
   * the PRD treats a ticket and its attachment as one unit, so a failed upload
   * must leave no ticket behind. The cost is a possible orphaned S3 object if
   * the transaction then fails, which is cheaper than an orphaned ticket.
   */
  private async uploadFiles(files: Express.Multer.File[], internalTicketId: string) {
    const rows: Array<{
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
    }> = [];
    for (const file of files) {
      const { url: storageKey } = await S3UploadUtil.uploadTicketAttachment(file, internalTicketId);
      rows.push({
        fileName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageKey,
      });
    }
    return rows;
  }
}

