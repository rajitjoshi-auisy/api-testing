import { TicketStatus } from '@prisma/client';

/**
 * Which statuses an agent may move a ticket to, from its current status.
 *
 * Mirrors the lifecycle in the Help & Support one-pager:
 *   Open → In Progress → On Hold ⇄ In Progress → Resolved → Closed
 *
 * Two deliberate deviations from that wording:
 *  - "On Hold" is split into PENDING_USER and PENDING_PARTNER, so the queue
 *    shows who is actually blocking.
 *  - CLOSED has no targets here. Reopening is a separate, customer-facing
 *    endpoint with its own rules, not an agent status change.
 *
 * Nothing maps back to OPEN: the spec is explicit that an agent cannot send a
 * ticket back to the start. Terminal statuses map to an empty list.
 */
export const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  [TicketStatus.OPEN]: [
    TicketStatus.IN_PROGRESS,
    TicketStatus.WITHDRAWN,
    TicketStatus.DUPLICATE_LINKED,
  ],
  [TicketStatus.IN_PROGRESS]: [
    TicketStatus.PENDING_USER,
    TicketStatus.PENDING_PARTNER,
    TicketStatus.RESOLVED,
    TicketStatus.WITHDRAWN,
    TicketStatus.DUPLICATE_LINKED,
  ],
  [TicketStatus.PENDING_USER]: [
    TicketStatus.IN_PROGRESS,
    TicketStatus.RESOLVED,
    TicketStatus.WITHDRAWN,
  ],
  [TicketStatus.PENDING_PARTNER]: [
    TicketStatus.IN_PROGRESS,
    TicketStatus.RESOLVED,
    TicketStatus.WITHDRAWN,
  ],
  [TicketStatus.REOPENED]: [
    TicketStatus.IN_PROGRESS,
    TicketStatus.PENDING_USER,
    TicketStatus.PENDING_PARTNER,
    TicketStatus.RESOLVED,
    TicketStatus.WITHDRAWN,
  ],
  [TicketStatus.RESOLVED]: [TicketStatus.CLOSED],
  [TicketStatus.CLOSED]: [],
  [TicketStatus.WITHDRAWN]: [],
  [TicketStatus.DUPLICATE_LINKED]: [],
};

/**
 * A move is legal only if it is listed for the current status. Staying put is
 * rejected too — a status change that changes nothing would just add noise to
 * the ticket history.
 */
export function isTransitionAllowed(from: TicketStatus, to: TicketStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
