import { IsString, IsNotEmpty, IsOptional, IsEnum, IsInt, Min, Max, Length, ValidateIf, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketStatus } from '@prisma/client';

export class GetAllTicketsDto {
  @ApiPropertyOptional({ enum: TicketStatus, example: TicketStatus.OPEN })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiPropertyOptional({ example: 'PAYMENT' })
  @IsOptional()
  @IsString()
  l1CategoryCode?: string;

  @ApiPropertyOptional({ example: 'FAILED_TXN' })
  @IsOptional()
  @IsString()
  l2SubCategoryCode?: string;

  @ApiPropertyOptional({ example: 'agent-uuid-here', description: 'Filter by assigned agent.' })
  @IsOptional()
  @IsString()
  assignedAgentId?: string;

  @ApiPropertyOptional({
    example: 'TKT-BOLTPE-2610-HTL-8MSRDV',
    description:
      'Free-text search across Ticket ID, mobile and email. Case-insensitive, matches partial values.',
  })
  @IsOptional()
  @IsString()
  @Length(2, 100)
  search?: string;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'Only tickets created on or after this date.' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'Only tickets created on or before this date.' })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional({ example: 1, description: 'Page number (1-indexed).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/**
 * Statuses the customer must be given a reason for. RESOLVED and CLOSED need a
 * resolution; the two On Hold states need to say what is being waited on.
 */
const REMARK_REQUIRED_STATUSES: TicketStatus[] = [
  TicketStatus.RESOLVED,
  TicketStatus.CLOSED,
  TicketStatus.PENDING_USER,
  TicketStatus.PENDING_PARTNER,
];

export class UpdateTicketStatusDto {
  @ApiProperty({ enum: TicketStatus, example: TicketStatus.RESOLVED })
  @IsEnum(TicketStatus)
  status!: TicketStatus;

  @ApiPropertyOptional({ example: 'REFUND_PROCESSED', description: 'Required when status is RESOLVED or CLOSED.' })
  @ValidateIf((o) => o.status === TicketStatus.RESOLVED || o.status === TicketStatus.CLOSED)
  @IsNotEmpty({ message: 'dispositionCode is required when resolving or closing a ticket' })
  @IsString()
  dispositionCode?: string;

  @ApiPropertyOptional({
    example: 'Refund of ₹500 processed to original payment method.',
    description:
      'User-facing remark. Mandatory when resolving or closing, and when putting a ticket on hold — the PRD requires the customer to be told what is being waited on.',
  })
  // On hold without a remark leaves the customer with "we are waiting" and no
  // idea what for, which the PRD explicitly rules out.
  @ValidateIf((o) => REMARK_REQUIRED_STATUSES.includes(o.status))
  @IsNotEmpty({
    message:
      'resolutionSummary is required when resolving, closing, or placing a ticket on hold',
  })
  @IsString()
  @Length(10, 2000)
  resolutionSummary?: string;

  @ApiPropertyOptional({
    example: 'Chased the PSP on ticket #4412; awaiting their confirmation.',
    description: 'Admin-only. Recorded in the ticket history and never shown to the customer.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  internalNote?: string;

  @ApiPropertyOptional({
    example: '2026-10-29T09:15:22.431Z',
    description:
      "The ticket's updatedAt as the console last read it. Supply it to be told when another agent has changed the ticket since, instead of silently overwriting them.",
  })
  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;
}

export class AssignTicketDto {
  @ApiPropertyOptional({
    example: 'agent-7',
    description: 'Staff user to assign the ticket to. Send null to unassign.',
  })
  // Explicitly nullable: null means "put it back in the pool", which is
  // different from omitting the field.
  @ValidateIf((o) => o.agentId !== null)
  @IsString()
  @IsNotEmpty()
  @Length(1, 100)
  agentId!: string | null;
}
