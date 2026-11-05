import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { InstagramConfig } from './instagram.config';
import { InstagramAdapter } from './instagram.adapter';
import { InstagramService } from './instagram.service';
import { InstagramController } from './instagram.controller';
import { MessagesService } from '../messaging/messages.service';
import { CustomersService } from '../customers/customers.service';
import { exceedsTextLimit } from '../messaging/channel-transport';

const settings = {
  INSTAGRAM_ENABLED: 'true',
  INSTAGRAM_ACCOUNT_ID: '123',
  INSTAGRAM_VERIFY_TOKEN: 'test-verify',
  META_APP_SECRET: 'test-secret',
  MESSAGING_ENABLED: 'true',
  REDIS_URL: 'redis://localhost:6379',
};
const config = () => new InstagramConfig(new ConfigService(settings));
const item = (extra: object = {}) => ({
  sender: { id: '456' },
  recipient: { id: '123' },
  timestamp: Date.now(),
  message: { mid: 'ig.mid', text: 'Hola' },
  ...extra,
});
const event = (items: unknown[] = [item()]) => ({
  object: 'instagram',
  entry: [{ id: '123', messaging: items }],
});
const signature = (raw: string) =>
  'sha256=' +
  createHmac('sha256', settings.META_APP_SECRET).update(raw).digest('hex');

describe('Instagram configuration', () => {
  it('is disabled by default', () => {
    const value = new InstagramConfig(
      new ConfigService({ INSTAGRAM_ENABLED: 'false' }),
    );
    expect(value.enabled).toBe(false);
    expect(() => value.assertEnabled()).toThrow('no está habilitado');
  });
  it.each(Object.keys(settings))('rejects an invalid %s', (key) => {
    expect(
      () => new InstagramConfig(new ConfigService({ ...settings, [key]: ' ' })),
    ).toThrow();
  });
  it('treats the access token as optional, but requires a valid API version with it', () => {
    expect(config().accessToken).toBe('');
    const withToken = (version?: string) =>
      new InstagramConfig(
        new ConfigService({
          ...settings,
          INSTAGRAM_ACCESS_TOKEN: ' EAAtoken ',
          ...(version === undefined ? {} : { INSTAGRAM_API_VERSION: version }),
        }),
      );
    expect(withToken('v26.0').accessToken).toBe('EAAtoken');
    expect(() => withToken()).toThrow('INSTAGRAM_API_VERSION');
    expect(() => withToken('26')).toThrow('INSTAGRAM_API_VERSION');
  });
});

const namingConfig = () =>
  new InstagramConfig(
    new ConfigService({
      ...settings,
      INSTAGRAM_ACCESS_TOKEN: 'EAAtoken',
      INSTAGRAM_API_VERSION: 'v26.0',
    }),
  );

describe('Instagram sender name', () => {
  afterEach(() => jest.restoreAllMocks());
  it('reads the profile name, falling back to the username, and rejects mismatches', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const reply = (body: unknown, status = 200) =>
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status }),
      );
    const adapter = new InstagramAdapter(namingConfig());
    reply({ id: '456', name: '  Ana Quispe  ', username: 'ana.q' });
    await expect(adapter.fetchSenderName('456')).resolves.toBe('Ana Quispe');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://graph.facebook.com/v26.0/456?fields=name,username',
      expect.objectContaining({
        redirect: 'error',
        headers: { Authorization: 'Bearer EAAtoken' },
      }),
    );
    reply({ id: '456', username: 'ana.q' });
    await expect(adapter.fetchSenderName('456')).resolves.toBe('@ana.q');
    reply({ id: '456', name: 'Instagram User', username: 'ana_q' });
    await expect(adapter.fetchSenderName('456')).resolves.toBe('@ana_q');
    reply({ id: '456', name: ' ', username: 'no válido' });
    await expect(adapter.fetchSenderName('456')).resolves.toBeNull();
    reply({ id: '999', name: 'Otra persona' });
    await expect(adapter.fetchSenderName('456')).resolves.toBeNull();
    reply({ error: { code: 100 } }, 400);
    await expect(adapter.fetchSenderName('456')).resolves.toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await expect(adapter.fetchSenderName('456')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(7);
    // Failures are logged, never with the IGSID or the name; a missing name is not a failure.
    expect(
      warn.mock.calls.map(([log]) => JSON.parse(String(log)) as unknown),
    ).toEqual([
      { code: 'INSTAGRAM_NAME_LOOKUP_FAILED', reason: 'SENDER_MISMATCH' },
      { code: 'INSTAGRAM_NAME_LOOKUP_FAILED', status: 400 },
      { code: 'INSTAGRAM_NAME_LOOKUP_FAILED', reason: 'Error' },
    ]);
  });
  it('does not call Meta without a token or while disabled', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    await expect(
      new InstagramAdapter(config()).fetchSenderName('456'),
    ).resolves.toBeNull();
    await expect(
      new InstagramAdapter(
        new InstagramConfig(new ConfigService({ INSTAGRAM_ENABLED: 'false' })),
      ).fetchSenderName('456'),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('names new customers once, never over a CRM name, without failing the webhook', async () => {
    const adapter = new InstagramAdapter(namingConfig());
    const fetchName = jest
      .spyOn(adapter, 'fetchSenderName')
      .mockResolvedValueOnce('Ana Quispe')
      .mockRejectedValueOnce(new Error('network'));
    const setNameIfMissing = jest.fn().mockResolvedValue(true);
    const stored = (id: string, firstName: string | null, sender: string) => ({
      command: {
        externalMessageId: `mid.${id}.${sender}`,
        contact: { externalId: sender },
      },
      customer: { id, firstName, lastName: null },
    });
    const messages = {
      ingestFromProvider: jest
        .fn()
        .mockResolvedValue([
          stored('new', null, '456'),
          stored('new', null, '456'),
          stored('named', 'Nombre del CRM', '789'),
          stored('other', null, '790'),
        ]),
      quarantine: jest.fn(),
    };
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const raw = JSON.stringify(event());
    await expect(
      new InstagramService(
        namingConfig(),
        adapter,
        messages as unknown as MessagesService,
        { setNameIfMissing } as unknown as CustomersService,
      ).receive(Buffer.from(raw), signature(raw)),
    ).resolves.toEqual({ received: true });
    expect(fetchName.mock.calls).toEqual([['456'], ['790']]);
    expect(setNameIfMissing).toHaveBeenCalledTimes(1);
    expect(setNameIfMissing).toHaveBeenCalledWith('new', 'Ana Quispe');
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ code: 'INSTAGRAM_NAME_UNAVAILABLE' }),
    );
  });
});

describe('Instagram parser', () => {
  const adapter = new InstagramAdapter(config());
  it('maps real text to an account-scoped Instagram identity', () => {
    expect(adapter.parse(event()).messages[0]).toMatchObject({
      channel: 'INSTAGRAM',
      providerAccountId: '123',
      contact: { externalId: '456' },
      type: 'TEXT',
      content: 'Hola',
      externalMessageId: 'ig.mid',
    });
  });
  it('does not store other accounts or Meta synthetic samples', () => {
    expect(adapter.parse({ object: 'page', entry: [] }).messages).toEqual([]);
    expect(
      adapter.parse({
        object: 'instagram',
        entry: [{ id: '999', messaging: [item()] }],
      }).messages,
    ).toEqual([]);
    expect(
      adapter.parse({ entry: [{ id: '0', changes: [] }] }).messages,
    ).toEqual([]);
    expect(
      adapter.parse(event([item({ recipient: { id: '999' } })])).messages,
    ).toEqual([]);
  });
  it.each(['is_echo', 'is_deleted', 'is_unsupported'])('ignores %s', (key) => {
    expect(
      adapter.parse(
        event([item({ message: { mid: 'x', text: 'x', [key]: true } })]),
      ).messages,
    ).toEqual([]);
  });
  it('ignores receipts and self messages', () => {
    expect(
      adapter.parse(
        event([{ read: { mid: 'x' } }, item({ sender: { id: '123' } })]),
      ).messages,
    ).toEqual([]);
  });
  it('keeps attachment placeholders without downloading URLs', () => {
    expect(
      adapter.parse(
        event([
          item({
            message: {
              mid: 'a',
              attachments: [
                { type: 'image', payload: { url: 'https://example.com/a' } },
              ],
            },
          }),
        ]),
      ).messages[0],
    ).toMatchObject({ type: 'OTHER', attachments: [] });
  });
  it.each([
    { timestamp: -1 },
    { timestamp: Date.now() + 3600000 },
    { sender: { id: 'not-an-id' } },
    { message: {} },
    { message: { mid: 'x', text: '' } },
    { message: { mid: 'x', text: 'a'.repeat(16001) } },
  ])(
    'quarantines malformed items while preserving valid siblings (%#)',
    (bad) => {
      const parsed = adapter.parse(event([item(bad), item()]));
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.rejected).toEqual([
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ]);
    },
  );
});

describe('Instagram: envío de respuestas', () => {
  afterEach(() => jest.restoreAllMocks());
  const igsid = (id: string) => ({
    recipientPhone: null,
    recipientExternalId: id,
  });
  it('cumple el contrato de canal: solo envía con token y al IGSID de su cuenta', () => {
    const sending = new InstagramAdapter(namingConfig());
    expect(sending).toMatchObject({
      channel: 'INSTAGRAM',
      errorPrefix: 'INSTAGRAM',
      label: 'Instagram',
      maxTextLength: 1000,
      maxTextBytes: 1000,
      enabled: true,
      providerAccountId: '123',
    });
    const customer = {
      normalizedPhone: '+51987654321',
      providerAccountId: '123',
      externalContactId: '456',
      whatsappUserId: 'PE.1',
    };
    expect(sending.recipientOf(customer)).toEqual(igsid('456'));
    expect(
      sending.recipientOf({ ...customer, providerAccountId: '999' }),
    ).toBeNull();
    expect(
      sending.recipientOf({ ...customer, externalContactId: null }),
    ).toBeNull();
    // Without a token, Instagram still receives but refuses to send with a clear 503.
    const receiveOnly = new InstagramAdapter(config());
    expect(receiveOnly.enabled).toBe(false);
    expect(() => receiveOnly.assertEnabled()).toThrow(
      'El envío por Instagram no está configurado',
    );
  });
  it('envía al endpoint de la cuenta con el token y valida la respuesta', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ recipient_id: '456', message_id: 'mid.out' }),
        ),
      );
    await expect(
      new InstagramAdapter(namingConfig()).sendMessage(igsid('456'), 'Hola'),
    ).resolves.toBe('mid.out');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v26.0/123/messages',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer EAAtoken',
        }) as unknown,
        body: JSON.stringify({
          recipient: { id: '456' },
          message: { text: 'Hola' },
        }),
      }),
    );
    // A response for another recipient or without an ID is never taken as sent.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ recipient_id: '999', message_id: 'x' })),
    );
    await expect(
      new InstagramAdapter(namingConfig()).sendMessage(igsid('456'), 'Hola'),
    ).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it.each([
    [400, 'failed'],
    [403, 'failed'],
    [429, 'retry'],
    [500, 'unknown'],
    [408, 'unknown'],
  ] as const)('HTTP %s se clasifica %s', async (status, outcome) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 10 } }), { status }),
      );
    await expect(
      new InstagramAdapter(namingConfig()).sendMessage(igsid('456'), 'Hola'),
    ).rejects.toMatchObject({ outcome });
  });
  it('la red caída queda en estado incierto, sin reenviar', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));
    await expect(
      new InstagramAdapter(namingConfig()).sendMessage(igsid('456'), 'Hola'),
    ).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it('rechaza sin llamar a Meta un destino inválido o un texto de más de 1000 bytes', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const adapter = new InstagramAdapter(namingConfig());
    for (const [address, text] of [
      [igsid('no-numérico'), 'Hola'],
      [{ recipientPhone: '+51987654321', recipientExternalId: null }, 'Hola'],
      [igsid('456'), 'á'.repeat(501)],
    ] as const)
      await expect(adapter.sendMessage(address, text)).rejects.toMatchObject({
        outcome: 'failed',
      });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exceedsTextLimit(adapter, 'á'.repeat(500))).toBe(false);
    expect(exceedsTextLimit(adapter, 'á'.repeat(501))).toBe(true);
    expect(exceedsTextLimit(adapter, 'a'.repeat(1001))).toBe(true);
  });
});

describe('Instagram HTTP webhook (raw-body signature)', () => {
  let app: INestApplication;
  let server: App;
  const ingestion = {
    ingestFromProvider: jest.fn().mockResolvedValue([]),
    quarantine: jest.fn().mockResolvedValue(undefined),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InstagramController],
      providers: [
        InstagramAdapter,
        InstagramService,
        { provide: InstagramConfig, useFactory: config },
        { provide: MessagesService, useValue: ingestion },
        {
          provide: CustomersService,
          useValue: { setNameIfMissing: jest.fn() },
        },
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
    server = app.getHttpServer() as App;
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => {
    await app.close();
  });
  it('returns the exact challenge without CRM authorization', async () => {
    const response = await request(server)
      .get('/webhooks/instagram')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': settings.INSTAGRAM_VERIFY_TOKEN,
        'hub.challenge': '001234',
      })
      .expect(200);
    expect(response.text).toBe('001234');
    expect(response.headers['content-type']).toContain('text/plain');
  });
  it('rejects absent or incorrect verification parameters', async () => {
    await request(server).get('/webhooks/instagram').expect(403);
    await request(server)
      .get('/webhooks/instagram')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': '123',
      })
      .expect(403);
  });
  it('accepts a signed message and invokes shared durable ingestion', async () => {
    const raw = JSON.stringify(event(), null, 2);
    await request(server)
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature(raw))
      .send(raw)
      .expect(200, { received: true });
    expect(ingestion.ingestFromProvider).toHaveBeenCalledWith(
      [expect.objectContaining({ channel: 'INSTAGRAM', content: 'Hola' })],
      [],
    );
  });
  it('rejects unsigned and altered payloads before persistence', async () => {
    const raw = JSON.stringify(event());
    await request(server).post('/webhooks/instagram').send(event()).expect(403);
    await request(server)
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature(raw + ' '))
      .send(raw)
      .expect(403);
    expect(ingestion.ingestFromProvider).not.toHaveBeenCalled();
  });
  it('quarantines invalid signed items without exposing their contents', async () => {
    const raw = JSON.stringify(event([item({ message: {} })]));
    await request(server)
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature(raw))
      .send(raw)
      .expect(200);
    expect(ingestion.quarantine).toHaveBeenCalledWith(
      [expect.stringMatching(/^[a-f0-9]{64}$/)],
      'INSTAGRAM_EVENT_INVALID',
    );
  });
  it('does not acknowledge transient database failures', async () => {
    ingestion.ingestFromProvider.mockRejectedValueOnce(
      new Error('temporary test failure'),
    );
    const raw = JSON.stringify(event());
    await request(server)
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature(raw))
      .send(raw)
      .expect(500);
  });
});
