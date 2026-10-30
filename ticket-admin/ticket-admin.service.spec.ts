import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma.service';
import { TicketAdminService } from './ticket-admin.service';
import { BoltpeException, ErrorCode } from '@boltpe/shared';
import { GetAllTicketsDto, UpdateTicketStatusDto } from './dto/ticket-admin.dto';
import { NotificationQueue } from '../notification/notification.queue';

// queueStatusChanged never throws in production; the mock mirrors that.
const mockNotificationQueue = {
  queueStatusChanged: jest.fn().mockResolvedValue(undefined),
};

// ── Inline Prisma mock — swap for your shared mock helper if one exists ──
const mockTicketHistoryCreate = jest.fn().mockResolvedValue({});

const mockPrismaService = {
  ticket: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  ticketHistory: { create: mockTicketHistoryCreate },
  $transaction: jest.fn(),
};

/**
 * Status changes and reopens run inside $transaction(callback) so the ticket
 * and its audit entry move together. Hands the callback a tx client backed by
 * the same mocks, so existing assertions on ticket.update still hold.
 */
const runTransactionCallback = () =>
  mockPrismaService.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function'
      ? arg({ ticket: mockPrismaService.ticket, ticketHistory: mockPrismaService.ticketHistory })
      : arg,
  );

/**
 * Asserts the promise rejects with a BoltpeException carrying the expected
 * ErrorCode — `rejects.toThrow(BoltpeException)` alone cannot tell the
 * service's error branches apart, since they all throw the same class.
 */
async function expectBoltpeError(promise: Promise<unknown>, code: ErrorCode) {
  const error = await promise.then(
    () => {
      throw new Error('Expected BoltpeException, but the call resolved');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BoltpeException);
  expect((error as BoltpeException).getResponse()).toMatchObject({ errorCode: code });
}

describe('TicketAdminService', () => {
  let service: TicketAdminService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketAdminService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: NotificationQueue, useValue: mockNotificationQueue },
      ],
    }).compile();

    service = module.get<TicketAdminService>(TicketAdminService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ───────────────────────────────────────────────────────────────────────
  // getAllTickets
  // ───────────────────────────────────────────────────────────────────────
  describe('getAllTickets', () => {
    const mockTickets = [
      { id: '1', ticketId: 'TKT-001', status: 'OPEN', createdAt: new Date() },
      { id: '2', ticketId: 'TKT-002', status: 'OPEN', createdAt: new Date() },
    ];

    it('should return paginated tickets with no filters', async () => {
      mockPrismaService.$transaction.mockResolvedValue([mockTickets, 2]);

      const dto: GetAllTicketsDto = { page: 1, limit: 20 };
      const result = await service.getAllTickets(dto);

      expect(mockPrismaService.$transaction).toHaveBeenCalled();
      expect(result.data!.tickets).toEqual(mockTickets);
      expect(result.data!.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        hasMore: false,
      });
    });

    it('should apply every supplied filter to the where clause', async () => {
      mockPrismaService.$transaction.mockResolvedValue([mockTickets, 2]);

      const dto: GetAllTicketsDto = {
        status: 'OPEN' as any,
        l1CategoryCode: 'PAYMENT',
        l2SubCategoryCode: 'FAILED_TXN',
        assignedAgentId: 'agent-1',
        page: 1,
        limit: 20,
      };
      await service.getAllTickets(dto);

      // $transaction receives the built queries, so assert on the mocked
      // findMany/count calls themselves rather than on $transaction alone.
      expect(mockPrismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'OPEN',
            l1CategoryCode: 'PAYMENT',
            l2SubCategoryCode: 'FAILED_TXN',
            assignedAgentId: 'agent-1',
          },
        }),
      );
      expect(mockPrismaService.ticket.count).toHaveBeenCalledWith({
        where: {
          status: 'OPEN',
          l1CategoryCode: 'PAYMENT',
          l2SubCategoryCode: 'FAILED_TXN',
          assignedAgentId: 'agent-1',
        },
      });
    });

    it('should omit absent filters from the where clause entirely', async () => {
      mockPrismaService.$transaction.mockResolvedValue([mockTickets, 2]);

      await service.getAllTickets({ page: 1, limit: 20 });

      expect(mockPrismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('should translate page/limit into the correct skip and take', async () => {
      mockPrismaService.$transaction.mockResolvedValue([mockTickets, 100]);

      await service.getAllTickets({ page: 3, limit: 25 });

      expect(mockPrismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 25 }),
      );
    });

    it('should not skip any rows on the first page', async () => {
      mockPrismaService.$transaction.mockResolvedValue([mockTickets, 2]);

      await service.getAllTickets({ page: 1, limit: 20 });

      expect(mockPrismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('should report hasMore false on the last page', async () => {
      mockPrismaService.$transaction.mockResolvedValue([mockTickets, 50]);

      const result = await service.getAllTickets({ page: 3, limit: 25 });

      expect(result.data!.pagination.hasMore).toBe(false);
    });

    it('should calculate hasMore correctly when more pages exist', async () => {
      mockPrismaService.$transaction.mockResolvedValue([mockTickets, 50]);

      const dto: GetAllTicketsDto = { page: 1, limit: 20 };
      const result = await service.getAllTickets(dto);

      expect(result.data!.pagination.hasMore).toBe(true);
    });

    it('should default page and limit when not provided', async () => {
      mockPrismaService.$transaction.mockResolvedValue([mockTickets, 2]);

      const result = await service.getAllTickets({} as GetAllTicketsDto);

      expect(result.data!.pagination.page).toBe(1);
      expect(result.data!.pagination.limit).toBe(20);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // updateTicketStatus
  // ───────────────────────────────────────────────────────────────────────
  describe('updateTicketStatus', () => {
    beforeEach(runTransactionCallback);

    const existingTicket = {
      id: 'internal-1',
      ticketId: 'TKT-001',
      status: 'OPEN',
      resolvedAt: null,
      closedAt: null,
    };

    it('should throw BoltpeException when ticket is not found', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(null);

      const dto: UpdateTicketStatusDto = { status: 'IN_PROGRESS' as any };

      await expectBoltpeError(
        service.updateTicketStatus('TKT-999', dto, 'agent-1'),
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });

    it('should update status and set resolvedAt when transitioning to RESOLVED', async () => {
      // RESOLVED is reachable from IN_PROGRESS, not straight from OPEN.
      mockPrismaService.ticket.findUnique.mockResolvedValue({
        ...existingTicket,
        status: 'IN_PROGRESS',
      });
      const updatedTicket = { ...existingTicket, status: 'RESOLVED', resolvedAt: new Date() };
      mockPrismaService.ticket.update.mockResolvedValue(updatedTicket);

      const dto: UpdateTicketStatusDto = {
        status: 'RESOLVED' as any,
        dispositionCode: 'REFUND_PROCESSED',
        resolutionSummary: 'Refund processed to original payment method.',
      };

      const result = await service.updateTicketStatus('TKT-001', dto, 'agent-1');

      expect(mockPrismaService.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ticketId: 'TKT-001' },
          data: expect.objectContaining({
            status: 'RESOLVED',
            dispositionCode: 'REFUND_PROCESSED',
            resolutionSummary: 'Refund processed to original payment method.',
          }),
        }),
      );
      expect(result.data!.status).toBe('RESOLVED');
    });

    it('should set closedAt when transitioning to CLOSED', async () => {
      // CLOSED is reachable only from RESOLVED.
      mockPrismaService.ticket.findUnique.mockResolvedValue({
        ...existingTicket,
        status: 'RESOLVED',
      });
      mockPrismaService.ticket.update.mockResolvedValue({ ...existingTicket, status: 'CLOSED' });

      const dto: UpdateTicketStatusDto = {
        status: 'CLOSED' as any,
        dispositionCode: 'DUPLICATE',
        resolutionSummary: 'Duplicate of TKT-000.',
      };

      await service.updateTicketStatus('TKT-001', dto, 'agent-1');

      const callArgs = mockPrismaService.ticket.update.mock.calls[0][0];
      expect(callArgs.data.closedAt).toBeInstanceOf(Date);
    });

    it('should not overwrite resolvedAt when status is not RESOLVED', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(existingTicket);
      mockPrismaService.ticket.update.mockResolvedValue({ ...existingTicket, status: 'IN_PROGRESS' });

      const dto: UpdateTicketStatusDto = { status: 'IN_PROGRESS' as any };
      await service.updateTicketStatus('TKT-001', dto, 'agent-1');

      const callArgs = mockPrismaService.ticket.update.mock.calls[0][0];
      expect(callArgs.data.resolvedAt).toBe(existingTicket.resolvedAt);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // status-change notifications
  // ───────────────────────────────────────────────────────────────────────
  describe('status-change notifications', () => {
    beforeEach(runTransactionCallback);

    const base = {
      id: 'internal-1',
      ticketId: 'TKT-N1',
      status: 'OPEN',
      resolvedAt: null,
      closedAt: null,
      contactEmailOverride: 'customer@example.com',
    };

    // from is the ticket's current status — it has to be one the target is
    // actually reachable from, now that transitions are enforced.
    const updateTo = async (status: string, dto: any = {}, from = 'OPEN') => {
      mockPrismaService.ticket.findUnique.mockResolvedValue({ ...base, status: from });
      mockPrismaService.ticket.update.mockResolvedValue({ ...base, status });
      return service.updateTicketStatus('TKT-N1', { status, ...dto } as any, 'agent-1');
    };

    it('should email the customer when a ticket moves to IN_PROGRESS', async () => {
      await updateTo('IN_PROGRESS');

      expect(mockNotificationQueue.queueStatusChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'TKT-N1',
          customerEmail: 'customer@example.com',
          statusLabel: 'In progress',
        }),
      );
    });

    it('should pass the agent resolution summary through as the remark', async () => {
      await updateTo(
        'RESOLVED',
        {
          dispositionCode: 'REFUND_PROCESSED',
          resolutionSummary: 'Refund processed to the original payment method.',
        },
        'IN_PROGRESS',
      );

      expect(mockNotificationQueue.queueStatusChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          statusLabel: 'Resolved',
          remark: 'Refund processed to the original payment method.',
        }),
      );
    });

    it.each(['WITHDRAWN', 'DUPLICATE_LINKED'])(
      'should not email the customer for the internal status %s',
      async (status) => {
        await updateTo(status);

        expect(mockNotificationQueue.queueStatusChanged).not.toHaveBeenCalled();
      },
    );

    it('should skip the email when the ticket has no contact address', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(base);
      mockPrismaService.ticket.update.mockResolvedValue({
        ...base,
        status: 'IN_PROGRESS',
        contactEmailOverride: null,
      });

      await service.updateTicketStatus('TKT-N1', { status: 'IN_PROGRESS' } as any, 'agent-1');

      expect(mockNotificationQueue.queueStatusChanged).not.toHaveBeenCalled();
    });

    // An agent's status update must never fail because a notification could not
    // be queued.
    it('should still update the status when queueing the notification fails', async () => {
      mockNotificationQueue.queueStatusChanged.mockRejectedValueOnce(new Error('redis down'));
      mockPrismaService.ticket.findUnique.mockResolvedValue(base);
      mockPrismaService.ticket.update.mockResolvedValue({ ...base, status: 'IN_PROGRESS' });

      await expect(
        service.updateTicketStatus('TKT-N1', { status: 'IN_PROGRESS' } as any, 'agent-1'),
      ).resolves.toMatchObject({ data: expect.objectContaining({ status: 'IN_PROGRESS' }) });
    });

  });

  // ───────────────────────────────────────────────────────────────────────
  // reopenTicket
  // ───────────────────────────────────────────────────────────────────────
  
  // ───────────────────────────────────────────────────────────────────────
  describe('transition enforcement and audit trail', () => {
    beforeEach(runTransactionCallback);

    const at = (status: string) => ({
      id: 'internal-1',
      ticketId: 'TKT-T1',
      status,
      resolvedAt: null,
      closedAt: null,
      contactEmailOverride: 'customer@example.com',
    });

    it('should reject an illegal transition without writing anything', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(at('CLOSED'));

      await expectBoltpeError(
        service.updateTicketStatus('TKT-T1', { status: 'IN_PROGRESS' } as any, 'agent-1'),
        ErrorCode.VALIDATION_ERROR,
      );
      expect(mockPrismaService.ticket.update).not.toHaveBeenCalled();
      expect(mockTicketHistoryCreate).not.toHaveBeenCalled();
    });

    it('should refuse to send a ticket back to OPEN', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(at('IN_PROGRESS'));

      await expectBoltpeError(
        service.updateTicketStatus('TKT-T1', { status: 'OPEN' } as any, 'agent-1'),
        ErrorCode.VALIDATION_ERROR,
      );
      expect(mockPrismaService.ticket.update).not.toHaveBeenCalled();
    });

    it('should tell the caller which statuses are allowed from here', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(at('OPEN'));

      const error = await service
        .updateTicketStatus('TKT-T1', { status: 'CLOSED' } as any, 'agent-1')
        .then(() => null, (e) => e);

      expect(error.getResponse()).toMatchObject({
        details: { from: 'OPEN', to: 'CLOSED', allowed: expect.arrayContaining(['IN_PROGRESS']) },
      });
    });

    it('should record who changed the status, and from what, to what', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(at('OPEN'));
      mockPrismaService.ticket.update.mockResolvedValue({ ...at('IN_PROGRESS') });

      await service.updateTicketStatus(
        'TKT-T1',
        { status: 'IN_PROGRESS', internalNote: 'Chased the PSP.' } as any,
        'agent-7',
      );

      expect(mockTicketHistoryCreate).toHaveBeenCalledWith({
        data: {
          ticketId: 'internal-1',
          oldStatus: 'OPEN',
          newStatus: 'IN_PROGRESS',
          remark: null,
          internalNote: 'Chased the PSP.',
          changedBy: 'agent-7',
        },
      });
    });

    // The audit entry and the ticket must move together, or a status could
    // change with no record of who changed it.
    it('should write the ticket and its history in the same transaction', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(at('OPEN'));
      mockPrismaService.ticket.update.mockResolvedValue({ ...at('IN_PROGRESS') });

      await service.updateTicketStatus('TKT-T1', { status: 'IN_PROGRESS' } as any, 'agent-1');

      expect(mockPrismaService.$transaction).toHaveBeenCalledWith(expect.any(Function));
    });

  });

  // ───────────────────────────────────────────────────────────────────────
  describe('getTicketById', () => {
    const full = {
      id: 'internal-1',
      ticketId: 'TKT-A1',
      customerId: 'someone-else',
      status: 'IN_PROGRESS',
      contactEmailOverride: 'customer@example.com',
      contactMobileOverride: '9876543210',
      messages: [],
      attachments: [],
      slaTimer: null,
      history: [
        {
          oldStatus: 'OPEN',
          newStatus: 'IN_PROGRESS',
          remark: null,
          internalNote: 'Chased the PSP.',
          changedBy: 'agent-7',
          changedAt: new Date(),
        },
      ],
    };

    it('should 404 when the ticket does not exist', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(null);

      await expectBoltpeError(service.getTicketById('TKT-NOPE'), ErrorCode.RESOURCE_NOT_FOUND);
    });

    // The whole point of this endpoint: an agent must reach any ticket, not
    // only their own. The customer endpoint filters on customerId; this must not.
    it('should look the ticket up by id alone, with no owner filter', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(full);

      await service.getTicketById('TKT-A1');

      const args = mockPrismaService.ticket.findUnique.mock.calls[0][0];
      expect(args.where).toEqual({ ticketId: 'TKT-A1' });
      expect(JSON.stringify(args.where)).not.toContain('customerId');
    });

    it('should return the thread, attachments, SLA timer and history', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(full);

      await service.getTicketById('TKT-A1');

      const include = mockPrismaService.ticket.findUnique.mock.calls[0][0].include;
      expect(include.messages).toBeDefined();
      expect(include.attachments).toBe(true);
      expect(include.slaTimer).toBe(true);
      expect(include.history).toBeDefined();
    });

    // Agents need the contact details to do the job — unlike the customer
    // endpoint, which masks them.
    it('should return contact details unmasked', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(full);

      const result = await service.getTicketById('TKT-A1');

      expect(result.data).toMatchObject({
        contactEmailOverride: 'customer@example.com',
        contactMobileOverride: '9876543210',
      });
    });

    it('should include the admin-only internal note in the history', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(full);

      const result = await service.getTicketById('TKT-A1');

      expect((result.data as any).history[0].internalNote).toBe('Chased the PSP.');
      expect((result.data as any).history[0].changedBy).toBe('agent-7');
    });

    // The PRD wants the status dropdown to offer only valid next states, and
    // the rejection's details payload is stripped before it reaches a client.
    it('should tell the console which statuses are legal from here', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(full);

      const result = await service.getTicketById('TKT-A1');

      expect((result.data as any).allowedNextStatuses).toEqual(
        expect.arrayContaining(['PENDING_USER', 'RESOLVED']),
      );
      expect((result.data as any).allowedNextStatuses).not.toContain('OPEN');
    });

    it('should return an empty list of next statuses for a terminal ticket', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue({ ...full, status: 'CLOSED' });

      const result = await service.getTicketById('TKT-A1');

      expect((result.data as any).allowedNextStatuses).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('concurrent edits', () => {
    beforeEach(runTransactionCallback);

    const at = (status: string) => ({
      id: 'internal-1',
      ticketId: 'TKT-C1',
      status,
      resolvedAt: null,
      closedAt: null,
      contactEmailOverride: 'customer@example.com',
      updatedAt: new Date('2026-10-29T09:00:00.000Z'),
    });

    it('should apply the change when the ticket has not moved since it was read', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(at('OPEN'));
      mockPrismaService.ticket.updateMany.mockResolvedValue({ count: 1 });
      mockPrismaService.ticket.update.mockResolvedValue(at('IN_PROGRESS'));

      await service.updateTicketStatus(
        'TKT-C1',
        { status: 'IN_PROGRESS', expectedUpdatedAt: '2026-10-29T09:00:00.000Z' } as any,
        'agent-A',
      );

      expect(mockPrismaService.ticket.update).toHaveBeenCalled();
    });

    // The second of two agents must be told to refresh, not silently win.
    it('should reject when another agent has changed the ticket since', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(at('OPEN'));
      mockPrismaService.ticket.updateMany.mockResolvedValue({ count: 0 });

      const error = await service
        .updateTicketStatus(
          'TKT-C1',
          { status: 'IN_PROGRESS', expectedUpdatedAt: '2026-10-29T09:00:00.000Z' } as any,
          'agent-B',
        )
        .then(() => null, (e) => e);

      expect(error.getResponse()).toMatchObject({
        message: 'Ticket updated by another user, refresh.',
      });
      expect(mockPrismaService.ticket.update).not.toHaveBeenCalled();
    });

    it('should skip the check entirely when no version is supplied', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(at('OPEN'));
      mockPrismaService.ticket.update.mockResolvedValue(at('IN_PROGRESS'));

      await service.updateTicketStatus('TKT-C1', { status: 'IN_PROGRESS' } as any, 'agent-A');

      expect(mockPrismaService.ticket.updateMany).not.toHaveBeenCalled();
      expect(mockPrismaService.ticket.update).toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('search and date filters', () => {
    const run = (filters: any) => {
      mockPrismaService.$transaction.mockResolvedValue([[], 0]);
      return service.getAllTickets(filters);
    };
    const whereUsed = () => mockPrismaService.ticket.findMany.mock.calls[0][0].where;

    // One box, three fields — an agent pastes whatever the customer gave them.
    it('should search ticket id, mobile and email together', async () => {
      await run({ search: '9876543210' });

      const or = whereUsed().OR;
      expect(or).toHaveLength(3);
      expect(JSON.stringify(or)).toContain('ticketId');
      expect(JSON.stringify(or)).toContain('contactMobileOverride');
      expect(JSON.stringify(or)).toContain('contactEmailOverride');
    });

    it('should match ticket id and email case-insensitively', async () => {
      await run({ search: 'tkt-boltpe' });

      const or = whereUsed().OR;
      expect(or[0].ticketId.mode).toBe('insensitive');
      expect(or[2].contactEmailOverride.mode).toBe('insensitive');
    });

    it('should not add an OR clause when no search term is given', async () => {
      await run({ status: 'OPEN' });

      expect(whereUsed().OR).toBeUndefined();
    });

    // A plain toDate must cover the whole day, or tickets raised that
    // afternoon are invisible to a same-day search.
    it('should make toDate inclusive of the entire day', async () => {
      await run({ toDate: '2026-10-31' });

      const lte: Date = whereUsed().createdAt.lte;
      expect(lte.getHours()).toBe(23);
      expect(lte.getMinutes()).toBe(59);
    });

    it('should respect a toDate that already carries a time', async () => {
      await run({ toDate: '2026-10-31T09:00:00.000Z' });

      const lte: Date = whereUsed().createdAt.lte;
      expect(lte.toISOString()).toBe('2026-10-31T09:00:00.000Z');
    });

    it('should combine a date range with the other filters', async () => {
      await run({ status: 'OPEN', fromDate: '2026-10-01', toDate: '2026-10-31' });

      const where = whereUsed();
      expect(where.status).toBe('OPEN');
      expect(where.createdAt.gte).toBeInstanceOf(Date);
      expect(where.createdAt.lte).toBeInstanceOf(Date);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('assignTicket', () => {
    const ticket = { id: 'internal-1', ticketId: 'TKT-A1', assignedAgentId: null };

    it('should assign the ticket and stamp the time', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(ticket);
      mockPrismaService.ticket.update.mockResolvedValue({ ...ticket, assignedAgentId: 'agent-7' });

      const result = await service.assignTicket('TKT-A1', { agentId: 'agent-7' }, 'supervisor-1');

      expect(mockPrismaService.ticket.update).toHaveBeenCalledWith({
        where: { ticketId: 'TKT-A1' },
        data: { assignedAgentId: 'agent-7', assignedAt: expect.any(Date) },
      });
      expect(result.message).toBe('Ticket assigned');
    });

    it('should clear the agent and the timestamp when unassigning', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue({ ...ticket, assignedAgentId: 'agent-7' });
      mockPrismaService.ticket.update.mockResolvedValue({ ...ticket, assignedAgentId: null });

      const result = await service.assignTicket('TKT-A1', { agentId: null }, 'supervisor-1');

      expect(mockPrismaService.ticket.update).toHaveBeenCalledWith({
        where: { ticketId: 'TKT-A1' },
        data: { assignedAgentId: null, assignedAt: null },
      });
      expect(result.message).toBe('Ticket unassigned');
    });

    // Assignment is internal routing, not a lifecycle event — it must not
    // pollute the status history or email the customer.
    it('should not touch the status, the history or the customer', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(ticket);
      mockPrismaService.ticket.update.mockResolvedValue(ticket);

      await service.assignTicket('TKT-A1', { agentId: 'agent-7' }, 'supervisor-1');

      const data = mockPrismaService.ticket.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('status');
      expect(mockTicketHistoryCreate).not.toHaveBeenCalled();
      expect(mockNotificationQueue.queueStatusChanged).not.toHaveBeenCalled();
    });

    it('should 404 on an unknown ticket', async () => {
      mockPrismaService.ticket.findUnique.mockResolvedValue(null);

      await expectBoltpeError(
        service.assignTicket('TKT-NOPE', { agentId: 'agent-7' }, 'supervisor-1'),
        ErrorCode.RESOURCE_NOT_FOUND,
      );
      expect(mockPrismaService.ticket.update).not.toHaveBeenCalled();
    });
  });
});
