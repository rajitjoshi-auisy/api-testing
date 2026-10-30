import { Test, TestingModule } from '@nestjs/testing';
import { CategoryAdminController } from './category-admin.controller';
import { CategoryAdminService } from './category-admin.service';
import { CategoryAction } from './dto/category-admin.dto';

const mockService = { execute: jest.fn() };

describe('CategoryAdminController', () => {
  let controller: CategoryAdminController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CategoryAdminController],
      providers: [{ provide: CategoryAdminService, useValue: mockService }],
    }).compile();
    controller = module.get<CategoryAdminController>(CategoryAdminController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should pass the whole body through to the service', async () => {
    const dto = { action: CategoryAction.CREATE, code: 'REWARDS', displayName: 'Rewards' };
    mockService.execute.mockResolvedValue({ success: true, data: dto });

    const result = await controller.execute(dto as any);

    expect(mockService.execute).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ success: true, data: dto });
  });

  it.each([
    CategoryAction.LIST,
    CategoryAction.CREATE,
    CategoryAction.UPDATE,
    CategoryAction.DELETE,
  ])('should route the %s action through the same handler', async (action) => {
    mockService.execute.mockResolvedValue({ success: true });

    await controller.execute({ action, code: 'REWARDS' } as any);

    expect(mockService.execute).toHaveBeenCalledWith({ action, code: 'REWARDS' });
  });

  // All four operations live behind one POST — there are no per-verb handlers.
  it('should expose no other handlers', () => {
    expect((controller as any).list).toBeUndefined();
    expect((controller as any).create).toBeUndefined();
    expect((controller as any).update).toBeUndefined();
    expect((controller as any).deactivate).toBeUndefined();
  });
});
