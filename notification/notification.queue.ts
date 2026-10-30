import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  QueueService,
  AppLogger,
  EmailTemplateType,
  EMAIL_TEMPLATES,
} from '@boltpe/shared';
import * as nodemailer from 'nodemailer';

const QUEUE_NAME = 'support-notifications';

/**
 * Payload for the "ticket raised" notification.
 *
 * `customerEmail` is personal data. It is carried here because the mail has to
 * reach the customer, and is never written to a log line — see the logging in
 * this file, which only ever records the ticketId.
 */
export interface TicketCreatedJob {
  ticketId: string;
  /** Empty when the ticket carries no contact email — that channel is skipped. */
  customerEmail: string;
  /** Customer contact details. Internal alert only — never sent to the customer. */
  customerName: string;
  customerMobile: string;
  categoryName: string;
  routingSkill: string;
  priorityLevel: number;
  firstResponseHours: string;
  resolutionHours: string;
}

/**
 * Payload for a status-change notification.
 *
 * `customerEmail` is personal data, carried for delivery only and never logged.
 * `remark` is the agent's user-facing note; internal notes must never be put here.
 */
export interface TicketStatusChangedJob {
  ticketId: string;
  customerEmail: string;
  statusLabel: string;
  statusMessage: string;
  remark?: string;
}

@Injectable()
export class NotificationQueue implements OnModuleInit, OnModuleDestroy {
  private readonly queueService: QueueService;
  private readonly mailer: nodemailer.Transporter;
  private readonly logger = new AppLogger(
    'support-notification-queue',
    process.env.NODE_ENV || 'development',
  );

  constructor(private readonly configService: ConfigService) {
    this.queueService = new QueueService({
      redis: {
        host: this.configService.get<string>('redis.host') || 'localhost',
        port: Number(this.configService.get<number>('redis.port') ?? 6379),
        password: this.configService.get<string>('redis.password') || undefined,
      },
    });

    const smtpUser = this.configService.get<string>('smtp.user');
    this.mailer = nodemailer.createTransport({
      host: this.configService.get<string>('smtp.host'),
      port: this.configService.get<number>('smtp.port'),
      secure: this.configService.get<boolean>('smtp.secure'),
      // Only authenticate when a user is configured. Passing an auth block with
      // no user makes nodemailer attempt PLAIN and fail with
      // 'Missing credentials for "PLAIN"', which blocks local mail catchers
      // such as Mailpit that accept unauthenticated connections.
      ...(smtpUser
        ? { auth: { user: smtpUser, pass: this.configService.get<string>('smtp.pass') } }
        : {}),
    });
  }

  onModuleInit() {
    this.logger.info('Initializing support notification worker');
    this.createWorker();
  }

  async onModuleDestroy() {
    await this.queueService.close();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Queues the customer confirmation and the internal alert for a new ticket.
   *
   * Never throws. A notification is not worth failing a ticket over, so a queue
   * outage is logged and swallowed here rather than propagating to the caller.
   */
  async queueTicketCreated(data: TicketCreatedJob): Promise<void> {
    try {
      await this.queueService.addJob(QUEUE_NAME, 'ticket-created', data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
      this.logger.info('Queued ticket-created notification', { ticketId: data.ticketId });
    } catch (error) {
      this.logger.error(
        'Could not queue ticket-created notification — ticket is unaffected',
        error as Error,
        { ticketId: data.ticketId },
      );
    }
  }

  /**
   * Queues the customer notification for a status change.
   *
   * Never throws, for the same reason as queueTicketCreated: an agent's status
   * update must not fail because a notification could not be queued.
   */
  async queueStatusChanged(data: TicketStatusChangedJob): Promise<void> {
    try {
      await this.queueService.addJob(QUEUE_NAME, 'status-changed', data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
      this.logger.info('Queued status-changed notification', {
        ticketId: data.ticketId,
        status: data.statusLabel,
      });
    } catch (error) {
      this.logger.error(
        'Could not queue status-changed notification — the ticket update is unaffected',
        error as Error,
        { ticketId: data.ticketId },
      );
    }
  }

  // ─── Worker ───────────────────────────────────────────────────────────────

  private createWorker() {
    this.queueService.createWorker(
      QUEUE_NAME,
      async (job: any) => {
        if (job.name === 'ticket-created') {
          await this.sendTicketCreated(job.data as TicketCreatedJob);
        } else if (job.name === 'status-changed') {
          await this.sendStatusChanged(job.data as TicketStatusChangedJob);
        }
      },
      5,
    );
  }

  /**
   * Ticket emails are operational notices, so they go out as plain text where
   * the template provides it. The HTML body is kept as a fallback for
   * templates that have not been given a text version.
   */
  private body(tpl: { generateHtml: (...a: any[]) => string; generateText?: (...a: any[]) => string }, ...args: any[]) {
    return tpl.generateText
      ? { text: tpl.generateText(...args) }
      : { html: tpl.generateHtml(...args) };
  }

  private async sendTicketCreated(data: TicketCreatedJob): Promise<void> {
    // Falls back to a no-reply address so an unauthenticated SMTP server
    // (a local mail catcher) still gets a valid From header.
    const fromAddress =
      this.configService.get<string>('smtp.from') ||
      this.configService.get<string>('smtp.user') ||
      'no-reply@boltpe.money';
    const from = `"BoltPe Support" <${fromAddress}>`;

    // 1. Confirmation to the customer — skipped when the ticket carries no
    //    email address. The PRD: skip the channel that is unavailable, rather
    //    than failing or blocking anything.
    if (!data.customerEmail) {
      this.logger.info('No contact email on the ticket — skipping the customer confirmation', {
        ticketId: data.ticketId,
      });
    } else {
    const customerTpl = EMAIL_TEMPLATES[EmailTemplateType.TICKET_CREATED_CUSTOMER];
    await this.mailer.sendMail({
      from,
      to: data.customerEmail,
      subject: customerTpl.subject,
      ...this.body(customerTpl, data.ticketId, data.categoryName, data.firstResponseHours),
    });
    this.logger.info('Sent ticket confirmation to customer', { ticketId: data.ticketId });
    }

    // 2. Alert to the internal support inbox. Skipped when unconfigured so a
    //    missing SUPPORT_EMAIL cannot fail the customer mail above.
    const supportEmail = this.configService.get<string>('smtp.supportEmail');
    if (!supportEmail) {
      this.logger.warn('SUPPORT_EMAIL is not configured — skipping the internal alert', {
        ticketId: data.ticketId,
      });
      return;
    }

    const adminTpl = EMAIL_TEMPLATES[EmailTemplateType.TICKET_CREATED_ADMIN];

    // "<User Name> has raised a ticket", per the PRD. Falls back to the generic
    // subject when the JWT carried no name.
    const adminSubject = data.customerName
      ? `${data.customerName} has raised a ticket — ${data.ticketId}`
      : `${adminTpl.subject} — ${data.ticketId}`;

    // Empty when ADMIN_PANEL_URL is unset — the template then omits the link
    // rather than rendering a broken one.
    const adminPanelUrl = this.configService.get<string>('ticket.adminPanelUrl') || '';
    const ticketUrl = adminPanelUrl
      ? `${adminPanelUrl.replace(/\/+$/, '')}/tickets/${data.ticketId}`
      : '';

    await this.mailer.sendMail({
      from,
      to: supportEmail,
      subject: adminSubject,
      ...this.body(
        adminTpl,
        data.ticketId,
        data.customerName || 'A customer',
        data.customerMobile || 'not provided',
        data.customerEmail,
        data.categoryName,
        data.routingSkill,
        String(data.priorityLevel),
        data.resolutionHours,
        ticketUrl,
      ),
    });
    this.logger.info('Sent new-ticket alert to support inbox', { ticketId: data.ticketId });
  }

  private async sendStatusChanged(data: TicketStatusChangedJob): Promise<void> {
    const fromAddress =
      this.configService.get<string>('smtp.from') ||
      this.configService.get<string>('smtp.user') ||
      'no-reply@boltpe.money';
    const tpl = EMAIL_TEMPLATES[EmailTemplateType.TICKET_STATUS_CHANGED];

    await this.mailer.sendMail({
      from: `"BoltPe Support" <${fromAddress}>`,
      to: data.customerEmail,
      subject: `${tpl.subject} — ${data.ticketId}`,
      ...this.body(tpl, data.ticketId, data.statusLabel, data.statusMessage, data.remark),
    });
    this.logger.info('Sent status-change email to customer', {
      ticketId: data.ticketId,
      status: data.statusLabel,
    });
  }
}
