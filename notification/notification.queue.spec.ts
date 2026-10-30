import { ConfigService } from '@nestjs/config';
import { NotificationQueue, TicketCreatedJob, TicketStatusChangedJob } from './notification.queue';

// ── stand-ins for the two external systems ───────────────────────────────
const mockAddJob = jest.fn();
const mockCreateWorker = jest.fn();
const mockClose = jest.fn();

jest.mock('@boltpe/shared', () => {
  const actual = jest.requireActual('@boltpe/shared');
  return {
    ...actual,
    QueueService: jest.fn().mockImplementation(() => ({
      addJob: mockAddJob,
      createWorker: mockCreateWorker,
      close: mockClose,
    })),
  };
});

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const CONFIG: Record<string, any> = {
  'redis.host': 'localhost',
  'redis.port': 6379,
  'smtp.host': 'smtp.example.com',
  'smtp.port': 587,
  'smtp.secure': false,
  'smtp.user': 'noreply@boltpe.test',
  'smtp.pass': 'secret',
  'smtp.supportEmail': 'support-inbox@boltpe.test',
  'ticket.adminPanelUrl': 'https://controldev.boltpe.money/dashboard',
};

const job: TicketCreatedJob = {
  ticketId: 'TKT-BOLTPE-2610-GEN-ABC123',
  customerEmail: 'customer@example.com',
  customerName: 'Rajit Joshi',
  customerMobile: '9876543210',
  categoryName: 'Payment failed',
  routingSkill: 'Payments',
  priorityLevel: 2,
  firstResponseHours: '2 hours',
  resolutionHours: '24 hours',
};

function build(overrides: Record<string, any> = {}) {
  const config = {
    get: jest.fn((key: string) => ({ ...CONFIG, ...overrides })[key]),
  } as unknown as ConfigService;
  return new NotificationQueue(config);
}

describe('NotificationQueue', () => {
  let queue: NotificationQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAddJob.mockResolvedValue(undefined);
    mockSendMail.mockResolvedValue({ messageId: 'x' });
    queue = build();
  });

  it('should be defined', () => {
    expect(queue).toBeDefined();
  });

  describe('queueTicketCreated', () => {
    it('should enqueue a ticket-created job with retry and backoff', async () => {
      await queue.queueTicketCreated(job);

      expect(mockAddJob).toHaveBeenCalledWith(
        'support-notifications',
        'ticket-created',
        job,
        expect.objectContaining({
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        }),
      );
    });

    // The whole point of the design: a notification must never cost a ticket.
    it('should swallow a queue failure rather than throwing at the caller', async () => {
      mockAddJob.mockRejectedValue(new Error('redis unreachable'));

      await expect(queue.queueTicketCreated(job)).resolves.toBeUndefined();
    });

    it('should never put the customer email in a log line', async () => {
      const logger = (queue as any).logger;
      const info = jest.spyOn(logger, 'info');
      const error = jest.spyOn(logger, 'error');
      mockAddJob.mockRejectedValue(new Error('redis unreachable'));

      await queue.queueTicketCreated(job);
      await queue.queueTicketCreated({ ...job });

      const logged = JSON.stringify([info.mock.calls, error.mock.calls]);
      expect(logged).not.toContain('customer@example.com');
      expect(logged).toContain('TKT-BOLTPE-2610-GEN-ABC123');
    });
  });

  describe('sending', () => {
    // Reaches the private processor the worker would invoke.
    const send = (q: NotificationQueue, data: TicketCreatedJob = job) =>
      (q as any).sendTicketCreated(data);

    it('should link the agent straight to the ticket', async () => {
      await send(queue);

      expect(JSON.stringify(mockSendMail.mock.calls[1][0])).toContain(
        'https://controldev.boltpe.money/dashboard/tickets/TKT-BOLTPE-2610-GEN-ABC123',
      );
    });

    // A broken href in front of every agent is worse than no link at all.
    it('should omit the link when no admin panel URL is configured', async () => {
      const q = build({ 'ticket.adminPanelUrl': undefined });

      await send(q);

      const admin = JSON.stringify(mockSendMail.mock.calls[1][0]);
      expect(admin).not.toContain('<a href');
      expect(admin).toContain('TKT-BOLTPE-2610-GEN-ABC123');
    });

    it('should fall back to a generic subject when the JWT carried no name', async () => {
      await send(queue, { ...job, customerName: '' });

      expect(mockSendMail.mock.calls[1][0].subject).toBe(
        'New support ticket raised — TKT-BOLTPE-2610-GEN-ABC123',
      );
    });

    it('should email the customer and the support inbox', async () => {
      await send(queue);

      expect(mockSendMail).toHaveBeenCalledTimes(2);
      const [customer, admin] = mockSendMail.mock.calls.map((c) => c[0]);
      expect(customer.to).toBe('customer@example.com');
      expect(admin.to).toBe('support-inbox@boltpe.test');
    });

    it('should put the ticket id in both subjects or bodies', async () => {
      await send(queue);

      const [customer, admin] = mockSendMail.mock.calls.map((c) => c[0]);
      expect(customer.text).toContain(job.ticketId);
      // Ticket emails are plain-text notices, not branded HTML.
      expect(customer.html).toBeUndefined();
      expect(admin.subject).toContain(job.ticketId);
    });

    // Internal alert deliberately carries no customer contact details.
    // The PRD requires the internal alert to carry the customer's contact
    // details so an agent can act without opening the console first. This is
    // the ONLY ticket email that may contain them.
    it('should include the customer name, mobile and email in the admin alert', async () => {
      await send(queue);

      const admin = JSON.stringify(mockSendMail.mock.calls[1][0]);
      expect(admin).toContain('Rajit Joshi');
      expect(admin).toContain('9876543210');
      expect(admin).toContain('customer@example.com');
    });

    it('should title the admin alert with the customer name', async () => {
      await send(queue);

      expect(mockSendMail.mock.calls[1][0].subject).toBe(
        'Rajit Joshi has raised a ticket — TKT-BOLTPE-2610-GEN-ABC123',
      );
    });

    // The customer already knows who they are; repeating their mobile number
    // back to them only widens where that data ends up.
    it('should keep the customer mobile out of the customer-facing email', async () => {
      await send(queue);

      expect(JSON.stringify(mockSendMail.mock.calls[0][0])).not.toContain('9876543210');
    });

    it('should still send the customer email when SUPPORT_EMAIL is unset', async () => {
      const q = build({ 'smtp.supportEmail': undefined });

      await send(q);

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      expect(mockSendMail.mock.calls[0][0].to).toBe('customer@example.com');
    });

    it('should let a send failure propagate so BullMQ retries it', async () => {
      mockSendMail.mockRejectedValue(new Error('smtp refused'));

      await expect(send(queue)).rejects.toThrow('smtp refused');
    });
  });

  describe('lifecycle', () => {
    it('should start a worker on module init', () => {
      queue.onModuleInit();

      expect(mockCreateWorker).toHaveBeenCalledWith(
        'support-notifications',
        expect.any(Function),
        5,
      );
    });

    it('should close the queue on module destroy', async () => {
      await queue.onModuleDestroy();

      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('queueStatusChanged', () => {
    const statusJob: TicketStatusChangedJob = {
      ticketId: 'TKT-BOLTPE-2610-GEN-ABC123',
      customerEmail: 'customer@example.com',
      statusLabel: 'Resolved',
      statusMessage: 'We believe this issue is now resolved.',
      remark: 'Refund processed.',
    };

    it('should enqueue a status-changed job with retry and backoff', async () => {
      await queue.queueStatusChanged(statusJob);

      expect(mockAddJob).toHaveBeenCalledWith(
        'support-notifications',
        'status-changed',
        statusJob,
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('should swallow a queue failure rather than throwing at the caller', async () => {
      mockAddJob.mockRejectedValue(new Error('redis unreachable'));

      await expect(queue.queueStatusChanged(statusJob)).resolves.toBeUndefined();
    });

    it('should email the customer with the status and the remark', async () => {
      await (queue as any).sendStatusChanged(statusJob);

      const sent = mockSendMail.mock.calls[0][0];
      expect(sent.to).toBe('customer@example.com');
      expect(sent.subject).toContain('TKT-BOLTPE-2610-GEN-ABC123');
      expect(sent.text).toContain('Resolved');
      expect(sent.text).toContain('Refund processed.');
    });

    it('should omit the remark block when the agent left no note', async () => {
      await (queue as any).sendStatusChanged({ ...statusJob, remark: undefined });

      const sent = mockSendMail.mock.calls[0][0];
      expect(sent.text).not.toContain('From our team');
    });

    it('should never put the customer email in a log line', async () => {
      const info = jest.spyOn((queue as any).logger, 'info');

      await queue.queueStatusChanged(statusJob);
      await (queue as any).sendStatusChanged(statusJob);

      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toContain('customer@example.com');
      expect(logged).toContain('TKT-BOLTPE-2610-GEN-ABC123');
    });
  });

  describe('From address', () => {
    it('should send as SMTP_FROM when it differs from the login', async () => {
      const q = build({ 'smtp.from': 'support@boltpe.money', 'smtp.user': 'noreply@boltpe.money' });

      await (q as any).sendTicketCreated(job);

      expect(mockSendMail.mock.calls[0][0].from).toBe('"BoltPe Support" <support@boltpe.money>');
    });

    // Most servers authenticate and send as the same address, so the login is
    // the right default and SMTP_FROM only exists for the cases that differ.
    it('should fall back to the SMTP login when SMTP_FROM is unset', async () => {
      const q = build({ 'smtp.from': undefined, 'smtp.user': 'noreply@boltpe.money' });

      await (q as any).sendTicketCreated(job);

      expect(mockSendMail.mock.calls[0][0].from).toBe('"BoltPe Support" <noreply@boltpe.money>');
    });
  });
});
