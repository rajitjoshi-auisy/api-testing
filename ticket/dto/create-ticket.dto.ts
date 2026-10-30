import { IsString, IsNotEmpty, Length, IsEmail, Matches, IsOptional, IsBoolean, IsEnum, IsInt, Min, Max, ValidateIf } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { TicketStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MaxWords } from '../../../common/validators/max-words.validator';

// ─── GET /tickets/categories ───────────────────────────────────────────────
// No request DTO needed (no body, no params). Response shape below is for
// Swagger documentation only — the service returns Prisma rows directly.

export class IssueCategoryL1ResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  id!: string;

  @ApiProperty({ example: 'BOOKING_TRAVEL' })
  code!: string;

  @ApiProperty({ example: 'Booking and Travel' })
  displayName!: string;

  @ApiProperty({ example: false })
  isTransactional!: boolean;

  @ApiProperty({ example: 0 })
  sortOrder!: number;
}

export class IssueCategoryL2ResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  id!: string;

  @ApiProperty({ example: 'BOOKING_NOT_CONFIRMED' })
  code!: string;

  @ApiProperty({ example: 'Booking not confirmed/ not received' })
  displayName!: string;

  @ApiProperty({ example: 'Travel' })
  routingSkill!: string;

  @ApiProperty({ example: ['ORDER_STATUS', 'FLIGHT_PNR_NOT_RECEIVED'] })
  mappedIntents!: string[];

  @ApiProperty({ example: 3 })
  defaultPriority!: number;
}

export class CreateTicketDto {
  @ApiProperty({
    example: 'FLIGHT_BOOKING',
    description: 'Issue category code, from GET /tickets/categories.',
  })
  @IsString()
  @IsNotEmpty()
  l1CategoryCode!: string;

  @ApiProperty({
    example: 'Payment deducted but booking not confirmed even after 2 hours.',
    description: 'Any length up to 500 words. Must not be empty.',
  })
  @IsString()
  // No minimum length — a customer may describe the issue in a single word.
  // The character bound stops a single huge token slipping through as "one
  // word" past the word cap, which is the limit the PRD actually states.
  @Length(1, 5000, { message: 'Description must not be empty' })
  @MaxWords(500)
  description!: string;

    @ApiProperty({
    example: 'user@example.com',
    description: 'Contact email for this ticket (manually entered for now).',
  })
  // Optional: the PRD says a missing contact channel must not block the
  // ticket — we create it and skip that channel's acknowledgement instead.
  @IsOptional()
  @IsEmail({}, { message: 'contactEmailOverride must be a valid email' })
  contactEmailOverride?: string;

  @ApiProperty({
    example: '9876543210',
    description: 'Contact mobile for this ticket (manually entered for now).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[6-9]\d{9}$/, {
    message: 'contactMobileOverride must be a valid 10-digit Indian mobile number starting with 6-9',
  })
  contactMobileOverride?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'Set true to bypass the 24h duplicate-ticket check after the client confirms this is a distinct issue.',
  })
  // The global ValidationPipe runs with enableImplicitConversion, which would
  // coerce ANY value to a boolean — including 'false' and 'yes', both of which
  // would silently become true and skip the duplicate check. @Type(() => Object)
  // opts this field out of that coercion so @IsBoolean() actually rejects
  // non-boolean input; @Transform still accepts the 'true'/'false' strings a
  // form or query-string client may send.
  @IsOptional()
  @Type(() => Object)
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  duplicateOverride?: boolean;
}

export class GetMyTicketsDto {
  @ApiPropertyOptional({ enum: TicketStatus, example: TicketStatus.OPEN, description: 'Filter by ticket status.' })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiPropertyOptional({ example: 'PAYMENT', description: 'Filter by L1 category code.' })
  @IsOptional()
  @IsString()
  l1CategoryCode?: string;

  @ApiPropertyOptional({ example: 'FAILED_TXN', description: 'Filter by L2 sub-category code.' })
  @IsOptional()
  @IsString()
  l2SubCategoryCode?: string;

  @ApiPropertyOptional({ example: 1, description: 'Page number (1-indexed).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Rows per page, 1 to 100.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class WithdrawTicketDto {
  @ApiPropertyOptional({
    example: 'Sorted it out myself, no longer need help.',
    description: 'Optional. Shown on the ticket timeline.',
  })
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}
