import { Controller, Get, Post, Body, Param, Query, Headers, HttpCode, HttpStatus, UseGuards, UseInterceptors, UploadedFiles, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiConsumes } from '@nestjs/swagger';
import { TicketService, MAX_ATTACHMENTS_PER_TICKET, MAX_FILE_SIZE_BYTES } from './ticket.service';
import {
  CreateTicketDto,
  GetMyTicketsDto,
  WithdrawTicketDto,
} from './dto/create-ticket.dto';
import { FilesInterceptor } from '@nestjs/platform-express'; 
import { memoryStorage } from 'multer';
import { HttpJwtGuard } from '../../common/guards/http-jwt.guard';


@ApiTags('Tickets')
@ApiBearerAuth()
@Controller('tickets')
@UseGuards(HttpJwtGuard)
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  @Get('categories')
  @ApiOperation({ summary: 'List active L1 issue categories for the category picker' })
  @ApiResponse({ status: 200, description: 'L1 categories returned successfully' })
  async getL1Categories(@Headers('x-bot-id') botId?: string) {
    return this.ticketService.getL1Categories(botId);
  }

    @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Raise a new ticket, optionally with attachments in the same call',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  // Accepts both content types. Send JSON for a ticket with no files, or
  // multipart/form-data with a repeated `file` field to create the ticket and
  // upload its attachments in one request. Multer leaves JSON bodies untouched,
  // so existing JSON clients are unaffected.
  @UseInterceptors(
    FilesInterceptor('file', MAX_ATTACHMENTS_PER_TICKET, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_ATTACHMENTS_PER_TICKET },
    }),
  )
  async createTicket(
    @Body() dto: CreateTicketDto,
    @UploadedFiles() files: Express.Multer.File[],
    @Headers('x-idempotency-key') idempotencyKey: string,
    @Headers('x-user-id') customerId: string,
    @Headers('x-bot-id') botId: string,
    @Req() request: Request,
  ) {
    // HttpJwtGuard has already resolved the display name from the JWT.
    const customerName = (request.user as { customerName?: string } | undefined)?.customerName;
    return this.ticketService.createTicket(
      dto,
      { customerId, botId, idempotencyKey, customerName },
      files ?? [],
    );
  }

    @Get()
  @ApiOperation({ summary: 'List the logged-in customer\'s tickets (My Tickets)' })
  @ApiResponse({ status: 200, description: 'Tickets returned successfully' })
  async getMyTickets(
    @Query() query: GetMyTicketsDto,
    @Headers('x-user-id') customerId: string,
    @Headers('x-bot-id') botId: string,
  ) {
    return this.ticketService.getMyTickets(customerId, botId, query);
  }

    @Get(':ticketId')
  @ApiOperation({ summary: 'Get full ticket detail + conversation thread' })
  @ApiParam({ name: 'ticketId', example: 'TKT-BOLTPE-2609-PAY-V3DP27' })
  @ApiResponse({ status: 200, description: 'Ticket detail returned' })
  @ApiResponse({ status: 404, description: 'Ticket not found or not owned by requester' })
  async getTicketDetail(
    @Param('ticketId') ticketId: string,
    @Headers('x-user-id') customerId: string,
  ) {
    return this.ticketService.getTicketDetail(ticketId, customerId);
  }
    @Post(':ticketId/withdraw')
  // Changes an existing ticket rather than creating anything, so 200 not 201.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw your own ticket. Terminal — it cannot be reopened.' })
  @ApiParam({ name: 'ticketId', example: 'TKT-BOLTPE-2610-REW-A48484' })
  @ApiResponse({ status: 200, description: 'Ticket withdrawn' })
  @ApiResponse({ status: 404, description: 'Ticket not found or not owned by requester' })
  @ApiResponse({ status: 500, description: 'VAL_001 — ticket is already resolved, closed or withdrawn' })
  async withdrawTicket(
    @Param('ticketId') ticketId: string,
    @Body() dto: WithdrawTicketDto,
    @Headers('x-user-id') customerId: string,
  ) {
    return this.ticketService.withdrawTicket(ticketId, customerId, dto);
  }

  @Post(':ticketId/attachments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload one or more attachments to an existing ticket' })
  @ApiParam({ name: 'ticketId', example: 'TKT-BOLTPE-2609-PAY-V3DP27' })
  @ApiConsumes('multipart/form-data')
  // fileSize is enforced here as well as in the service: without it multer
  // buffers the whole upload into memory before the service can reject it.
  @UseInterceptors(
    FilesInterceptor('file', MAX_ATTACHMENTS_PER_TICKET, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_ATTACHMENTS_PER_TICKET },
    }),
  )
  async addAttachments(
    @Param('ticketId') ticketId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Headers('x-user-id') customerId: string,
  ) {
    return this.ticketService.addAttachments(ticketId, files, customerId);
  }
}