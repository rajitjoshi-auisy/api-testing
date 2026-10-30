import { TicketStatus } from '@prisma/client';
import { ALLOWED_TRANSITIONS, isTransitionAllowed } from './status-transitions';

describe('status transitions', () => {
  it('should allow the normal lifecycle end to end', () => {
    expect(isTransitionAllowed(TicketStatus.OPEN, TicketStatus.IN_PROGRESS)).toBe(true);
    expect(isTransitionAllowed(TicketStatus.IN_PROGRESS, TicketStatus.PENDING_USER)).toBe(true);
    expect(isTransitionAllowed(TicketStatus.PENDING_USER, TicketStatus.IN_PROGRESS)).toBe(true);
    expect(isTransitionAllowed(TicketStatus.IN_PROGRESS, TicketStatus.RESOLVED)).toBe(true);
    expect(isTransitionAllowed(TicketStatus.RESOLVED, TicketStatus.CLOSED)).toBe(true);
  });

  // "Admin cannot skip back to Open" — the one-pager is explicit about this.
  it.each(Object.values(TicketStatus))('should never allow %s to go back to OPEN', (from) => {
    expect(isTransitionAllowed(from, TicketStatus.OPEN)).toBe(false);
  });

  it('should not allow skipping the queue from OPEN straight to RESOLVED or CLOSED', () => {
    expect(isTransitionAllowed(TicketStatus.OPEN, TicketStatus.RESOLVED)).toBe(false);
    expect(isTransitionAllowed(TicketStatus.OPEN, TicketStatus.CLOSED)).toBe(false);
  });

  // Reopening is a separate, customer-facing endpoint — not an agent status change.
  it.each([
    TicketStatus.CLOSED,
    TicketStatus.WITHDRAWN,
    TicketStatus.DUPLICATE_LINKED,
  ])('should treat %s as terminal', (terminal) => {
    expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
    for (const to of Object.values(TicketStatus)) {
      expect(isTransitionAllowed(terminal, to)).toBe(false);
    }
  });

  it('should reject a no-op transition so history stays meaningful', () => {
    for (const status of Object.values(TicketStatus)) {
      expect(isTransitionAllowed(status, status)).toBe(false);
    }
  });

  // A status added to the enum without a row here would otherwise be treated
  // as terminal silently, which is the wrong default to discover in production.
  it('should define a rule for every status in the enum', () => {
    for (const status of Object.values(TicketStatus)) {
      expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
    }
  });
});
