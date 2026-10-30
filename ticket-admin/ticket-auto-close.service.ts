import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma.service';
import { AppLogger } from '@boltpe/shared';
import { NotificationQueue } from '../notification/notification.queue';
import { STATUS_NOTIFICATIONS } from './status-messages';

/** Days a ticket may sit in RESOLVED before the system closes it. */
const DEFAULT_AUTO_CLOSE_DAYS = 7;

/** Caps one run so a long backlog cannot hold the database or the queue. */
const BATCH_LIMIT = 200;

/**
 * Closes tickets the customer never came back on.
 *
 * The PRD: "Auto-close X days after Resolved if not reopened." Reopening moves
 * the ticket to REOPENED, so it simply stops matching the query — there is no
 * separate "was it reopened" check to get wrong.
 *
 * RESOLVED → CLOSED is the same transition an agent would make, so this does
 * not bypass the lifecycle rules.
 */
@Injectable()
export class TicketAutoCloseService {
  private readonly logger = new AppLogger(
    'ticket-auto-close',
    process.env.NODE_ENV || 'development',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly notifications: NotificationQueue,
  ) {}

  private get autoCloseDays(): number {
    const configured = Number(this.configService.get('ticket.autoCloseDays'));
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_AUTO_CLOSE_DAYS;
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'ticket-auto-close' })
  async closeStaleResolvedTickets(): Promise<number> {
    const days = this.autoCloseDays;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const due = await this.prisma.ticket.findMany({
      where: { status: 'RESOLVED', resolvedAt: { lte: cutoff } },
      take: BATCH_LIMIT,
      select: { id: true, ticketId: true, contactEmailOverride: true, resolutionSummary: true },
    });

    if (!due.length) return 0;

    this.logger.info('[TICKET][AUTO-CLOSE] Closing resolved tickets', {
      count: due.length,
      olderThanDays: days,
    });

    let closed = 0;
    for (const ticket of due) {
      try {
        await this.closeOne(ticket.id, ticket.ticketId);
        closed += 1;
        await this.notify(ticket.ticketId, ticket.contactEmailOverride, ticket.resolutionSummary);
      } catch (error) {
        // One bad ticket must not stop the batch — the rest still close.
        this.logger.error(
          '[TICKET][AUTO-CLOSE] Failed to close ticket',
          error as Error,
          { ticketId: ticket.ticketId },
        );
      }
    }

    this.logger.info('[TICKET][AUTO-CLOSE] Done', { closed, attempted: due.length });
    return closed;
  }

  /** Ticket and audit entry move together, exactly as on the agent path. */
  private async closeOne(internalId: string, ticketId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: internalId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });

      await tx.ticketHistory.create({
        data: {
          ticketId: internalId,
          oldStatus: 'RESOLVED',
          newStatus: 'CLOSED',
          remark: `Automatically closed after ${this.autoCloseDays} days without a reopen.`,
          changedBy: 'SYSTEM',
        },
      });
    });

    this.logger.info('[TICKET][AUTO-CLOSE] Closed', { ticketId });
  }

  /** Fire-and-forget, like every other ticket notification. */
  private async notify(ticketId: string, email: string | null, remark: string | null) {
    if (!email) return;
    const template = STATUS_NOTIFICATIONS['CLOSED'];
    if (!template) return;

    try {
      await this.notifications.queueStatusChanged({
        ticketId,
        customerEmail: email,
        statusLabel: template.label,
        statusMessage: template.message,
        remark: remark ?? undefined,
      });
    } catch (error) {
      this.logger.error(
        '[TICKET][AUTO-CLOSE] Notification could not be queued — ticket is still closed',
        error as Error,
        { ticketId },
      );
    }
  }
}
