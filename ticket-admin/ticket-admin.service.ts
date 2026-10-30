import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { ApiResponse, AppLogger, ErrorCode, BoltpeException } from '@boltpe/shared';
import { AssignTicketDto, GetAllTicketsDto, UpdateTicketStatusDto } from './dto/ticket-admin.dto';
import { NotificationQueue } from '../notification/notification.queue';
import { STATUS_NOTIFICATIONS } from './status-messages';
import { ALLOWED_TRANSITIONS, isTransitionAllowed } from './status-transitions';

/**
 * Pushes a date to the last millisecond of its day, so an inclusive toDate
 * filter covers tickets raised during that day rather than only at midnight.
 * A value that already carries a time is left alone.
 */
function endOfDay(value: string): Date {
  const date = new Date(value);
  if (!value.includes('T')) date.setHours(23, 59, 59, 999);
  return date;
}

@Injectable()
export class TicketAdminService {
  private readonly logger = new AppLogger('ticket-admin-service', process.env.NODE_ENV || 'development');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationQueue,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // GET /ticket-admin/all — agent/admin, filterable, paginated
  // ─────────────────────────────────────────────────────────────────────────
  async getAllTickets(filters: GetAllTicketsDto) {
    const {
      status,
      l1CategoryCode,
      l2SubCategoryCode,
      assignedAgentId,
      search,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
    } = filters;

    this.logger.info('[TICKET-ADMIN][ALL] Fetching', { filters });

    const where: any = {};
    if (status) where.status = status;
    if (l1CategoryCode) where.l1CategoryCode = l1CategoryCode;
    if (l2SubCategoryCode) where.l2SubCategoryCode = l2SubCategoryCode;
    if (assignedAgentId) where.assignedAgentId = assignedAgentId;

    // One box, three fields — an agent pastes whatever the customer gave them
    // (a ticket number, a phone number, an email) without choosing a field.
    if (search) {
      where.OR = [
        { ticketId: { contains: search, mode: 'insensitive' } },
        { contactMobileOverride: { contains: search } },
        { contactEmailOverride: { contains: search, mode: 'insensitive' } },
      ];
    }

    // toDate is inclusive of the whole day: a plain date means "up to the end
    // of that day", not midnight at its start.
    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) where.createdAt.gte = new Date(fromDate);
      if (toDate) where.createdAt.lte = endOfDay(toDate);
    }

    const [tickets, total] = await this.prisma.$transaction([
      this.prisma.ticket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    this.logger.info('[TICKET-ADMIN][ALL] Success', { count: tickets.length, total });
    return ApiResponse.success(
      { tickets, pagination: { page, limit, total, hasMore: page * limit < total } },
      'Tickets fetched',
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /ticket-admin/:ticketId/status — agent/admin
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * One ticket, for the support console.
   *
   * Three things this deliberately does that the customer endpoint does not:
   *  - no owner filter, so an agent can open any ticket by id
   *  - contact details are returned unmasked, because contacting the customer
   *    is the job (the customer-facing endpoint masks them)
   *  - history includes internalNote and changedBy — the admin-only audit trail
   *
   * allowedNextStatuses is included so the console can offer only legal moves,
   * which is what the PRD asks the status dropdown to do.
   */
  async getTicketById(ticketId: string) {
    this.logger.info('[TICKET-ADMIN][DETAIL] Fetching', { ticketId });

    const ticket = await this.prisma.ticket.findUnique({
      where: { ticketId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        attachments: true,
        slaTimer: true,
        history: { orderBy: { changedAt: 'asc' } },
      },
    });

    if (!ticket) {
      this.logger.warn('[TICKET-ADMIN][DETAIL] Not found', { ticketId });
      throw new BoltpeException(ErrorCode.RESOURCE_NOT_FOUND);
    }

    this.logger.info('[TICKET-ADMIN][DETAIL] Success', {
      ticketId,
      historyEntries: ticket.history.length,
    });

    return ApiResponse.success(
      { ...ticket, allowedNextStatuses: ALLOWED_TRANSITIONS[ticket.status] ?? [] },
      'Ticket fetched',
    );
  }

  async updateTicketStatus(ticketId: string, dto: UpdateTicketStatusDto, changedBy: string) {
    this.logger.info('[TICKET-ADMIN][STATUS] Updating', { ticketId, newStatus: dto.status });

    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId } });
    if (!ticket) {
      this.logger.warn('[TICKET-ADMIN][STATUS] Not found', { ticketId });
      throw new BoltpeException(ErrorCode.RESOURCE_NOT_FOUND); // TEMP — swap to TICKET_NOT_FOUND once TICKET_XXX codes exist
    }

    // Reject illegal moves before touching anything — an agent must not be able
    // to send a ticket back to OPEN, skip the queue, or revive a closed ticket.
    if (!isTransitionAllowed(ticket.status, dto.status)) {
      this.logger.warn('[TICKET-ADMIN][STATUS] Rejected — illegal transition', {
        ticketId,
        from: ticket.status,
        to: dto.status,
      });
      throw new BoltpeException(
        ErrorCode.VALIDATION_ERROR,
        { from: ticket.status, to: dto.status, allowed: ALLOWED_TRANSITIONS[ticket.status] },
      );
    }

    const now = new Date();
    const isResolving = dto.status === 'RESOLVED';
    const isClosing = dto.status === 'CLOSED';

    // One transaction: the ticket and its audit entry move together, so a
    // status can never change without leaving a record of who changed it.
    const updated = await this.prisma.$transaction(async (tx) => {
      // Optimistic concurrency. When the console tells us which version it was
      // looking at, the write only lands if nothing has changed since — so the
      // second of two agents is told to refresh instead of silently
      // overwriting the first. Omitting the field keeps the old behaviour.
      if (dto.expectedUpdatedAt) {
        const { count } = await tx.ticket.updateMany({
          where: { ticketId, updatedAt: new Date(dto.expectedUpdatedAt) },
          data: { status: dto.status },
        });
        if (count === 0) {
          this.logger.warn('[TICKET-ADMIN][STATUS] Rejected — ticket changed since it was read', {
            ticketId,
            expectedUpdatedAt: dto.expectedUpdatedAt,
          });
          throw new BoltpeException(
            ErrorCode.DUPLICATE_TRANSACTION,
            { ticketId },
            'Ticket updated by another user, refresh.',
          );
        }
      }

      const result = await tx.ticket.update({
        where: { ticketId },
        data: {
          status: dto.status,
          dispositionCode: dto.dispositionCode,
          resolutionSummary: dto.resolutionSummary,
          resolvedAt: isResolving ? now : ticket.resolvedAt,
          closedAt: isClosing ? now : ticket.closedAt,
        },
      });

      await tx.ticketHistory.create({
        data: {
          ticketId: ticket.id,
          oldStatus: ticket.status,
          newStatus: dto.status,
          remark: dto.resolutionSummary ?? null,
          internalNote: dto.internalNote ?? null,
          changedBy,
        },
      });

      return result;
    });

    await this.notifyStatusChange(updated, dto.resolutionSummary);

    this.logger.info('[TICKET-ADMIN][STATUS] Success', { ticketId, from: ticket.status, to: dto.status });
    return ApiResponse.success(updated, 'Ticket status updated');
  }


  /**
   * Assigns a ticket to a staff member, or returns it to the pool with null.
   *
   * Assignment is not a status change — the ticket keeps its place in the
   * lifecycle — so it writes no ticket_history row. It is also not
   * communicated to the customer: who is handling it internally is not their
   * concern, and an email per reassignment would be noise.
   */
  async assignTicket(ticketId: string, dto: AssignTicketDto, changedBy: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId } });
    if (!ticket) {
      this.logger.warn('[TICKET-ADMIN][ASSIGN] Not found', { ticketId });
      throw new BoltpeException(ErrorCode.RESOURCE_NOT_FOUND);
    }

    const updated = await this.prisma.ticket.update({
      where: { ticketId },
      data: {
        assignedAgentId: dto.agentId,
        assignedAt: dto.agentId ? new Date() : null,
      },
    });

    this.logger.info('[TICKET-ADMIN][ASSIGN] Success', {
      ticketId,
      from: ticket.assignedAgentId,
      to: dto.agentId,
      changedBy,
    });
    return ApiResponse.success(
      updated,
      dto.agentId ? 'Ticket assigned' : 'Ticket unassigned',
    );
  }

  /**
   * Emails the customer about a status change.
   *
   * Silent when the status has no customer-facing wording, or when the ticket
   * carries no contact email. Never throws: a notification must not fail an
   * agent's status update.
   */
  private async notifyStatusChange(ticket: any, remark?: string | null) {
    const copy = STATUS_NOTIFICATIONS[ticket.status as keyof typeof STATUS_NOTIFICATIONS];
    if (!copy || !ticket.contactEmailOverride) {
      return;
    }
    try {
      await this.notifications.queueStatusChanged({
        ticketId: ticket.ticketId,
        customerEmail: ticket.contactEmailOverride,
        statusLabel: copy.label,
        statusMessage: copy.message,
        remark: remark ?? undefined,
      });
    } catch (error) {
      this.logger.error(
        '[TICKET-ADMIN] Status notification could not be queued — the update is unaffected',
        error as Error,
        { ticketId: ticket.ticketId },
      );
    }
  }
}
