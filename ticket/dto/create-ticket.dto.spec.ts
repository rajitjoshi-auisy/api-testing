import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateTicketDto, GetMyTicketsDto } from './create-ticket.dto';

// Mirrors the global ValidationPipe in main.ts. Without enableImplicitConversion
// these specs exercise different transform behaviour than the running service,
// which previously hid the fact that any truthy value satisfied @IsBoolean().
const PIPE_OPTS = { enableImplicitConversion: true };

describe('CreateTicketDto validation', () => {
  const validPayload = {
    l1CategoryCode: 'PAYMENT_TRANSACTION_ISSUE',
    description: 'Payment deducted but booking not confirmed even after 2 hours.',
    contactEmailOverride: 'user@example.com',
    contactMobileOverride: '9876543210',
  };

  it('passes with a fully valid payload', async () => {
    const dto = plainToInstance(CreateTicketDto, validPayload, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails when l1CategoryCode is missing', async () => {
    const { l1CategoryCode, ...rest } = validPayload;
    const dto = plainToInstance(CreateTicketDto, rest, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  // There is no minimum length — a customer may describe the issue in one word.
  it.each(['a', 'help', 'too short'])('accepts a %s-length description', async (description) => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, description }, PIPE_OPTS);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('still rejects an empty description', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, description: '' }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when description exceeds 5000 characters', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, description: 'a'.repeat(5001) }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when contactEmailOverride is not a valid email', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, contactEmailOverride: 'not-an-email' }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when contactMobileOverride does not match the Indian mobile pattern', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, contactMobileOverride: '1234567890' }, PIPE_OPTS); // starts with 1, invalid
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when contactMobileOverride is not 10 digits', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, contactMobileOverride: '98765' }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('passes with duplicateOverride explicitly true', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, duplicateOverride: true }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('passes when duplicateOverride is omitted (optional)', async () => {
    const dto = plainToInstance(CreateTicketDto, validPayload, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails when duplicateOverride is a non-boolean string', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, duplicateOverride: 'yes' }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when duplicateOverride is a number', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, duplicateOverride: 1 }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts the string "true" and normalises it to boolean true', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, duplicateOverride: 'true' }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.duplicateOverride).toBe(true);
  });

  // Regression: under implicit conversion this used to arrive as `true`,
  // silently bypassing the 24h duplicate-ticket check the caller opted out of.
  it('accepts the string "false" and normalises it to boolean false', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, duplicateOverride: 'false' }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.duplicateOverride).toBe(false);
  });

  it('preserves an explicit boolean false', async () => {
    const dto = plainToInstance(CreateTicketDto, { ...validPayload, duplicateOverride: false }, PIPE_OPTS);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.duplicateOverride).toBe(false);
  });
});


describe('GetMyTicketsDto validation', () => {
  const build = (payload: object) => plainToInstance(GetMyTicketsDto, payload, PIPE_OPTS);

  it('passes with no fields — every filter is optional', async () => {
    expect(await validate(build({}))).toHaveLength(0);
  });

  it('defaults to page 1 and limit 20', async () => {
    const dto = build({});
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('coerces numeric strings from the query string', async () => {
    const dto = build({ page: '3', limit: '50' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
  });

  it('passes with a valid status filter', async () => {
    expect(await validate(build({ status: 'OPEN' }))).toHaveLength(0);
  });

  it('fails with an invalid status value', async () => {
    expect((await validate(build({ status: 'NOT_A_STATUS' }))).length).toBeGreaterThan(0);
  });

  it('fails when page is below 1', async () => {
    expect((await validate(build({ page: 0 }))).length).toBeGreaterThan(0);
  });

  it('fails when limit exceeds 100', async () => {
    expect((await validate(build({ limit: 500 }))).length).toBeGreaterThan(0);
  });

  it('accepts the category filters', async () => {
    const dto = build({ l1CategoryCode: 'PAYMENT', l2SubCategoryCode: 'FAILED_TXN' });
    expect(await validate(dto)).toHaveLength(0);
  });
});

describe('CreateTicketDto description word limit', () => {
  const build = (description: string) =>
    plainToInstance(CreateTicketDto, {
      l1CategoryCode: 'FLIGHT_BOOKING',
      description,
      contactEmailOverride: 'user@example.com',
      contactMobileOverride: '9876543210',
    });

  const words = (n: number) => Array(n).fill('word').join(' ');

  it('accepts a description at exactly the 500-word limit', async () => {
    expect(await validate(build(words(500)))).toHaveLength(0);
  });

  // The PRD states the cap in words and the client counts words, so the server
  // has to agree — a character cap alone would let 501 words through.
  it('rejects 501 words', async () => {
    const errors = await validate(build(words(501)));
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).toMatch(/must not exceed 500 words/);
  });

  it('counts words, not characters — long words inside the limit still pass', async () => {
    const longButFewWords = Array(100).fill('a'.repeat(20)).join(' ');
    expect(await validate(build(longButFewWords))).toHaveLength(0);
  });

  it('ignores extra whitespace when counting', async () => {
    expect(await validate(build(Array(500).fill('word').join('   ')))).toHaveLength(0);
  });

  // Without the character bound, one enormous token would count as a single
  // word and sail past the 500-word check.
  it('still rejects a single token longer than the character bound', async () => {
    const errors = await validate(build('a'.repeat(5001)));
    expect(errors.length).toBeGreaterThan(0);
  });
});
