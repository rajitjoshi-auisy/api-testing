import { Test, TestingModule } from '@nestjs/testing';
import { TicketController } from './ticket.controller';
import { TicketService } from './ticket.service';
import { CreateTicketDto } from './dto/create-ticket.dto';

const mockTicketService = {
  getL1Categories: jest.fn(),
  createTicket: jest.fn(),
  getMyTickets: jest.fn(),
  getTicketDetail: jest.fn(),
  addMessage: jest.fn(),
  addAttachments: jest.fn(),
};

/** HttpJwtGuard puts the resolved display name on the request. */
const REQUEST_WITH_NAME = { user: { customerName: 'Rajit Joshi' } } as any;

describe('TicketController', () => {
  let controller: TicketController;
  let service: TicketService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketController],
      providers: [{ provide: TicketService, useValue: mockTicketService }],
    }).compile();

    controller = module.get<TicketController>(TicketController);
    service = module.get<TicketService>(TicketService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getL1Categories', () => {
    it('should call service.getL1Categories with botId from header', async () => {
      const mockResult = { success: true, data: [] };
      mockTicketService.getL1Categories.mockResolvedValue(mockResult);

      const result = await controller.getL1Categories('bot-1');

      expect(service.getL1Categories).toHaveBeenCalledWith('bot-1');
      expect(result).toEqual(mockResult);
    });

    it('should work when botId header is omitted', async () => {
      mockTicketService.getL1Categories.mockResolvedValue({ success: true, data: [] });

      await controller.getL1Categories(undefined);

      expect(service.getL1Categories).toHaveBeenCalledWith(undefined);
    });
  });

  describe('createTicket', () => {
    it('should call service.createTicket with dto and assembled ctx', async () => {
      const dto: CreateTicketDto = {
        l1CategoryCode: 'PAYMENT_TRANSACTION_ISSUE',
        description: 'Payment deducted but booking not confirmed.',
        contactEmailOverride: 'user@example.com',
        contactMobileOverride: '9876543210',
      };
      const mockResult = { success: true, data: { ticketId: 'TKT-001' } };
      mockTicketService.createTicket.mockResolvedValue(mockResult);

      const result = await controller.createTicket(dto, [], 'idem-1', 'customer-1', 'bot-1', REQUEST_WITH_NAME);

      expect(service.createTicket).toHaveBeenCalledWith(
        dto,
        {
          customerId: 'customer-1',
          botId: 'bot-1',
          idempotencyKey: 'idem-1',
          customerName: 'Rajit Joshi',
        },
        [],
      );
      expect(result).toEqual(mockResult);
    });

    it('should forward uploaded files so a ticket and its attachments are one call', async () => {
      const dto = {
        l1CategoryCode: 'PAYMENT_TRANSACTION_ISSUE',
        description: 'Payment deducted but booking not confirmed.',
        contactEmailOverride: 'user@example.com',
        contactMobileOverride: '9876543210',
      } as CreateTicketDto;
      const files = [
        { originalname: 'receipt.jpg', mimetype: 'image/jpeg', size: 2048 } as Express.Multer.File,
      ];
      mockTicketService.createTicket.mockResolvedValue({ success: true, data: {} });

      await controller.createTicket(dto, files, 'idem-1', 'customer-1', 'bot-1', REQUEST_WITH_NAME);

      expect(service.createTicket).toHaveBeenCalledWith(
        dto,
        expect.any(Object),
        files,
      );
    });

    it('should pass an empty array when no files are attached (JSON request)', async () => {
      const dto = { l1CategoryCode: 'X', description: 'y'.repeat(12) } as CreateTicketDto;
      mockTicketService.createTicket.mockResolvedValue({ success: true, data: {} });

      await controller.createTicket(dto, undefined as any, 'idem-1', 'customer-1', 'bot-1', REQUEST_WITH_NAME);

      expect(service.createTicket).toHaveBeenCalledWith(dto, expect.any(Object), []);
    });
  });

  describe('getMyTickets', () => {
    it('should call service.getMyTickets with headers and the query filters', async () => {
      const mockResult = { success: true, data: { tickets: [], pagination: {} } };
      mockTicketService.getMyTickets.mockResolvedValue(mockResult);
      const query = { status: 'OPEN' as any, page: 2, limit: 10 };

      const result = await controller.getMyTickets(query, 'customer-1', 'bot-1');

      expect(service.getMyTickets).toHaveBeenCalledWith('customer-1', 'bot-1', query);
      expect(result).toEqual(mockResult);
    });

    it('should pass an empty query through when no filters are supplied', async () => {
      mockTicketService.getMyTickets.mockResolvedValue({ success: true, data: {} });

      await controller.getMyTickets({}, 'customer-1', 'bot-1');

      expect(service.getMyTickets).toHaveBeenCalledWith('customer-1', 'bot-1', {});
    });
  });

  describe('getTicketDetail', () => {
    it('should call service.getTicketDetail with ticketId param and customerId header', async () => {
      const mockResult = { success: true, data: { ticketId: 'TKT-001' } };
      mockTicketService.getTicketDetail.mockResolvedValue(mockResult);

      const result = await controller.getTicketDetail('TKT-001', 'customer-1');

      expect(service.getTicketDetail).toHaveBeenCalledWith('TKT-001', 'customer-1');
      expect(result).toEqual(mockResult);
    });
  });

  
  describe('addAttachments', () => {
    it('should call service.addAttachments with ticketId, files, and customerId', async () => {
      const files = [
        { originalname: 'receipt.jpg', mimetype: 'image/jpeg', size: 1024 } as Express.Multer.File,
      ];
      const mockResult = { success: true, data: [{ id: 'att-1' }] };
      mockTicketService.addAttachments.mockResolvedValue(mockResult);

      const result = await controller.addAttachments('TKT-001', files, 'customer-1');

      expect(service.addAttachments).toHaveBeenCalledWith('TKT-001', files, 'customer-1');
      expect(result).toEqual(mockResult);
    });
  });
});