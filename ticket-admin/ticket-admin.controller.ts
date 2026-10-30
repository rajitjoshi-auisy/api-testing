import { Controller, Get, Patch, Post, Body, Param, Query, Headers, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TicketAdminService } from './ticket-admin.service';
import { AssignTicketDto, GetAllTicketsDto, UpdateTicketStatusDto } from './dto/ticket-admin.dto';
import { HttpJwtGuard } from '../../common/guards/http-jwt.guard';
import { StaffOnlyGuard } from '../../common/guards/staff-only.guard';

@ApiTags('Ticket Admin')
@ApiBearerAuth()
@Controller('ticket-admin')
@UseGuards(HttpJwtGuard)
export class TicketAdminController {
  constructor(private readonly ticketAdminService: TicketAdminService) {}

  @Get('all')
  @UseGuards(StaffOnlyGuard)
  @ApiOperation({ summary: 'List all tickets (agent/admin), filterable and paginated' })
  @ApiResponse({ status: 200, description: 'Tickets returned successfully' })
  @ApiResponse({ status: 403, description: 'Caller is not support staff' })
  async getAllTickets(@Query() query: GetAllTicketsDto) {
    return this.ticketAdminService.getAllTickets(query);
  }

  // Declared after 'all' so that literal path is not swallowed by :ticketId.
  @Get(':ticketId')
  @UseGuards(StaffOnlyGuard)
  @ApiOperation({
    summary: 'Get one ticket with its full history (agent/admin). Not scoped to an owner.',
  })
  @ApiParam({ name: 'ticketId', example: 'TKT-BOLTPE-2610-ACC-J5UUJV' })
  @ApiResponse({ status: 200, description: 'Ticket returned' })
  @ApiResponse({ status: 403, description: 'Caller is not support staff' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async getTicketById(@Param('ticketId') ticketId: string) {
    return this.ticketAdminService.getTicketById(ticketId);
  }

  @Patch(':ticketId/status')
  @UseGuards(StaffOnlyGuard)
  @ApiOperation({ summary: 'Update ticket status (agent/admin)' })
  @ApiParam({ name: 'ticketId', example: 'TKT-BOLTPE-2609-PAY-V3DP27' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({ status: 403, description: 'Caller is not support staff' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  @ApiResponse({ status: 500, description: 'VAL_001 — illegal status transition' })
  async updateTicketStatus(
    @Param('ticketId') ticketId: string,
    @Body() dto: UpdateTicketStatusDto,
    @Headers('x-user-id') changedBy: string,
  ) {
    return this.ticketAdminService.updateTicketStatus(ticketId, dto, changedBy);
  }

  @Patch(':ticketId/assign')
  @UseGuards(StaffOnlyGuard)
  @ApiOperation({ summary: 'Assign a ticket to an agent, or send null to unassign' })
  @ApiParam({ name: 'ticketId', example: 'TKT-BOLTPE-2610-HTL-8MSRDV' })
  @ApiResponse({ status: 200, description: 'Ticket assigned or unassigned' })
  @ApiResponse({ status: 403, description: 'Caller is not support staff' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async assignTicket(
    @Param('ticketId') ticketId: string,
    @Body() dto: AssignTicketDto,
    @Headers('x-user-id') changedBy: string,
  ) {
    return this.ticketAdminService.assignTicket(ticketId, dto, changedBy);
  }
}
