import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { GetAllTicketsDto, UpdateTicketStatusDto } from './ticket-admin.dto';

describe('GetAllTicketsDto validation', () => {
  it('passes with no fields provided (all optional)', async () => {
    const dto = plainToInstance(GetAllTicketsDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('passes with a valid status filter', async () => {
    const dto = plainToInstance(GetAllTicketsDto, { status: 'OPEN' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails with an invalid status value', async () => {
    const dto = plainToInstance(GetAllTicketsDto, { status: 'NOT_A_REAL_STATUS' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when limit exceeds 100', async () => {
    const dto = plainToInstance(GetAllTicketsDto, { limit: 500 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when page is less than 1', async () => {
    const dto = plainToInstance(GetAllTicketsDto, { page: 0 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('UpdateTicketStatusDto validation', () => {
  it('passes with just a non-terminal status (e.g. IN_PROGRESS)', async () => {
    const dto = plainToInstance(UpdateTicketStatusDto, { status: 'IN_PROGRESS' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails when status is RESOLVED but dispositionCode is missing', async () => {
    const dto = plainToInstance(UpdateTicketStatusDto, {
      status: 'RESOLVED',
      resolutionSummary: 'This is a long enough summary.',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when status is RESOLVED but resolutionSummary is missing', async () => {
    const dto = plainToInstance(UpdateTicketStatusDto, {
      status: 'RESOLVED',
      dispositionCode: 'REFUND_PROCESSED',
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('passes when status is RESOLVED with both dispositionCode and resolutionSummary', async () => {
    const dto = plainToInstance(UpdateTicketStatusDto, {
      status: 'RESOLVED',
      dispositionCode: 'REFUND_PROCESSED',
      resolutionSummary: 'Refund processed successfully to source.',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails when status is CLOSED without dispositionCode/resolutionSummary', async () => {
    const dto = plainToInstance(UpdateTicketStatusDto, { status: 'CLOSED' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails with an invalid status enum value', async () => {
    const dto = plainToInstance(UpdateTicketStatusDto, { status: 'MADE_UP_STATUS' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('UpdateTicketStatusDto remark rules', () => {
  const build = (body: Record<string, unknown>) => plainToInstance(UpdateTicketStatusDto, body);

  // The PRD marks the remark mandatory on hold: the customer has to be told
  // what is being waited on, not just that they are waiting.
  it.each(['PENDING_USER', 'PENDING_PARTNER'])(
    'requires a remark when moving to %s',
    async (status) => {
      const errors = await validate(build({ status }));
      expect(JSON.stringify(errors)).toMatch(/resolutionSummary is required/);
    },
  );

  it.each(['PENDING_USER', 'PENDING_PARTNER'])('passes when %s carries a remark', async (status) => {
    const errors = await validate(
      build({ status, resolutionSummary: 'Waiting on the bank to confirm the reversal.' }),
    );
    expect(errors).toHaveLength(0);
  });

  // Picking a ticket up needs no explanation — the status itself says it.
  it('does not require a remark for IN_PROGRESS', async () => {
    expect(await validate(build({ status: 'IN_PROGRESS' }))).toHaveLength(0);
  });

  it('still requires a disposition and summary for RESOLVED', async () => {
    const errors = await validate(build({ status: 'RESOLVED' }));
    const text = JSON.stringify(errors);
    expect(text).toMatch(/dispositionCode is required/);
    expect(text).toMatch(/resolutionSummary is required/);
  });
});
