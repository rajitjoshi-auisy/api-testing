import { Test, TestingModule } from '@nestjs/testing';
import { TicketAdminController } from './ticket-admin.controller';
import { TicketAdminService } from './ticket-admin.service';
import { GetAllTicketsDto, UpdateTicketStatusDto } from './dto/ticket-admin.dto';

const mockTicketAdminService = {
  assignTicket: jest.fn(),
  getTicketById: jest.fn(),
  getAllTickets: jest.fn(),
  updateTicketStatus: jest.fn(),
};

describe('TicketAdminController', () => {
  let controller: TicketAdminController;
  let service: TicketAdminService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TicketAdminController],
      providers: [
        { provide: TicketAdminService, useValue: mockTicketAdminService },
      ],
    }).compile();

    controller = module.get<TicketAdminController>(TicketAdminController);
    service = module.get<TicketAdminService>(TicketAdminService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getAllTickets', () => {
    it('should call service.getAllTickets with the query params', async () => {
      const query: GetAllTicketsDto = { status: 'OPEN' as any, page: 1, limit: 20 };
      const mockResult = { success: true, data: { tickets: [], pagination: {} } };
      mockTicketAdminService.getAllTickets.mockResolvedValue(mockResult);

      const result = await controller.getAllTickets(query);

      expect(service.getAllTickets).toHaveBeenCalledWith(query);
      expect(result).toEqual(mockResult);
    });
  });

  describe('updateTicketStatus', () => {
    it('should call service.updateTicketStatus with ticketId, dto and the acting staff id', async () => {
      const dto: UpdateTicketStatusDto = {
        status: 'RESOLVED' as any,
        dispositionCode: 'REFUND_PROCESSED',
        resolutionSummary: 'Refund processed.',
      };
      const mockResult = { success: true, data: { ticketId: 'TKT-001', status: 'RESOLVED' } };
      mockTicketAdminService.updateTicketStatus.mockResolvedValue(mockResult);

      const result = await controller.updateTicketStatus('TKT-001', dto, 'agent-1');

      expect(service.updateTicketStatus).toHaveBeenCalledWith('TKT-001', dto, 'agent-1');
      expect(result).toEqual(mockResult);
    });
  });

  
  describe('getTicketById', () => {
    it('should pass the ticketId straight through', async () => {
      const mockResult = { success: true, data: { ticketId: 'TKT-001' } };
      mockTicketAdminService.getTicketById.mockResolvedValue(mockResult);

      const result = await controller.getTicketById('TKT-001');

      expect(service.getTicketById).toHaveBeenCalledWith('TKT-001');
      expect(result).toEqual(mockResult);
    });
  });

  describe('assignTicket', () => {
    it('should pass the ticketId, body and acting staff id through', async () => {
      mockTicketAdminService.assignTicket.mockResolvedValue({ success: true });

      await controller.assignTicket('TKT-001', { agentId: 'agent-7' }, 'supervisor-1');

      expect(service.assignTicket).toHaveBeenCalledWith(
        'TKT-001',
        { agentId: 'agent-7' },
        'supervisor-1',
      );
    });
  });
});
