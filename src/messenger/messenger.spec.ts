import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { MessengerConfig } from './messenger.config';
import { MessengerAdapter } from './messenger.adapter';
import { MessengerService } from './messenger.service';
import type { MessagingTransactionService } from '../messaging/messaging-transaction.service';
import type { MessageStatusService } from '../messaging/message-status.service';
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
      pageId: '123',
      senderId: '456',
      type: 'TEXT',
      content: 'Hola',
    });
    expect(parsed.rejected).toEqual([]);
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
    const parsed = new MessengerAdapter(config()).parse(
      event([
        item({
          message: { mid: 'mid.attachment', attachments: [{ type: 'image' }] },
        }),
        item({
          message: undefined,
          delivery: { mids: ['mid.out'], watermark: Date.now() },
        }),
      ]),
    );
    expect(parsed.messages[0].type).toBe('OTHER');
    expect(parsed.statuses[0]).toMatchObject({
      externalMessageId: 'mid.out',
      providerAccountId: '123',
      status: 'DELIVERED',
    });
  });
  it('verifies the challenge and authenticates the exact raw request before processing', async () => {
    const transactions = { run: jest.fn() };
    const statuses = { accept: jest.fn().mockResolvedValue(undefined) };
    const service = new MessengerService(
      config(),
      new MessengerAdapter(config()),
      transactions as unknown as MessagingTransactionService,
      statuses as unknown as MessageStatusService,
      {} as PrismaService,
    );
    expect(service.verify('subscribe', 'fake-verify', 'challenge')).toBe(
      'challenge',
    );
    expect(() => service.verify('subscribe', 'wrong', 'challenge')).toThrow();
    expect(() =>
      service.verify('bad-mode', 'fake-verify', 'challenge'),
    ).toThrow();
    const raw = Buffer.from(JSON.stringify(event([])));
    const signature =
      'sha256=' +
      createHmac('sha256', settings.META_APP_SECRET).update(raw).digest('hex');
    await expect(service.receive(raw, undefined)).rejects.toThrow();
    await expect(
      service.receive(Buffer.concat([raw, Buffer.from(' ')]), signature),
    ).rejects.toThrow();
    expect(statuses.accept).not.toHaveBeenCalled();
    await expect(service.receive(raw, signature)).resolves.toEqual({
      received: true,
    });
    expect(statuses.accept).toHaveBeenCalledWith([], 'FACEBOOK');
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
