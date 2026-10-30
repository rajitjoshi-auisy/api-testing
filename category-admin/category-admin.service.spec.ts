import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma.service';
import { CategoryAdminService } from './category-admin.service';
import { CategoryAction } from './dto/category-admin.dto';
import { BoltpeException, ErrorCode } from '@boltpe/shared';

const mockPrismaService = {
  issueCategoryL1: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

/**
 * Asserts the promise rejects with a BoltpeException carrying the expected
 * ErrorCode — every branch throws the same class, so the class alone proves little.
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

const CATEGORY = {
  id: 'cat-uuid',
  code: 'REWARDS',
  displayName: 'Rewards',
  routingSkill: 'General',
  defaultPriority: 3,
  isActive: true,
};

describe('CategoryAdminService', () => {
  let service: CategoryAdminService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryAdminService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();
    service = module.get<CategoryAdminService>(CategoryAdminService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('list', () => {
    it('should return categories including retired ones', async () => {
      mockPrismaService.issueCategoryL1.findMany.mockResolvedValue([CATEGORY]);

      const result = await service.execute({ action: CategoryAction.LIST });

      // No isActive filter: the admin view must show retired categories too.
      const args = mockPrismaService.issueCategoryL1.findMany.mock.calls[0][0];
      expect(args.where).toBeUndefined();
      expect(result.data).toEqual([CATEGORY]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('should create with the supplied values', async () => {
      mockPrismaService.issueCategoryL1.create.mockResolvedValue(CATEGORY);

      await service.execute({
        action: CategoryAction.CREATE,
        code: 'REWARDS',
        displayName: 'Rewards',
        isTransactional: true,
        sortOrder: 3,
        routingSkill: 'General',
        defaultPriority: 2,
        neverAutoResolve: true,
      });

      expect(mockPrismaService.issueCategoryL1.create).toHaveBeenCalledWith({
        data: {
          code: 'REWARDS',
          displayName: 'Rewards',
          botId: null,
          isTransactional: true,
          sortOrder: 3,
          routingSkill: 'General',
          defaultPriority: 2,
          neverAutoResolve: true,
        },
      });
    });

    // Tickets route using these fields, so a category created without them must
    // still be usable — it falls back to triage at priority 3.
    it('should default botId, the flags and the routing fields', async () => {
      mockPrismaService.issueCategoryL1.create.mockResolvedValue(CATEGORY);

      await service.execute({ action: CategoryAction.CREATE, code: 'LOANS', displayName: 'Loans' });

      expect(mockPrismaService.issueCategoryL1.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          botId: null,
          isTransactional: false,
          sortOrder: 0,
          routingSkill: null,
          defaultPriority: 3,
          neverAutoResolve: false,
        }),
      });
    });

    it('should turn a duplicate code into a conflict rather than a 500', async () => {
      mockPrismaService.issueCategoryL1.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );

      await expectBoltpeError(
        service.execute({ action: CategoryAction.CREATE, code: 'REWARDS', displayName: 'Rewards' }),
        ErrorCode.DUPLICATE_TRANSACTION,
      );
    });

    it('should re-throw a database error that is not a duplicate', async () => {
      mockPrismaService.issueCategoryL1.create.mockRejectedValue(
        Object.assign(new Error('connection lost'), { code: 'P1001' }),
      );

      await expect(
        service.execute({ action: CategoryAction.CREATE, code: 'REWARDS', displayName: 'Rewards' }),
      ).rejects.toThrow('connection lost');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('should write only the fields actually supplied', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(CATEGORY);
      mockPrismaService.issueCategoryL1.update.mockResolvedValue(CATEGORY);

      await service.execute({ action: CategoryAction.UPDATE, code: 'REWARDS', displayName: 'Rewards and Offers' });

      expect(mockPrismaService.issueCategoryL1.update).toHaveBeenCalledWith({
        where: { code: 'REWARDS' },
        data: { displayName: 'Rewards and Offers' },
      });
    });

    it('should allow changing the routing queue and priority', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(CATEGORY);
      mockPrismaService.issueCategoryL1.update.mockResolvedValue(CATEGORY);

      await service.execute({ action: CategoryAction.UPDATE, code: 'REWARDS', routingSkill: 'Lending', defaultPriority: 1 });

      expect(mockPrismaService.issueCategoryL1.update).toHaveBeenCalledWith({
        where: { code: 'REWARDS' },
        data: { routingSkill: 'Lending', defaultPriority: 1 },
      });
    });

    it('should allow bringing a retired category back', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue({
        ...CATEGORY,
        isActive: false,
      });
      mockPrismaService.issueCategoryL1.update.mockResolvedValue(CATEGORY);

      await service.execute({ action: CategoryAction.UPDATE, code: 'REWARDS', isActive: true });

      expect(mockPrismaService.issueCategoryL1.update).toHaveBeenCalledWith({
        where: { code: 'REWARDS' },
        data: { isActive: true },
      });
    });

    it('should 404 on an unknown code', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(null);

      await expectBoltpeError(
        service.execute({ action: CategoryAction.UPDATE, code: 'NOPE', displayName: 'x' }),
        ErrorCode.RESOURCE_NOT_FOUND,
      );
      expect(mockPrismaService.issueCategoryL1.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  describe('deactivate', () => {
    it('should deactivate rather than delete', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(CATEGORY);
      mockPrismaService.issueCategoryL1.update.mockResolvedValue({
        ...CATEGORY,
        isActive: false,
      });

      const result = await service.execute({ action: CategoryAction.DELETE, code: 'REWARDS' });

      expect(mockPrismaService.issueCategoryL1.update).toHaveBeenCalledWith({
        where: { code: 'REWARDS' },
        data: { isActive: false },
      });
      expect(result.data).toMatchObject({ isActive: false });
    });

    // Tickets store the code as a plain string, so a hard delete would orphan them.
    it('should never issue a real delete', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(CATEGORY);
      mockPrismaService.issueCategoryL1.update.mockResolvedValue(CATEGORY);

      await service.execute({ action: CategoryAction.DELETE, code: 'REWARDS' });

      expect((mockPrismaService.issueCategoryL1 as any).delete).toBeUndefined();
    });

    // L2 belongs to the chatbot now — retiring a ticket category must not reach
    // into data this module no longer owns.
    it('should not touch sub-categories', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(CATEGORY);
      mockPrismaService.issueCategoryL1.update.mockResolvedValue(CATEGORY);

      await service.execute({ action: CategoryAction.DELETE, code: 'REWARDS' });

      expect((mockPrismaService as any).issueCategoryL2).toBeUndefined();
    });

    it('should 404 on an unknown code', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(null);

      await expectBoltpeError(service.execute({ action: CategoryAction.DELETE, code: 'NOPE' }), ErrorCode.RESOURCE_NOT_FOUND);
      expect(mockPrismaService.issueCategoryL1.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Risks specific to routing every operation through one body
  // ───────────────────────────────────────────────────────────────────────
  describe('dispatch', () => {
    // `action` is a control field and `code` identifies the row. Neither is a
    // column the caller may write — code especially, since tickets reference
    // it as a plain string and renaming one would orphan them.
    it('should never write action or code to the database', async () => {
      mockPrismaService.issueCategoryL1.findUnique.mockResolvedValue(CATEGORY);
      mockPrismaService.issueCategoryL1.update.mockResolvedValue(CATEGORY);

      await service.execute({
        action: CategoryAction.UPDATE,
        code: 'REWARDS',
        displayName: 'Rewards and Offers',
        routingSkill: 'Lending',
      });

      const data = mockPrismaService.issueCategoryL1.update.mock.calls[0][0].data;
      expect(data).toEqual({ displayName: 'Rewards and Offers', routingSkill: 'Lending' });
      expect(data).not.toHaveProperty('action');
      expect(data).not.toHaveProperty('code');
    });

    it('should reject an unknown action rather than succeeding silently', async () => {
      await expectBoltpeError(
        service.execute({ action: 'archive' as any, code: 'REWARDS' }),
        ErrorCode.VALIDATION_ERROR,
      );
      expect(mockPrismaService.issueCategoryL1.update).not.toHaveBeenCalled();
      expect(mockPrismaService.issueCategoryL1.create).not.toHaveBeenCalled();
    });

    it('should not require a code for the list action', async () => {
      mockPrismaService.issueCategoryL1.findMany.mockResolvedValue([CATEGORY]);

      const result = await service.execute({ action: CategoryAction.LIST });

      expect(result.data).toEqual([CATEGORY]);
      expect(mockPrismaService.issueCategoryL1.findUnique).not.toHaveBeenCalled();
    });
  });
});
