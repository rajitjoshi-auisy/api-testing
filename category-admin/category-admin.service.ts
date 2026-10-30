import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { ApiResponse, AppLogger, ErrorCode, BoltpeException } from '@boltpe/shared';
import { CategoryAction, CategoryOperationDto } from './dto/category-admin.dto';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/** Body fields that are category columns — everything else selects the operation. */
const EDITABLE_FIELDS = [
  'displayName',
  'botId',
  'isTransactional',
  'sortOrder',
  'routingSkill',
  'defaultPriority',
  'neverAutoResolve',
  'isActive',
] as const;

/**
 * CRUD for the issue categories offered on the ticket form, behind one endpoint.
 *
 * Only the L1 level is managed here. IssueCategoryL2 rows still exist in the
 * database for the chatbot's intent classification, but they are not part of
 * raising a ticket and are deliberately not exposed by this module.
 */
@Injectable()
export class CategoryAdminService {
  private readonly logger = new AppLogger(
    'category-admin-service',
    process.env.NODE_ENV || 'development',
  );

  constructor(private readonly prisma: PrismaService) {}

  /** Single entry point — dispatches on dto.action. */
  async execute(dto: CategoryOperationDto) {
    switch (dto.action) {
      case CategoryAction.LIST:
        return this.list();
      case CategoryAction.CREATE:
        return this.create(dto);
      case CategoryAction.UPDATE:
        return this.update(dto);
      case CategoryAction.DELETE:
        return this.deactivate(dto);
      default:
        // The DTO's @IsEnum already rejects this; kept so an added action
        // cannot silently fall through to a success response.
        this.logger.warn('[CATEGORY-ADMIN] Unsupported action', { action: dto.action });
        throw new BoltpeException(ErrorCode.VALIDATION_ERROR);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Operations
  // ─────────────────────────────────────────────────────────────────────────

  /** Includes inactive rows, unlike the customer-facing picker. */
  private async list() {
    const categories = await this.prisma.issueCategoryL1.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    this.logger.info('[CATEGORY-ADMIN][LIST] Success', { count: categories.length });
    return ApiResponse.success(categories, 'Categories fetched');
  }

  private async create(dto: CategoryOperationDto) {
    this.logger.info('[CATEGORY-ADMIN][CREATE] Starting', { code: dto.code });

    const created = await this.prisma.issueCategoryL1
      .create({
        data: {
          code: dto.code!,
          displayName: dto.displayName!,
          botId: dto.botId ?? null,
          isTransactional: dto.isTransactional ?? false,
          sortOrder: dto.sortOrder ?? 0,
          routingSkill: dto.routingSkill ?? null,
          defaultPriority: dto.defaultPriority ?? 3,
          neverAutoResolve: dto.neverAutoResolve ?? false,
        },
      })
      .catch((error) => this.rethrowDuplicate(error, dto.code!));

    this.logger.info('[CATEGORY-ADMIN][CREATE] Success', { code: created.code });
    return ApiResponse.success(created, 'Category created');
  }

  private async update(dto: CategoryOperationDto) {
    await this.findOrThrow(dto.code!);

    const updated = await this.prisma.issueCategoryL1.update({
      where: { code: dto.code },
      data: this.editableFields(dto),
    });

    this.logger.info('[CATEGORY-ADMIN][UPDATE] Success', { code: dto.code });
    return ApiResponse.success(updated, 'Category updated');
  }

  /**
   * Retires a category.
   *
   * Deactivation, not deletion: tickets record `l1CategoryCode` as a plain
   * string, so removing the row would orphan every historical ticket in this
   * category. The customer-facing picker already filters on `isActive`, so a
   * retired category disappears from the form while old tickets stay intact.
   */
  private async deactivate(dto: CategoryOperationDto) {
    await this.findOrThrow(dto.code!);

    const updated = await this.prisma.issueCategoryL1.update({
      where: { code: dto.code },
      data: { isActive: false },
    });

    this.logger.info('[CATEGORY-ADMIN][DEACTIVATE] Success', { code: dto.code });
    return ApiResponse.success(updated, 'Category deactivated');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async findOrThrow(code: string) {
    const category = await this.prisma.issueCategoryL1.findUnique({ where: { code } });
    if (!category) {
      this.logger.warn('[CATEGORY-ADMIN] Not found', { code });
      throw new BoltpeException(ErrorCode.RESOURCE_NOT_FOUND);
    }
    return category;
  }

  /**
   * Picks out the category columns the caller actually supplied.
   *
   * Two jobs: an update writes only the fields present in the body, and
   * `action` and `code` never reach the database — `code` identifies the row
   * and must stay fixed, since tickets reference it as a plain string.
   */
  private editableFields(dto: CategoryOperationDto) {
    return Object.fromEntries(
      EDITABLE_FIELDS.filter((key) => dto[key] !== undefined).map((key) => [key, dto[key]]),
    );
  }

  /** Turns Prisma's unique-constraint error into a 409 rather than a 500. */
  private rethrowDuplicate(error: unknown, code: string): never {
    if ((error as { code?: string })?.code === UNIQUE_VIOLATION) {
      this.logger.warn('[CATEGORY-ADMIN] Code already exists', { code });
      throw new BoltpeException(ErrorCode.DUPLICATE_TRANSACTION);
    }
    throw error;
  }
}
