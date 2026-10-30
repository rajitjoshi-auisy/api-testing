import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma.service';
import { TicketService, MAX_ATTACHMENTS_PER_TICKET } from './ticket.service';
import { BoltpeException, ErrorCode, S3UploadUtil } from '@boltpe/shared';
import { NotificationQueue } from '../notification/notification.queue';
import { CreateTicketDto } from './dto/create-ticket.dto';
import * as idGenerator from '../../common/utils/id-generator';
import * as piiMasker from '../../common/utils/pii-masker';

// ── Inline Prisma mock — swap for your shared mock helper if one exists ──
// queueTicketCreated never throws in production; the mock mirrors that.
const mockNotificationQueue = {
  queueTicketCreated: jest.fn().mockResolvedValue(undefined),
};

const mockTicketHistoryCreate = jest.fn().mockResolvedValue({});

const mockPrismaService = {
  issueCategoryL1: { findMany: jest.fn(), findUnique: jest.fn() },
  ticket: { count: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  botConfiguration: { findUnique: jest.fn() },
  ticketMessage: { create: jest.fn() },
  ticketHistory: { create: jest.fn() },
  ticketAttachment: {
    count: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  },
  $transaction: jest.fn(),
};


// ── Mock the shared utils the service imports directly ──
jest.mock('../../common/utils/id-generator', () => ({
  generateTicketId: jest.fn(),
  l1CodeToTicketCategory: jest.fn(),
}));

jest.mock('../../common/utils/pii-masker', () => ({
  maskEmail: jest.fn((email: string) => `masked:${email}`),
  maskMobile: jest.fn((mobile: string) => `masked:${mobile}`),
}));

jest.mock('@boltpe/shared', () => {
  const actual = jest.requireActual('@boltpe/shared');
  return {
    ...actual,
    S3UploadUtil: {
      uploadTicketAttachment: jest.fn(),
    },
  };
});

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

describe('TicketService', () => {
  let service: TicketService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: NotificationQueue, useValue: mockNotificationQueue },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ───────────────────────────────────────────────────────────────────────
  // getL1Categories
  // ───────────────────────────────────────────────────────────────────────
  describe('getL1Categories', () => {
    it('should fetch categories scoped to a specific bot (OR global)', async () => {
      const categories = [{ id: '1', code: 'PAYMENT', isActive: true }];
      mockPrismaService.issueCategoryL1.findMany.mockResolvedValue(categories);

      const result = await service.getL1Categories('bot-1');

      expect(mockPrismaService.issueCategoryL1.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, OR: [{ botId: 'bot-1' }, { botId: null }] },
        }),
      );
      expect(result.data).toEqual(categories);
    });

    it('should fetch only global categories when botId is omitted', async () => {
      mockPrismaService.issueCategoryL1.findMany.mockResolvedValue([]);

      await service.getL1Categories();

      expect(mockPrismaService.issueCategoryL1.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, botId: null },
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // createTicket
  // ───────────────────────────────────────────────────────────────────────
  describe('createTicket', () => {
    const baseDto: CreateTicketDto = {
      l1CategoryCode: 'PAYMENT_TRANSACTION_ISSUE',
      description: 'Payment deducted but booking not confirmed even after 2 hours.',
      contactEmailOverride: 'user@example.com',
      contactMobileOverride: '9876543210',
    };
    const ctx = { customerId: 'customer-1', botId: 'bot-1', idempotencyKey: 'idem-key-1' };

    // Tickets are raised against an L1 only — routing and SLA inputs live here now.
    const l1Mock = {
      id: 'l1-1',
      code: 'PAYMENT_TRANSACTION_ISSUE',
      displayName: 'Payment or Transaction issue',
      routingSkill: 'PAYMENT_SUPPORT',
      defaultPriority: 3,
      neverAutoResolve: false,
      isActive: true,
    };

    beforeEach(() => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(l1Mock);
      mockPrismaService.ticket.count.mockResolvedValue(0);
      mockPrismaService.ticket.findFirst.mockResolvedValue(null);
      mockPrismaService.ticket.findUnique.mockResolvedValue(null);
      mockPrismaService.botConfiguration.findUnique.mockResolvedValue({ botCode: 'BOLTPE' });
      (idGenerator.generateTicketId as jest.Mock).mockReturnValue('TKT-BOLTPE-2609-PAY-ABC123');
      (idGenerator.l1CodeToTicketCategory as jest.Mock).mockReturnValue('PAY');
    });

    it('should return the existing ticket when the idempotency key was already used', async () => {
      const firstAttempt = { id: 'internal-1', ticketId: 'TKT-FIRST-ATTEMPT' };
      mockPrismaService.ticket.findUnique.mockResolvedValue(firstAttempt);

      const result = await service.createTicket(baseDto, ctx);

      expect(mockPrismaService.ticket.findUnique).toHaveBeenCalledWith({
        where: { idempotencyKey: 'idem-key-1' },
        include: { attachments: true },
      });
      // A replay returns the same shape as a fresh create, so the caller cannot tell them apart.
      expect(result.data).toMatchObject({ ...firstAttempt, attachmentsFailed: false });
      // A replay must not re-run the ceiling/duplicate checks or insert again.
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
      expect(mockPrismaService.ticket.count).not.toHaveBeenCalled();
    });

    it('should not look up a replay when no idempotency key was supplied', async () => {
      mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
        fn({
          ticket: { create: jest.fn().mockResolvedValue({ id: 'internal-1', ticketId: 'TKT-X' }) },
          ticketSlaTimer: { create: jest.fn() },
          ticketMessage: { create: jest.fn() },
            ticketHistory: { create: jest.fn() },
            ticketAttachment: { createMany: jest.fn() },
        }),
      );

      await service.createTicket(baseDto, { ...ctx, idempotencyKey: undefined as any });

      expect(mockPrismaService.ticket.findUnique).not.toHaveBeenCalled();
      expect(mockPrismaService.$transaction).toHaveBeenCalled();
    });

    it('should persist the caller-supplied idempotency key on the ticket', async () => {
      const txTicketCreate = jest
        .fn()
        .mockResolvedValue({ id: 'internal-1', ticketId: 'TKT-X' });
      mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
        fn({
          ticket: { create: txTicketCreate },
          ticketSlaTimer: { create: jest.fn() },
          ticketMessage: { create: jest.fn() },
            ticketHistory: { create: jest.fn() },
            ticketAttachment: { createMany: jest.fn() },
        }),
      );

      await service.createTicket(baseDto, ctx);

      expect(txTicketCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ idempotencyKey: 'idem-key-1' }),
        }),
      );
    });

    it('should return the winning ticket when a concurrent retry loses the unique-key race', async () => {
      const winner = { id: 'internal-1', ticketId: 'TKT-WINNER' };
      const conflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      mockPrismaService.$transaction.mockRejectedValue(conflict);
      mockPrismaService.ticket.findUnique
        .mockResolvedValueOnce(null)   // replay check before insert
        .mockResolvedValueOnce(winner); // re-read after losing the race

      const result = await service.createTicket(baseDto, ctx);

      expect(result.data).toMatchObject({ ...winner, attachmentsFailed: false });
    });

    it('should re-throw a transaction failure that is not an idempotency conflict', async () => {
      const dbError = Object.assign(new Error('connection lost'), { code: 'P1001' });
      mockPrismaService.$transaction.mockRejectedValue(dbError);

      await expect(service.createTicket(baseDto, ctx)).rejects.toThrow('connection lost');
    });

    it('should scope the duplicate check to the same bot as the open-ticket ceiling', async () => {
      mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
        fn({
          ticket: { create: jest.fn().mockResolvedValue({ id: 'internal-1', ticketId: 'TKT-X' }) },
          ticketSlaTimer: { create: jest.fn() },
          ticketMessage: { create: jest.fn() },
            ticketHistory: { create: jest.fn() },
            ticketAttachment: { createMany: jest.fn() },
        }),
      );

      await service.createTicket(baseDto, ctx);

      expect(mockPrismaService.ticket.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ customerId: 'customer-1', botId: 'bot-1' }),
        }),
      );
    });

    describe('with attachments in the same call', () => {
      // clearAllMocks keeps return values, so reset this one explicitly or a
      // previous test's attachment list bleeds into the next.
      beforeEach(() => {
        mockPrismaService.ticketAttachment.findMany.mockResolvedValue([]);
      });

      const validFile = {
        originalname: 'receipt.jpg',
        mimetype: 'image/jpeg',
        size: 1024 * 1024,
        buffer: Buffer.from('fake'),
      } as Express.Multer.File;

      const withTx = () =>
        mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
          fn({
            ticket: { create: jest.fn().mockResolvedValue({ id: 'internal-1', ticketId: 'TKT-X' }) },
            ticketSlaTimer: { create: jest.fn() },
            ticketMessage: { create: jest.fn() },
            ticketHistory: { create: jest.fn() },
            ticketAttachment: { createMany: jest.fn() },
          }),
        );

      it('should create the ticket and upload its attachments in one call', async () => {
        withTx();
        (S3UploadUtil.uploadTicketAttachment as jest.Mock).mockResolvedValue({ url: 's3://b/k.jpg' });
        mockPrismaService.ticketAttachment.findMany.mockResolvedValue([{ id: 'att-1' }]);

        const result = await service.createTicket(baseDto, ctx, [validFile]);

        expect(S3UploadUtil.uploadTicketAttachment).toHaveBeenCalledWith(
          validFile,
          expect.any(String),
        );
        expect(result.data!.attachments).toHaveLength(1);
        expect(result.data!.attachmentsFailed).toBe(false);
      });

      // The PRD treats the ticket and its attachment as one unit: the upload
      // runs first so that a failure leaves nothing behind to clean up.
      it('should upload before opening the transaction', async () => {
        withTx();
        const order: string[] = [];
        (S3UploadUtil.uploadTicketAttachment as jest.Mock).mockImplementation(async () => {
          order.push('upload');
          return { url: 's3://b/k.jpg' };
        });
        mockPrismaService.$transaction.mockImplementation(async (fn: any) => {
          order.push('transaction');
          return fn({
            ticket: { create: jest.fn().mockResolvedValue({ id: 'internal-1', ticketId: 'TKT-X' }) },
            ticketSlaTimer: { create: jest.fn() },
            ticketMessage: { create: jest.fn() },
            ticketHistory: { create: jest.fn() },
            ticketAttachment: { createMany: jest.fn() },
          });
        });

        await service.createTicket(baseDto, ctx, [validFile]);

        expect(order).toEqual(['upload', 'transaction']);
      });

      it('should create the ticket normally when no files are sent', async () => {
        withTx();

        const result = await service.createTicket(baseDto, ctx);

        expect(S3UploadUtil.uploadTicketAttachment).not.toHaveBeenCalled();
        expect(result.data!.attachments).toEqual([]);
        expect(result.data!.attachmentsFailed).toBe(false);
      });

      it('should reject a disallowed file type before creating anything', async () => {
        withTx();
        const badFile = { ...validFile, mimetype: 'application/zip' };

        await expectBoltpeError(
          service.createTicket(baseDto, ctx, [badFile]),
          ErrorCode.INVALID_INPUT,
        );
        expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
      });

      it('should reject an oversized file before creating anything', async () => {
        withTx();
        const bigFile = { ...validFile, size: 6 * 1024 * 1024 };

        await expectBoltpeError(
          service.createTicket(baseDto, ctx, [bigFile]),
          ErrorCode.INVALID_INPUT,
        );
        expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
      });

      it('should accept exactly the maximum number of attachments', async () => {
        withTx();
        (S3UploadUtil.uploadTicketAttachment as jest.Mock).mockResolvedValue({ url: 's3://b/k.jpg' });
        const atTheLimit = Array(MAX_ATTACHMENTS_PER_TICKET).fill(validFile);

        await expect(service.createTicket(baseDto, ctx, atTheLimit)).resolves.toMatchObject({
          success: true,
        });
        expect(S3UploadUtil.uploadTicketAttachment).toHaveBeenCalledTimes(
          MAX_ATTACHMENTS_PER_TICKET,
        );
      });

      it('should reject more than the maximum attachments before creating anything', async () => {
        withTx();

        const oneTooMany = Array(MAX_ATTACHMENTS_PER_TICKET + 1).fill(validFile);

        await expectBoltpeError(
          service.createTicket(baseDto, ctx, oneTooMany),
          ErrorCode.VALIDATION_ERROR,
        );
        expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
      });

      // Reversed from the earlier behaviour on purpose: the PRD requires the
      // ticket and its attachment to be one transaction, so a failed upload
      // must leave no ticket behind for the customer to find later.
      it('should create no ticket when the upload fails', async () => {
        withTx();
        (S3UploadUtil.uploadTicketAttachment as jest.Mock).mockRejectedValue(new Error('S3 down'));

        await expectBoltpeError(
          service.createTicket(baseDto, ctx, [validFile]),
          ErrorCode.EXTERNAL_SERVICE_ERROR,
        );
        expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('ticket-created notification', () => {
      const withTx = () =>
        mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
          fn({
            ticket: { create: jest.fn().mockResolvedValue({ id: 'internal-1', ticketId: 'TKT-N1' }) },
            ticketSlaTimer: { create: jest.fn() },
            ticketMessage: { create: jest.fn() },
            ticketHistory: { create: jest.fn() },
            ticketAttachment: { createMany: jest.fn() },
          }),
        );

      it('should queue a notification carrying the ticket, category and SLA', async () => {
        withTx();

        await service.createTicket(baseDto, ctx);

        expect(mockNotificationQueue.queueTicketCreated).toHaveBeenCalledWith(
          expect.objectContaining({
            ticketId: 'TKT-N1',
            customerEmail: baseDto.contactEmailOverride,
            routingSkill: 'PAYMENT_SUPPORT',
            priorityLevel: 3,
            firstResponseHours: '8 hours',
            resolutionHours: '72 hours',
          }),
        );
      });

      // A notification must never cost a ticket the customer already raised.
      it('should still return the ticket when queueing the notification fails', async () => {
        withTx();
        mockNotificationQueue.queueTicketCreated.mockRejectedValueOnce(new Error('redis down'));

        await expect(service.createTicket(baseDto, ctx)).resolves.toMatchObject({
          data: expect.objectContaining({ ticketId: 'TKT-N1' }),
        });
      });

      it('should not queue a notification on an idempotent replay', async () => {
        mockPrismaService.ticket.findUnique.mockResolvedValue({
          id: 'internal-1',
          ticketId: 'TKT-REPLAY',
          attachments: [],
        });

        await service.createTicket(baseDto, ctx);

        expect(mockNotificationQueue.queueTicketCreated).not.toHaveBeenCalled();
      });
    });

    // A retired category must not accept new tickets, or customers could keep
    // filing against a category support has deliberately stopped offering.
    it('should reject a retired category even though the row still exists', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue({
        ...l1Mock,
        isActive: false,
      });

      await expectBoltpeError(
        service.createTicket(baseDto, ctx),
        ErrorCode.RESOURCE_NOT_FOUND,
      );
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
    });

    it('should throw BoltpeException when l1CategoryCode does not exist', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(null);

      await expectBoltpeError(
        service.createTicket(baseDto, ctx),
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });

    it('should throw BoltpeException when the customer has reached MAX_OPEN_TICKETS', async () => {
      mockPrismaService.ticket.count.mockResolvedValue(20);

      await expectBoltpeError(
        service.createTicket(baseDto, ctx),
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('should throw BoltpeException when a duplicate open ticket exists within the window', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({ ticketId: 'TKT-EXISTING' });

      await expectBoltpeError(
        service.createTicket(baseDto, ctx),
        ErrorCode.DUPLICATE_TRANSACTION,
      );
    });

    it('should skip the duplicate check entirely when duplicateOverride is true', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({ ticketId: 'TKT-EXISTING' });
      mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
        fn({
          ticket: {
            create: jest
              .fn()
              .mockResolvedValue({ id: 'internal-1', ticketId: 'TKT-BOLTPE-2609-PAY-ABC123' }),
          },
          ticketSlaTimer: { create: jest.fn() },
          ticketMessage: { create: jest.fn() },
            ticketHistory: { create: jest.fn() },
            ticketAttachment: { createMany: jest.fn() },
        }),
      );

      const dto = { ...baseDto, duplicateOverride: true };
      const result = await service.createTicket(dto, ctx);

      expect(result.data!.ticketId).toBe('TKT-BOLTPE-2609-PAY-ABC123');
    });

    it('should fall back to botCode "BOLTPE" when bot lookup returns null', async () => {
      mockPrismaService.botConfiguration.findUnique.mockResolvedValue(null);
      mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
        fn({
          ticket: { create: jest.fn().mockResolvedValue({ id: 'internal-1', ticketId: 'TKT-X' }) },
          ticketSlaTimer: { create: jest.fn() },
          ticketMessage: { create: jest.fn() },
            ticketHistory: { create: jest.fn() },
            ticketAttachment: { createMany: jest.fn() },
        }),
      );

      await service.createTicket(baseDto, ctx);

      expect(idGenerator.generateTicketId).toHaveBeenCalledWith('BOLTPE', 'PAY');
    });

    it('should create ticket, SLA timer, initial message and opening history inside one transaction', async () => {
      const txTicketCreate = jest.fn().mockResolvedValue({
        id: 'internal-1',
        ticketId: 'TKT-BOLTPE-2609-PAY-ABC123',
        priorityLevel: 3,
      });
      const txSlaCreate = jest.fn().mockResolvedValue({});
      const txMessageCreate = jest.fn().mockResolvedValue({});
      const txHistoryCreate = jest.fn().mockResolvedValue({});

      mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
        fn({
          ticket: { create: txTicketCreate },
          ticketSlaTimer: { create: txSlaCreate },
          ticketMessage: { create: txMessageCreate },
          ticketHistory: { create: txHistoryCreate },
          ticketAttachment: { createMany: jest.fn() },
        }),
      );

      const result = await service.createTicket(baseDto, ctx);

      expect(txTicketCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: 'TKT-BOLTPE-2609-PAY-ABC123',
            botId: 'bot-1',
            customerId: 'customer-1',
            creationSource: 'USER',
            priorityLevel: 3,
            l1CategoryCode: 'PAYMENT_TRANSACTION_ISSUE',
            routingSkill: 'PAYMENT_SUPPORT',
            wordCount: 10,
          }),
        }),
      );
      // The timeline must start at "raised", not at the first agent action,
      // and it must be written inside the same transaction as the ticket.
      expect(txHistoryCreate).toHaveBeenCalledWith({
        data: {
          ticketId: 'internal-1',
          oldStatus: null,
          newStatus: 'OPEN',
          changedBy: 'customer-1',
        },
      });
      expect(txSlaCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            targetFirstResponseSeconds: 8 * 3600,
            targetResolutionSeconds: 72 * 3600,
            slaApplicable: true,
          }),
        }),
      );
      expect(txMessageCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ senderType: 'CUSTOMER', content: baseDto.description }),
        }),
      );
      expect(result.data!.ticketId).toBe('TKT-BOLTPE-2609-PAY-ABC123');
    });

    it('should fall back to SLA band 3 when defaultPriority has no matching band', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue({
        ...l1Mock,
        defaultPriority: 99,
      });
      const txSlaCreate = jest.fn().mockResolvedValue({});
      mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
        fn({
          ticket: { create: jest.fn().mockResolvedValue({ id: 'internal-1', ticketId: 'TKT-X' }) },
          ticketSlaTimer: { create: txSlaCreate },
          ticketMessage: { create: jest.fn() },
            ticketHistory: { create: jest.fn() },
            ticketAttachment: { createMany: jest.fn() },
        }),
      );

      await service.createTicket(baseDto, ctx);

      expect(txSlaCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ targetFirstResponseSeconds: 8 * 3600 }),
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // getMyTickets
  // ───────────────────────────────────────────────────────────────────────
  describe('getMyTickets', () => {
    const tickets = [{ ticketId: 'TKT-001', status: 'OPEN' }];

    it('should return tickets scoped to customerId and botId, ordered by newest first', async () => {
      mockPrismaService.$transaction.mockResolvedValue([tickets, 1]);

      const result = await service.getMyTickets('customer-1', 'bot-1');

      expect(mockPrismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customerId: 'customer-1', botId: 'bot-1' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(result.data!.tickets).toEqual(tickets);
    });

    it('should default to page 1 with a limit of 20', async () => {
      mockPrismaService.$transaction.mockResolvedValue([tickets, 1]);

      const result = await service.getMyTickets('customer-1', 'bot-1');

      expect(mockPrismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result.data!.pagination).toEqual({ page: 1, limit: 20, total: 1, hasMore: false });
    });

    it('should translate page/limit into the correct skip and take', async () => {
      mockPrismaService.$transaction.mockResolvedValue([tickets, 100]);

      await service.getMyTickets('customer-1', 'bot-1', { page: 3, limit: 25 });

      expect(mockPrismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 25 }),
      );
    });

    it('should report hasMore true when further pages exist', async () => {
      mockPrismaService.$transaction.mockResolvedValue([tickets, 100]);

      const result = await service.getMyTickets('customer-1', 'bot-1', { page: 1, limit: 20 });

      expect(result.data!.pagination.hasMore).toBe(true);
    });

    it('should report hasMore false on the last page', async () => {
      mockPrismaService.$transaction.mockResolvedValue([tickets, 50]);

      const result = await service.getMyTickets('customer-1', 'bot-1', { page: 3, limit: 25 });

      expect(result.data!.pagination.hasMore).toBe(false);
    });

    it('should apply the optional filters to the where clause', async () => {
      mockPrismaService.$transaction.mockResolvedValue([tickets, 1]);

      await service.getMyTickets('customer-1', 'bot-1', {
        status: 'OPEN' as any,
        l1CategoryCode: 'PAYMENT',
        l2SubCategoryCode: 'FAILED_TXN',
      });

      expect(mockPrismaService.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            customerId: 'customer-1',
            botId: 'bot-1',
            status: 'OPEN',
            l1CategoryCode: 'PAYMENT',
            l2SubCategoryCode: 'FAILED_TXN',
          },
        }),
      );
    });

    it('should omit absent filters but always keep the ownership scope', async () => {
      mockPrismaService.$transaction.mockResolvedValue([tickets, 1]);

      await service.getMyTickets('customer-1', 'bot-1', { page: 1, limit: 20 });

      const where = mockPrismaService.ticket.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ customerId: 'customer-1', botId: 'bot-1' });
      expect(where).not.toHaveProperty('status');
    });

    it('should count using the same where clause as the page query', async () => {
      mockPrismaService.$transaction.mockResolvedValue([tickets, 1]);

      await service.getMyTickets('customer-1', 'bot-1', { status: 'RESOLVED' as any });

      expect(mockPrismaService.ticket.count).toHaveBeenCalledWith({
        where: { customerId: 'customer-1', botId: 'bot-1', status: 'RESOLVED' },
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // getTicketDetail
  // ───────────────────────────────────────────────────────────────────────
  describe('getTicketDetail', () => {
    it('should throw BoltpeException when ticket is not found or not owned', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(null);

      await expectBoltpeError(
        service.getTicketDetail('TKT-999', 'customer-1'),
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });

    it('should mask contactEmailOverride and contactMobileOverride when present', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        ticketId: 'TKT-001',
        contactEmailOverride: 'user@example.com',
        contactMobileOverride: '9876543210',
        messages: [],
      });

      const result = await service.getTicketDetail('TKT-001', 'customer-1');

      expect(piiMasker.maskEmail).toHaveBeenCalledWith('user@example.com');
      expect(piiMasker.maskMobile).toHaveBeenCalledWith('9876543210');
      expect(result.data!.contactEmailOverride).toBe('masked:user@example.com');
      expect(result.data!.contactMobileOverride).toBe('masked:9876543210');
    });

    it('should leave contact fields as null when not present on the ticket', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        ticketId: 'TKT-001',
        contactEmailOverride: null,
        contactMobileOverride: null,
        messages: [],
      });

      const result = await service.getTicketDetail('TKT-001', 'customer-1');

      expect(result.data!.contactEmailOverride).toBeNull();
      expect(result.data!.contactMobileOverride).toBeNull();
    });

    it('should include messages, slaTimer, attachments and the status timeline', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        ticketId: 'TKT-001',
        messages: [{ id: 'm1' }],
      });

      await service.getTicketDetail('TKT-001', 'customer-1');

      expect(mockPrismaService.ticket.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            messages: { orderBy: { createdAt: 'asc' } },
            slaTimer: true,
            attachments: true,
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
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // addMessage
  // ───────────────────────────────────────────────────────────────────────
  
  // ───────────────────────────────────────────────────────────────────────
  // addAttachments
  // ───────────────────────────────────────────────────────────────────────
  describe('addAttachments', () => {
    const validFile = {
      originalname: 'receipt.jpg',
      mimetype: 'image/jpeg',
      size: 1024 * 1024,
      buffer: Buffer.from('fake'),
    } as Express.Multer.File;

    it('should throw BoltpeException when no files are provided', async () => {
      await expectBoltpeError(
        service.addAttachments('TKT-001', [], 'customer-1'),
        ErrorCode.MISSING_REQUIRED_FIELD,
      );
      await expectBoltpeError(
        service.addAttachments('TKT-001', undefined as any, 'customer-1'),
        ErrorCode.MISSING_REQUIRED_FIELD,
      );
    });

    it('should throw BoltpeException when ticket is not found or not owned', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(null);

      await expectBoltpeError(
        service.addAttachments('TKT-999', [validFile], 'customer-1'),
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });

    it('should throw BoltpeException when adding would exceed MAX_ATTACHMENTS_PER_TICKET', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        id: 'internal-1',
        ticketId: 'TKT-001',
      });
      mockPrismaService.ticketAttachment.count.mockResolvedValue(MAX_ATTACHMENTS_PER_TICKET);

      await expectBoltpeError(
        service.addAttachments('TKT-001', [validFile], 'customer-1'),
        ErrorCode.VALIDATION_ERROR,
      );
      expect(S3UploadUtil.uploadTicketAttachment).not.toHaveBeenCalled();
    });

    it('should throw BoltpeException on a disallowed mime type before uploading anything', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        id: 'internal-1',
        ticketId: 'TKT-001',
      });
      mockPrismaService.ticketAttachment.count.mockResolvedValue(0);
      const badFile = { ...validFile, mimetype: 'application/zip' };

      await expectBoltpeError(
        service.addAttachments('TKT-001', [badFile], 'customer-1'),
        ErrorCode.INVALID_INPUT,
      );
      expect(S3UploadUtil.uploadTicketAttachment).not.toHaveBeenCalled();
    });

    it('should throw BoltpeException when a file exceeds MAX_FILE_SIZE_BYTES', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        id: 'internal-1',
        ticketId: 'TKT-001',
      });
      mockPrismaService.ticketAttachment.count.mockResolvedValue(0);
      const oversizedFile = { ...validFile, size: 6 * 1024 * 1024 };

      await expectBoltpeError(
        service.addAttachments('TKT-001', [oversizedFile], 'customer-1'),
        ErrorCode.INVALID_INPUT,
      );
      expect(S3UploadUtil.uploadTicketAttachment).not.toHaveBeenCalled();
    });

    it('should reject the whole batch if ANY file in it is invalid (all-or-nothing validation)', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        id: 'internal-1',
        ticketId: 'TKT-001',
      });
      mockPrismaService.ticketAttachment.count.mockResolvedValue(0);
      const badFile = { ...validFile, mimetype: 'application/zip' };

      await expectBoltpeError(
        service.addAttachments('TKT-001', [validFile, badFile], 'customer-1'),
        ErrorCode.INVALID_INPUT,
      );
      expect(S3UploadUtil.uploadTicketAttachment).not.toHaveBeenCalled();
    });

    it('should upload and persist each valid file', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        id: 'internal-1',
        ticketId: 'TKT-001',
      });
      mockPrismaService.ticketAttachment.count.mockResolvedValue(0);
      (S3UploadUtil.uploadTicketAttachment as jest.Mock).mockResolvedValue({
        url: 's3://bucket/key1.jpg',
      });
      mockPrismaService.ticketAttachment.create.mockResolvedValue({
        id: 'att-1',
        fileName: 'receipt.jpg',
        storageKey: 's3://bucket/key1.jpg',
      });

      const result = await service.addAttachments('TKT-001', [validFile], 'customer-1');

      expect(S3UploadUtil.uploadTicketAttachment).toHaveBeenCalledWith(validFile, 'internal-1');
      expect(mockPrismaService.ticketAttachment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ticketId: 'internal-1',
          fileName: 'receipt.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: validFile.size,
          storageKey: 's3://bucket/key1.jpg',
        }),
      });
      expect(result.data).toHaveLength(1);
    });

    it('should allow uploading up to the remaining attachment slots (e.g. 2 when 1 already exists)', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        id: 'internal-1',
        ticketId: 'TKT-001',
      });
      mockPrismaService.ticketAttachment.count.mockResolvedValue(1);
      (S3UploadUtil.uploadTicketAttachment as jest.Mock).mockResolvedValue({
        url: 's3://bucket/x.jpg',
      });
      mockPrismaService.ticketAttachment.create.mockResolvedValue({ id: 'att-x' });

      const secondFile = { ...validFile, originalname: 'proof2.jpg' };
      const result = await service.addAttachments('TKT-001', [validFile, secondFile], 'customer-1');

      expect(result.data).toHaveLength(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('withdrawTicket', () => {
    const base = { id: 'internal-1', ticketId: 'TKT-W1', status: 'OPEN' };

    const withTx = () =>
      mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
        fn({
          ticket: { update: jest.fn().mockResolvedValue({ ...base, status: 'WITHDRAWN' }) },
          ticketHistory: { create: mockTicketHistoryCreate },
        }),
      );

    it('should withdraw an open ticket and stamp the reason', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(base);
      const txUpdate = jest.fn().mockResolvedValue({ ...base, status: 'WITHDRAWN' });
      mockPrismaService.$transaction.mockImplementation(async (fn: any) =>
        fn({ ticket: { update: txUpdate }, ticketHistory: { create: mockTicketHistoryCreate } }),
      );

      const result = await service.withdrawTicket('TKT-W1', 'customer-1', {
        reason: 'Sorted it out myself.',
      });

      expect(txUpdate).toHaveBeenCalledWith({
        where: { ticketId: 'TKT-W1' },
        data: expect.objectContaining({
          status: 'WITHDRAWN',
          withdrawnAt: expect.any(Date),
          withdrawalReason: 'Sorted it out myself.',
        }),
      });
      expect(result.data).toMatchObject({ status: 'WITHDRAWN' });
    });

    it('should record the withdrawal in the ticket history', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(base);
      withTx();

      await service.withdrawTicket('TKT-W1', 'customer-1', { reason: 'No longer needed.' });

      expect(mockTicketHistoryCreate).toHaveBeenCalledWith({
        data: {
          ticketId: 'internal-1',
          oldStatus: 'OPEN',
          newStatus: 'WITHDRAWN',
          remark: 'No longer needed.',
          changedBy: 'customer-1',
        },
      });
    });

    it('should allow withdrawing without a reason', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(base);
      withTx();

      await service.withdrawTicket('TKT-W1', 'customer-1', {});

      expect(mockTicketHistoryCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ remark: null }),
      });
    });

    // Ownership is enforced by the query, so another customer's ticket simply
    // is not found — no information about its existence leaks.
    it('should 404 when the ticket belongs to someone else', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(null);

      await expectBoltpeError(
        service.withdrawTicket('TKT-W1', 'other-customer', {}),
        ErrorCode.RESOURCE_NOT_FOUND,
      );
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
    });

    it.each(['RESOLVED', 'CLOSED', 'WITHDRAWN'])(
      'should refuse to withdraw a %s ticket',
      async (status) => {
        mockPrismaService.ticket.findFirst.mockResolvedValue({ ...base, status });

        await expectBoltpeError(
          service.withdrawTicket('TKT-W1', 'customer-1', {}),
          ErrorCode.VALIDATION_ERROR,
        );
        expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
      },
    );

    it.each(['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'PENDING_PARTNER', 'REOPENED'])(
      'should allow withdrawing from %s',
      async (status) => {
        mockPrismaService.ticket.findFirst.mockResolvedValue({ ...base, status });
        withTx();

        await expect(
          service.withdrawTicket('TKT-W1', 'customer-1', {}),
        ).resolves.toMatchObject({ success: true });
      },
    );
  });
});
