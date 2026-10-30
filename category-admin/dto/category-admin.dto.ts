import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsInt,
  Min,
  Max,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Category codes are stored on every ticket as plain strings, not foreign keys,
 * so a code is permanent once used. `code` identifies the row on update and
 * delete, and can never itself be changed — renaming one would orphan
 * historical tickets.
 */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,49}$/;
const CODE_MESSAGE =
  'code must be 2-50 characters, uppercase letters, digits and underscores, starting with a letter';

/** Opts a boolean out of the global pipe's implicit conversion, which would turn any value into true. */
const strictBoolean = () =>
  Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  });

export enum CategoryAction {
  LIST = 'list',
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
}

/** Actions that address one existing category and therefore need a code. */
const NEEDS_CODE = [CategoryAction.CREATE, CategoryAction.UPDATE, CategoryAction.DELETE];

/**
 * A single request body covering all four category operations.
 *
 * `action` selects the operation; the remaining fields are validated only when
 * the chosen action actually uses them, so a `list` call needs nothing else and
 * a `delete` needs only the code.
 */
export class CategoryOperationDto {
  @ApiProperty({ enum: CategoryAction, example: CategoryAction.CREATE })
  @IsEnum(CategoryAction, {
    message: 'action must be one of: list, create, update, delete',
  })
  action!: CategoryAction;

  @ApiPropertyOptional({
    example: 'REWARDS',
    description: 'Required for create, update and delete. Never changes once set.',
  })
  @ValidateIf((o) => NEEDS_CODE.includes(o.action))
  @IsString()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  code?: string;

  @ApiPropertyOptional({
    example: 'Rewards',
    description: 'Required for create, optional on update. Shown to the customer.',
  })
  // Required on create; on update it is only checked when actually supplied,
  // so a PATCH-style call can leave it out but cannot set it to rubbish.
  @ValidateIf((o) => o.action === CategoryAction.CREATE || o.displayName !== undefined)
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  displayName?: string;

  @ApiPropertyOptional({ example: null, description: 'Bot UUID, or omit for a category shared by every bot.' })
  @IsOptional()
  @IsString()
  botId?: string;

  @ApiPropertyOptional({ example: true, description: 'Issues tied to a real transaction.' })
  @IsOptional()
  @Type(() => Object)
  @strictBoolean()
  @IsBoolean()
  isTransactional?: boolean;

  @ApiPropertyOptional({ example: 1, description: 'Display order in the picker.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ example: 'Payments', description: 'Agent queue this category routes to.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(2, 60)
  routingSkill?: string;

  @ApiPropertyOptional({ example: 2, description: 'Priority 1 (most urgent) to 4. Drives the SLA targets.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  defaultPriority?: number;

  @ApiPropertyOptional({ example: false, description: 'Exclude tickets in this category from auto-resolution.' })
  @IsOptional()
  @Type(() => Object)
  @strictBoolean()
  @IsBoolean()
  neverAutoResolve?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Update only. Set false to retire the category, true to bring it back.',
  })
  @IsOptional()
  @Type(() => Object)
  @strictBoolean()
  @IsBoolean()
  isActive?: boolean;
}
