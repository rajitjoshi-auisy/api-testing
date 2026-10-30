import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma.service';
import { NotificationQueue } from '../notification/notification.queue';
import { TicketAutoCloseService } from './ticket-auto-close.service';

const mockHistoryCreate = jest.fn().mockResolvedValue({});
const mockTicketUpdate = jest.fn().mockResolvedValue({});

const mockPrismaService = {
  ticket: { findMany: jest.fn(), update: mockTicketUpdate },
  ticketHistory: { create: mockHistoryCreate },
  $transaction: jest.fn(async (fn: any) =>
    fn({ ticket: { update: mockTicketUpdate }, ticketHistory: { create: mockHistoryCreate } }),
  ),
};

const mockNotificationQueue = { queueStatusChanged: jest.fn().mockResolvedValue(undefined) };
const mockConfigService = { get: jest.fn().mockReturnValue(7) };

const resolved = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `internal-${i}`,
    ticketId: `TKT-${i}`,
    contactEmailOverride: 'customer@example.com',
    resolutionSummary: 'Refund processed.',
  }));

describe('TicketAutoCloseService', () => {
  let service: TicketAutoCloseService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfigService.get.mockReturnValue(7);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketAutoCloseService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: NotificationQueue, useValue: mockNotificationQueue },
      ],
    }).compile();
    service = module.get<TicketAutoCloseService>(TicketAutoCloseService);
  });

  it('should do nothing when no ticket is due', async () => {
    mockPrismaService.ticket.findMany.mockResolvedValue([]);

    expect(await service.closeStaleResolvedTickets()).toBe(0);
    expect(mockTicketUpdate).not.toHaveBeenCalled();
  });

  // "Auto-close X days after Resolved" — only RESOLVED, and only past the cutoff.
  it('should only select RESOLVED tickets older than the configured window', async () => {
    mockPrismaService.ticket.findMany.mockResolvedValue([]);

    await service.closeStaleResolvedTickets();

    const where = mockPrismaService.ticket.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('RESOLVED');
    const cutoff = where.resolvedAt.lte as Date;
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
  });

  // A reopened ticket is REOPENED, so it stops matching — no extra check needed.
  it('should never close a ticket that is not RESOLVED', async () => {
    mockPrismaService.ticket.findMany.mockResolvedValue([]);

    await service.closeStaleResolvedTickets();

    expect(mockPrismaService.ticket.findMany.mock.calls[0][0].where.status).toBe('RESOLVED');
  });

  it('should close the ticket and record SYSTEM in the history', async () => {
    mockPrismaService.ticket.findMany.mockResolvedValue(resolved(1));

    expect(await service.closeStaleResolvedTickets()).toBe(1);

    expect(mockTicketUpdate).toHaveBeenCalledWith({
      where: { id: 'internal-0' },
      data: expect.objectContaining({ status: 'CLOSED', closedAt: expect.any(Date) }),
    });
    expect(mockHistoryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ticketId: 'internal-0',
        oldStatus: 'RESOLVED',
        newStatus: 'CLOSED',
        changedBy: 'SYSTEM',
      }),
    });
  });

  it('should email the customer that the ticket was closed', async () => {
    mockPrismaService.ticket.findMany.mockResolvedValue(resolved(1));

    await service.closeStaleResolvedTickets();

    expect(mockNotificationQueue.queueStatusChanged).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 'TKT-0', customerEmail: 'customer@example.com' }),
    );
  });

  it('should skip the email when the ticket has no contact address', async () => {
    mockPrismaService.ticket.findMany.mockResolvedValue([
      { ...resolved(1)[0], contactEmailOverride: null },
    ]);

    expect(await service.closeStaleResolvedTickets()).toBe(1);
    expect(mockNotificationQueue.queueStatusChanged).not.toHaveBeenCalled();
  });

  // A batch job that dies on its first bad row leaves the rest stuck forever.
  it('should keep going when one ticket fails to close', async () => {
    mockPrismaService.ticket.findMany.mockResolvedValue(resolved(3));
    mockPrismaService.$transaction
      .mockImplementationOnce(async () => {
        throw new Error('row locked');
      })
      .mockImplementation(async (fn: any) =>
        fn({ ticket: { update: mockTicketUpdate }, ticketHistory: { create: mockHistoryCreate } }),
      );

    expect(await service.closeStaleResolvedTickets()).toBe(2);
  });

  it('should still close the ticket when the notification fails', async () => {
    mockPrismaService.ticket.findMany.mockResolvedValue(resolved(1));
    mockNotificationQueue.queueStatusChanged.mockRejectedValueOnce(new Error('redis down'));

    expect(await service.closeStaleResolvedTickets()).toBe(1);
    expect(mockTicketUpdate).toHaveBeenCalled();
  });

  it('should fall back to 7 days when the configured value is unusable', async () => {
    mockConfigService.get.mockReturnValue('not-a-number');
    mockPrismaService.ticket.findMany.mockResolvedValue([]);

    await service.closeStaleResolvedTickets();

    const cutoff = mockPrismaService.ticket.findMany.mock.calls[0][0].where.resolvedAt.lte as Date;
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
  });

  it('should cap one run so a backlog cannot monopolise the database', async () => {
    mockPrismaService.ticket.findMany.mockResolvedValue([]);

    await service.closeStaleResolvedTickets();

    expect(mockPrismaService.ticket.findMany.mock.calls[0][0].take).toBe(200);
  });
});
