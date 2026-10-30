import { TicketStatus } from '@prisma/client';

/**
 * Customer-facing wording for each ticket status.
 *
 * Statuses absent from this map do not notify the customer: WITHDRAWN and
 * DUPLICATE_LINKED are internal bookkeeping, and OPEN is covered by the
 * ticket-created email rather than a status change.
 */
export const STATUS_NOTIFICATIONS: Partial<
  Record<TicketStatus, { label: string; message: string }>
> = {
  IN_PROGRESS: {
    label: 'In progress',
    message: 'Our support team has picked up your request and is working on it.',
  },
  PENDING_USER: {
    label: 'Waiting for your response',
    message:
      'We need some more information from you before we can continue. Please reply to this ticket in the app.',
  },
  PENDING_PARTNER: {
    label: 'On hold',
    message:
      'We are waiting on a response from a partner before we can take this further. We will update you as soon as we hear back.',
  },
  RESOLVED: {
    label: 'Resolved',
    message: 'We believe this issue is now resolved. If it happens again, you can reopen this ticket.',
  },
  CLOSED: {
    label: 'Closed',
    message: 'This ticket has been closed. Raise a new ticket if you need further help.',
  },
  REOPENED: {
    label: 'Reopened',
    message: 'This ticket has been reopened and is back with our support team.',
  },
};
