import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { MessengerConfig } from './messenger.config';
import { MessengerAdapter } from './messenger.adapter';
import { MessengerService, WATERMARK_TOLERANCE_MS } from './messenger.service';
import { NAME_LOOKUPS_PER_WEBHOOK } from '../messaging/contact-names';
import type { MessagesService } from '../messaging/messages.service';
import type { MessageStatusService } from '../messaging/message-status.service';
import type { CustomersService } from '../customers/customers.service';
import type { PrismaService } from '../database/prisma.service';

const settings = {
  MESSENGER_ENABLED: 'true',
  MESSAGING_ENABLED: 'true',
  REDIS_URL: 'redis://localhost:6379',
  MESSENGER_PAGE_ID: '123',
  MESSENGER_PAGE_ACCESS_TOKEN: 'fake-access',
  MESSENGER_VERIFY_TOKEN: 'fake-verify',
  MESSENGER_API_VERSION: 'v26.0',
  META_APP_SECRET: 'fake-secret',
};
const config = () => new MessengerConfig(new ConfigService(settings));
const item = (extra: object = {}) => ({
  sender: { id: '456' },
  recipient: { id: '123' },
  timestamp: Date.now(),
  message: { mid: 'mid.in', text: 'Hola' },
  ...extra,
});
const event = (items: unknown[] = [item()]) => ({
  object: 'page',
  entry: [{ id: '123', messaging: items }],
});
const signed = (body: unknown) => {
  const raw = Buffer.from(JSON.stringify(body));
  const signature =
    'sha256=' +
    createHmac('sha256', settings.META_APP_SECRET).update(raw).digest('hex');
  return [raw, signature] as const;
};
const service = (
  overrides: {
    messages?: object;
    statuses?: object;
    customers?: object;
    prisma?: object;
    adapter?: MessengerAdapter;
  } = {},
) =>
  new MessengerService(
    config(),
    overrides.adapter ?? new MessengerAdapter(config()),
    (overrides.messages ?? {
      ingestFromProvider: jest.fn().mockResolvedValue([]),
      quarantine: jest.fn(),
    }) as unknown as MessagesService,
    (overrides.statuses ?? {
      accept: jest.fn().mockResolvedValue(undefined),
    }) as unknown as MessageStatusService,
    (overrides.customers ?? {}) as unknown as CustomersService,
    (overrides.prisma ?? {}) as unknown as PrismaService,
  );

describe('Messenger configuration, authentication and transport', () => {
  afterEach(() => jest.restoreAllMocks());
  it('disabled by default; enabled requires complete configuration', () => {
    expect(new MessengerConfig(new ConfigService({})).enabled).toBe(false);
    expect(
      () =>
        new MessengerConfig(new ConfigService({ MESSENGER_ENABLED: 'yes' })),
    ).toThrow();
    for (const key of Object.keys(settings).filter(
      (k) => k !== 'MESSENGER_ENABLED',
    )) {
      expect(
        () =>
          new MessengerConfig(new ConfigService({ ...settings, [key]: '' })),
      ).toThrow();
    }
    expect(config().enabled).toBe(true);
  });
  it('scopes inbound PSIDs to the configured page without pretending they are phone numbers', () => {
    const parsed = new MessengerAdapter(config()).parse(event());
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      channel: 'FACEBOOK',
      providerAccountId: '123',
      externalMessageId: 'mid.in',
      contact: { externalId: '456' },
      type: 'TEXT',
      content: 'Hola',
    });
    expect(parsed.messages[0].contact.phone).toBeUndefined();
    expect(parsed.rejected).toEqual([]);
  });
  it('implements the channel contract: page-scoped recipients and its own limits', () => {
    const adapter = new MessengerAdapter(config());
    expect(adapter).toMatchObject({
      channel: 'FACEBOOK',
      errorPrefix: 'MESSENGER',
      maxTextLength: 2000,
      recipientField: 'recipientExternalId',
      enabled: true,
      providerAccountId: '123',
    });
    const customer = {
      normalizedPhone: '+51987654321',
      externalContactId: '456',
    };
    expect(adapter.recipientOf({ ...customer, providerAccountId: '123' })).toBe(
      '456',
    );
    expect(
      adapter.recipientOf({ ...customer, providerAccountId: '999' }),
    ).toBeNull();
  });
  it('ignores other pages, Instagram, echoes, postbacks and read watermarks', () => {
    const adapter = new MessengerAdapter(config());
    expect(adapter.parse({ ...event(), object: 'instagram' }).messages).toEqual(
      [],
    );
    expect(
      adapter.parse({
        object: 'page',
        entry: [{ id: '999', messaging: [item()] }],
      }).messages,
    ).toEqual([]);
    expect(
      adapter.parse(
        event([
          item({ recipient: { id: '999' } }),
          item({ message: { mid: 'mid.echo', text: 'Hola', is_echo: true } }),
          item({ message: undefined, postback: { payload: 'action' } }),
          item({ message: undefined, read: { watermark: Date.now() } }),
        ]),
      ).messages,
    ).toEqual([]);
  });
  it('isolates invalid events, rejects future dates and preserves supported siblings', () => {
    const parsed = new MessengerAdapter(config()).parse(
      event([
        item({ timestamp: Date.now() + 86400000 }),
        item({ sender: { id: 'invalid' } }),
        item(),
      ]),
    );
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.rejected).toHaveLength(2);
    expect(parsed.rejected.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(
      true,
    );
  });
  it('records unsupported attachments as OTHER and parses delivery message IDs', () => {
    const sentUpTo = Date.now() - 120000;
    const deliveredAt = Date.now() - 1000;
    const parsed = new MessengerAdapter(config()).parse(
      event([
        item({
          message: { mid: 'mid.attachment', attachments: [{ type: 'image' }] },
        }),
        item({
          message: undefined,
          timestamp: deliveredAt,
          delivery: { mids: ['mid.out'], watermark: sentUpTo },
        }),
      ]),
    );
    expect(parsed.messages[0].type).toBe('OTHER');
    // Delivered when the event happened, not at the send-time watermark.
    expect(parsed.statuses[0]).toEqual({
      externalMessageId: 'mid.out',
      providerAccountId: '123',
      status: 'DELIVERED',
      occurredAt: new Date(deliveredAt),
    });
    expect(parsed.watermarks).toEqual([
      {
        recipientId: '456',
        watermark: new Date(sentUpTo),
        occurredAt: new Date(deliveredAt),
      },
    ]);
  });
  it('keeps deliveries without mids as a watermark, falling back to it without an event time', () => {
    const watermark = Date.now() - 5000;
    const parsed = new MessengerAdapter(config()).parse(
      event([
        item({
          message: undefined,
          timestamp: undefined,
          delivery: { watermark },
        }),
      ]),
    );
    expect(parsed.statuses).toEqual([]);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.watermarks).toEqual([
      {
        recipientId: '456',
        watermark: new Date(watermark),
        occurredAt: new Date(watermark),
      },
    ]);
  });
  it.each([
    ['missing', 'soon'],
    ['earlier than the watermark', Date.now() - 10000],
  ])(
    'uses the watermark when the event time is %s, keeping the receipt',
    (_, timestamp) => {
      const watermark = Date.now() - 5000;
      const parsed = new MessengerAdapter(config()).parse(
        event([
          item({
            message: undefined,
            timestamp,
            delivery: { mids: ['mid.out'], watermark },
          }),
        ]),
      );
      expect(parsed.rejected).toEqual([]);
      expect(parsed.statuses[0].occurredAt).toEqual(new Date(watermark));
      expect(parsed.watermarks[0].occurredAt).toEqual(new Date(watermark));
    },
  );
  it.each([
    ['an invalid watermark', { mids: ['mid.out'], watermark: 'soon' }],
    ['an invalid mid', { mids: ['mid.out', 7], watermark: Date.now() }],
  ])(
    'quarantines a receipt with %s without recording any part of it',
    (_, delivery) => {
      const parsed = new MessengerAdapter(config()).parse(
        event([item({ message: undefined, delivery })]),
      );
      expect(parsed.statuses).toEqual([]);
      expect(parsed.watermarks).toEqual([]);
      expect(parsed.rejected).toHaveLength(1);
    },
  );
  it('confirms sent replies covered by a delivery watermark, once and never before their send', async () => {
    const statuses = { accept: jest.fn().mockResolvedValue(undefined) };
    const watermark = Date.now() - 5000;
    const deliveredAt = watermark + 1000;
    const findMany = jest.fn().mockResolvedValue([
      { externalMessageId: 'mid.old', sentAt: new Date(watermark - 1000) },
      { externalMessageId: 'mid.listed', sentAt: new Date(watermark - 500) },
      // Meta answered after the receipt's event time (within the margin).
      { externalMessageId: 'mid.close', sentAt: new Date(watermark + 1500) },
    ]);
    const [raw, signature] = signed(
      event([
        item({
          message: undefined,
          timestamp: deliveredAt,
          delivery: { mids: ['mid.listed'], watermark },
        }),
      ]),
    );
    await service({ statuses, prisma: { message: { findMany } } }).receive(
      raw,
      signature,
    );
    expect(WATERMARK_TOLERANCE_MS).toBe(2000);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'SENT',
          providerAccountId: '123',
          recipientExternalId: '456',
          sentAt: { lte: new Date(watermark + 2000) },
        }) as unknown,
      }),
    );
    const delivered = (externalMessageId: string, occurredAt: number) => ({
      externalMessageId,
      providerAccountId: '123',
      status: 'DELIVERED',
      occurredAt: new Date(occurredAt),
    });
    expect(statuses.accept).toHaveBeenCalledWith(
      [
        delivered('mid.listed', deliveredAt),
        delivered('mid.old', deliveredAt),
        delivered('mid.close', watermark + 1500),
      ],
      'FACEBOOK',
    );
  });
  it('verifies the challenge and authenticates the exact raw request before processing', async () => {
    const statuses = { accept: jest.fn().mockResolvedValue(undefined) };
    const messages = {
      ingestFromProvider: jest.fn().mockResolvedValue([]),
      quarantine: jest.fn(),
    };
    const webhook = service({ statuses, messages });
    expect(webhook.verify('subscribe', 'fake-verify', 'challenge')).toBe(
      'challenge',
    );
    expect(() => webhook.verify('subscribe', 'wrong', 'challenge')).toThrow();
    expect(() =>
      webhook.verify('bad-mode', 'fake-verify', 'challenge'),
    ).toThrow();
    const [raw, signature] = signed(event());
    await expect(webhook.receive(raw, undefined)).rejects.toThrow();
    await expect(
      webhook.receive(Buffer.concat([raw, Buffer.from(' ')]), signature),
    ).rejects.toThrow();
    expect(messages.ingestFromProvider).not.toHaveBeenCalled();
    expect(statuses.accept).not.toHaveBeenCalled();
    await expect(webhook.receive(raw, signature)).resolves.toEqual({
      received: true,
    });
    // Ingested through the shared path, as a provider identity scoped to the page.
    expect(messages.ingestFromProvider).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          channel: 'FACEBOOK',
          providerAccountId: '123',
          contact: expect.objectContaining({ externalId: '456' }) as unknown,
        }),
      ],
      [],
    );
    expect(statuses.accept).toHaveBeenCalledWith([], 'FACEBOOK');
  });
  it('names new customers once from the sender of their first message, never over a CRM name', async () => {
    const adapter = new MessengerAdapter(config());
    const fetchName = jest
      .spyOn(adapter, 'fetchSenderName')
      .mockResolvedValue('Ana Quispe');
    const setNameIfMissing = jest.fn().mockResolvedValue(true);
    const created = (id: string, firstName: string | null, mid: string) => ({
      command: {
        channel: 'FACEBOOK',
        externalMessageId: mid,
        providerAccountId: '123',
        contact: { externalId: '456' },
        type: 'TEXT',
      },
      customer: { id, firstName, lastName: null },
    });
    const messages = {
      ingestFromProvider: jest
        .fn()
        .mockResolvedValue([
          created('new', null, 'mid.1'),
          created('new', null, 'mid.2'),
          created('named', 'Nombre del CRM', 'mid.3'),
        ]),
      quarantine: jest.fn(),
    };
    const [raw, signature] = signed(event());
    await service({
      adapter,
      messages,
      customers: { setNameIfMissing },
    }).receive(raw, signature);
    expect(fetchName).toHaveBeenCalledTimes(1);
    expect(fetchName).toHaveBeenCalledWith('mid.1', '456');
    expect(setNameIfMissing).toHaveBeenCalledWith('new', 'Ana Quispe');
  });
  it('bounds name lookups per webhook and never fails the webhook because of them', async () => {
    const adapter = new MessengerAdapter(config());
    const fetchName = jest
      .spyOn(adapter, 'fetchSenderName')
      .mockRejectedValue(new Error('network'));
    const created = Array.from({ length: 5 }, (_, index) => ({
      command: {
        externalMessageId: `mid.${index}`,
        contact: { externalId: String(1000 + index) },
      },
      customer: { id: `c${index}`, firstName: null, lastName: null },
    }));
    const [raw, signature] = signed(event());
    await expect(
      service({
        adapter,
        messages: {
          ingestFromProvider: jest.fn().mockResolvedValue(created),
          quarantine: jest.fn(),
        },
        customers: { setNameIfMissing: jest.fn() },
      }).receive(raw, signature),
    ).resolves.toEqual({ received: true });
    expect(fetchName).toHaveBeenCalledTimes(NAME_LOOKUPS_PER_WEBHOOK);
  });
  it('reads the sender name of one of our messages, rejecting mismatches and placeholders', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const reply = (from: unknown, status = 200) =>
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'mid.1', from }), { status }),
      );
    const adapter = new MessengerAdapter(config());
    reply({ id: '456', name: '  Ana Quispe  ' });
    await expect(adapter.fetchSenderName('mid.1', '456')).resolves.toBe(
      'Ana Quispe',
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://graph.facebook.com/v26.0/mid.1?fields=from',
      expect.objectContaining({ redirect: 'error' }),
    );
    reply({ id: '999', name: 'Otra persona' });
    await expect(adapter.fetchSenderName('mid.1', '456')).resolves.toBeNull();
    reply({ id: '456', name: 'Facebook User' });
    await expect(adapter.fetchSenderName('mid.1', '456')).resolves.toBeNull();
    reply({ error: { code: 100 } }, 400);
    await expect(adapter.fetchSenderName('mid.1', '456')).resolves.toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await expect(adapter.fetchSenderName('mid.1', '456')).resolves.toBeNull();
    await expect(
      new MessengerAdapter(
        new MessengerConfig(new ConfigService({})),
      ).fetchSenderName('mid.1', '456'),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Failures are logged, never with the PSID or the name; a placeholder is not a failure.
    expect(
      warn.mock.calls.map(([log]) => JSON.parse(String(log)) as unknown),
    ).toEqual([
      { code: 'MESSENGER_NAME_LOOKUP_FAILED', reason: 'SENDER_MISMATCH' },
      { code: 'MESSENGER_NAME_LOOKUP_FAILED', status: 400 },
      { code: 'MESSENGER_NAME_LOOKUP_FAILED', reason: 'Error' },
    ]);
    warn.mockRestore();
  });
  it('sends a RESPONSE with the Page token and validates the recipient in the response', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ recipient_id: '456', message_id: 'mid.out' }),
        ),
      );
    await expect(
      new MessengerAdapter(config()).sendMessage('456', 'Hola'),
    ).resolves.toBe('mid.out');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v26.0/123/messages',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({
          recipient: { id: '456' },
          messaging_type: 'RESPONSE',
          message: { text: 'Hola' },
        }),
      }),
    );
  });
  it.each([
    [400, 'failed'],
    [429, 'retry'],
    [500, 'unknown'],
    [408, 'unknown'],
  ])(
    'classifies HTTP %s without exposing provider messages',
    async (status, outcome) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 10, message: 'sensitive information' },
          }),
          { status: Number(status) },
        ),
      );
      await expect(
        new MessengerAdapter(config()).sendMessage('456', 'Hola'),
      ).rejects.toMatchObject({
        outcome,
        diagnostic: { httpStatus: status, metaCode: 10 },
      });
    },
  );
  it('does not blindly retry ambiguous network results or mismatched recipients', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network'));
    const adapter = new MessengerAdapter(config());
    await expect(adapter.sendMessage('456', 'Hola')).rejects.toMatchObject({
      outcome: 'unknown',
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ recipient_id: '999', message_id: 'mid.out' }),
      ),
    );
    await expect(adapter.sendMessage('456', 'Hola')).rejects.toMatchObject({
      outcome: 'unknown',
    });
  });
  it('does not make requests for disabled transport or invalid content/recipient', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    await expect(
      new MessengerAdapter(
        new MessengerConfig(new ConfigService({})),
      ).sendMessage('456', 'Hola'),
    ).rejects.toThrow();
    await expect(
      new MessengerAdapter(config()).sendMessage('bad', 'Hola'),
    ).rejects.toThrow();
    await expect(
      new MessengerAdapter(config()).sendMessage('456', 'x'.repeat(2001)),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
