import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import {
  ForbiddenException,
  Logger,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createHmac } from 'node:crypto';
import { WhatsAppConfig } from './whatsapp.config';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import type { MessagesService } from '../messaging/messages.service';
import type { MessageStatusService } from '../messaging/message-status.service';
import type { CustomersService } from '../customers/customers.service';
import { ChannelSendError } from '../messaging/channel-transport';
import { nextDeliveryStatus } from '../messaging/message-status.service';
import { OutboundMessageDto } from '../messaging/outbound-message.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

const settings = {
  WHATSAPP_ENABLED: 'true',
  MESSAGING_ENABLED: 'true',
  REDIS_URL: 'redis://localhost:6379',
  WHATSAPP_ACCESS_TOKEN: 'fake-test-token',
  WHATSAPP_VERIFY_TOKEN: 'fake-test-verify',
  WHATSAPP_PHONE_NUMBER_ID: '123',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '456',
  WHATSAPP_API_VERSION: 'v25.0',
  META_APP_SECRET: 'fake-test-secret',
};
const config = () => new WhatsAppConfig(new ConfigService(settings));
const toPhone = (phone: string) => ({
  recipientPhone: phone,
  recipientExternalId: null,
});
const message = (extra: object = {}) => ({
  id: 'wamid.test',
  from: '51987654321',
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: 'text',
  text: { body: 'Hola' },
  ...extra,
});
const event = (
  messages: unknown[] = [message()],
  statuses: unknown[] = [],
) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '456',
      changes: [
        {
          field: 'messages',
          value: { metadata: { phone_number_id: '123' }, messages, statuses },
        },
      ],
    },
  ],
});

describe('WhatsApp configuración y adapter', () => {
  it('deshabilitado no requiere secretos; habilitado valida sin exponer valores', () => {
    expect(new WhatsAppConfig(new ConfigService({})).enabled).toBe(false);
    expect(
      () => new WhatsAppConfig(new ConfigService({ WHATSAPP_ENABLED: 'yes' })),
    ).toThrow();
    for (const key of Object.keys(settings)) {
      if (key === 'WHATSAPP_ENABLED') continue;
      expect(
        () => new WhatsAppConfig(new ConfigService({ ...settings, [key]: '' })),
      ).toThrow();
    }
    expect(config().enabled).toBe(true);
  });
  it('recorre entries/changes/messages/statuses y normaliza teléfono', () => {
    const adapter = new WhatsAppAdapter(config());
    const payload = event(
      [message(), message({ id: 'wamid.two' })],
      [{ id: 'wamid.out', status: 'read', timestamp: message().timestamp }],
    );
    payload.entry.push(...event([message({ id: 'wamid.three' })]).entry);
    const result = adapter.parse(payload);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({
      channel: 'WHATSAPP',
      providerAccountId: '123',
      contact: { phone: '+51987654321' },
      type: 'TEXT',
      content: 'Hola',
    });
    expect(result.statuses[0]).toMatchObject({
      status: 'READ',
      externalMessageId: 'wamid.out',
    });
  });
  it.each(['image', 'document'])('guarda solo metadata de %s', (type) => {
    const result = new WhatsAppAdapter(config()).parse(
      event([
        message({
          type,
          [type]: {
            id: 'media-1',
            mime_type: 'example/type',
            filename: 'test.pdf',
            caption: 'Carta',
          },
        }),
      ]),
    );
    expect(result.messages[0].attachments?.[0]).toMatchObject({
      externalMediaId: 'media-1',
      mimeType: 'example/type',
    });
    expect(result.messages[0].content).toBe('Carta');
  });
  it.each(['audio', 'video', 'sticker', 'future-type'])(
    '%s produce OTHER seguro',
    (type) => {
      expect(
        new WhatsAppAdapter(config()).parse(event([message({ type })]))
          .messages[0].type,
      ).toBe('OTHER');
    },
  );
  it('aísla eventos inválidos sin perder los otros y conserva solo fingerprints', () => {
    const result = new WhatsAppAdapter(config()).parse(
      event([null, message({ timestamp: 'invalid' }), message()]),
    );
    expect(result.messages).toHaveLength(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((v) => /^[a-f0-9]{64}$/.test(v))).toBe(true);
  });
  it('ignora eventos de otras cuentas/números y tipos desconocidos', () => {
    const adapter = new WhatsAppAdapter(config());
    const payload = event();
    payload.entry[0].id = '999';
    expect(adapter.parse(payload).messages).toHaveLength(0);
    payload.entry[0].id = '456';
    payload.entry[0].changes[0].value.metadata.phone_number_id = '999';
    expect(adapter.parse(payload).messages).toHaveLength(0);
    expect(adapter.parse({ object: 'other' }).messages).toHaveLength(0);
  });
  it('rechaza fecha futura que abriría ventana artificial', () => {
    expect(
      new WhatsAppAdapter(config()).parse(
        event([
          message({ timestamp: String(Math.floor(Date.now() / 1000) + 10000) }),
        ]),
      ).messages,
    ).toHaveLength(0);
  });
  describe('fetch siempre simulado: ningún mensaje real', () => {
    let fetchMock: jest.SpyInstance;
    beforeEach(() => {
      fetchMock = jest.spyOn(globalThis, 'fetch');
    });
    afterEach(() => fetchMock.mockRestore());
    it('envía texto con versión configurada y recupera wamid', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), {
          status: 200,
        }),
      );
      expect(
        await new WhatsAppAdapter(config()).sendMessage(
          toPhone('+51987654321'),
          'Hola',
        ),
      ).toBe('wamid.out');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://graph.facebook.com/v25.0/123/messages');
      expect(JSON.parse(init.body as string)).toMatchObject({
        to: '51987654321',
        type: 'text',
        text: { body: 'Hola' },
      });
      expect(init.redirect).toBe('error');
    });
    it.each([
      [400, 'failed'],
      [401, 'failed'],
      [429, 'retry'],
      [500, 'unknown'],
      [503, 'unknown'],
      [408, 'unknown'],
    ] as const)('HTTP %s se clasifica %s', async (status, outcome) => {
      fetchMock.mockResolvedValue(
        new Response('private provider error', {
          status,
          headers: { 'retry-after': '30' },
        }),
      );
      await expect(
        new WhatsAppAdapter(config()).sendMessage(
          toPhone('+51987654321'),
          'Hola',
        ),
      ).rejects.toMatchObject({ outcome });
    });
    it('timeout/red queda UNKNOWN sin filtrar excepción', async () => {
      fetchMock.mockRejectedValue(new Error('Authorization: SECRET'));
      await expect(
        new WhatsAppAdapter(config()).sendMessage(
          toPhone('+51987654321'),
          'Hola',
        ),
      ).rejects.toEqual(new ChannelSendError('unknown'));
    });
    it.each([
      [400, 'failed'],
      [401, 'failed'],
      [429, 'retry'],
      [500, 'unknown'],
      [408, 'unknown'],
    ] as const)(
      'HTTP %s conserva diagnóstico sin alterar %s',
      async (status, outcome) => {
        fetchMock.mockResolvedValue(
          new Response(
            JSON.stringify({
              error: {
                code: 131000,
                error_subcode: 7,
                is_transient: true,
                message: 'private-token private-phone private-content',
              },
            }),
            { status },
          ),
        );
        await expect(
          new WhatsAppAdapter(config()).sendMessage(
            toPhone('+51987654321'),
            'Hola',
          ),
        ).rejects.toMatchObject({
          outcome,
          diagnostic: {
            httpStatus: status,
            metaCode: 131000,
            metaSubcode: 7,
            isTransient: true,
          },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );
    it('respuesta exitosa sin wamid no permite reenvío automático', async () => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
      await expect(
        new WhatsAppAdapter(config()).sendMessage(
          toPhone('+51987654321'),
          'Hola',
        ),
      ).rejects.toMatchObject({ outcome: 'unknown' });
    });
  });
});

describe('Identidad y nombre del cliente de WhatsApp', () => {
  const withContacts = (
    contacts: unknown,
    messages: unknown[] = [message()],
  ) => {
    const payload = event(messages);
    Object.assign(payload.entry[0].changes[0].value, { contacts });
    return payload;
  };
  const contact = (
    profile: unknown,
    waId: string | undefined = '51987654321',
    userId?: string,
  ) => ({
    ...(waId ? { wa_id: waId } : {}),
    ...(userId ? { user_id: userId } : {}),
    profile,
  });
  const parse = (payload: unknown) =>
    new WhatsAppAdapter(config()).parse(payload);
  it('guarda número, ID de WhatsApp, nombre de usuario y apodo del remitente', () => {
    const result = parse(
      withContacts(
        [contact({ name: 'Ana', username: 'ana.q' }, '51987654321', 'PE.111')],
        [message({ from_user_id: 'PE.111' })],
      ),
    );
    expect(result.rejected).toEqual([]);
    expect(result.messages[0].contact).toEqual({
      phone: '+51987654321',
      whatsappUserId: 'PE.111',
      whatsappUsername: 'ana.q',
      whatsappProfileName: 'Ana',
    });
  });
  it('acepta un mensaje sin número cuando Meta lo oculta: lo identifica el ID', () => {
    const result = parse(
      withContacts(
        [contact({ name: 'Ana', username: 'ana.q' }, undefined, 'PE.111')],
        [message({ from: undefined, from_user_id: 'PE.111' })],
      ),
    );
    expect(result.rejected).toEqual([]);
    expect(result.messages[0].contact).toEqual({
      whatsappUserId: 'PE.111',
      whatsappUsername: 'ana.q',
      whatsappProfileName: 'Ana',
    });
  });
  it('quita la @ del nombre de usuario y descarta uno inválido sin perder el apodo', () => {
    const contactOf = (profile: unknown) =>
      parse(withContacts([contact(profile)])).messages[0].contact;
    expect(contactOf({ username: '@ana_q' })).toMatchObject({
      whatsappUsername: 'ana_q',
    });
    expect(
      contactOf({ name: '  Mamá Rosa 🌸  ', username: 'no válido' }),
    ).toEqual({
      phone: '+51987654321',
      whatsappProfileName: 'Mamá Rosa 🌸',
    });
  });
  it('asigna cada perfil al remitente de su mensaje', () => {
    const result = parse(
      withContacts(
        [contact({ name: 'Ana' }), contact({ name: 'Luis' }, '51911111111')],
        [message(), message({ id: 'wamid.luis', from: '51911111111' })],
      ),
    );
    expect(result.messages.map((m) => m.contact.whatsappProfileName)).toEqual([
      'Ana',
      'Luis',
    ]);
  });
  it.each([
    ['sin contacts', undefined],
    ['contacts que no es lista', { wa_id: '51987654321' }],
    ['contacto nulo', [null]],
    ['sin perfil', [{ wa_id: '51987654321' }]],
    ['perfil vacío', [contact({ name: '   ', username: '' })]],
    ['otro remitente', [contact({ name: 'Otra persona' }, '51900000000')]],
  ])('%s: el mensaje se guarda igual, solo con el número', (_, contacts) => {
    const result = parse(withContacts(contacts));
    expect(result.rejected).toEqual([]);
    expect(result.messages[0].contact).toEqual({ phone: '+51987654321' });
  });
  it.each([
    ['sin número ni ID', { from: undefined }],
    ['ID inválido', { from_user_id: 'no es un id' }],
    ['número inválido aunque haya ID', { from: '0123', from_user_id: 'PE.1' }],
  ])('rechaza un mensaje %s', (_, extra) => {
    const result = parse(event([message(extra)]));
    expect(result.messages).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });
  it('un cambio de ID de WhatsApp no crea mensaje: registra el anterior y el nuevo', () => {
    const result = parse(
      event([
        message({
          type: 'system',
          from: undefined,
          from_user_id: 'PE.new',
          system: { type: 'user_changed_user_id', previous_user_id: 'PE.old' },
        }),
      ]),
    );
    expect(result.messages).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.userIdChanges).toEqual([
      { previous: 'PE.old', current: 'PE.new' },
    ]);
  });
  it('responde al número si lo hay y al ID de WhatsApp si no', async () => {
    const adapter = new WhatsAppAdapter(config());
    const customer = {
      normalizedPhone: '+51987654321',
      providerAccountId: null,
      externalContactId: null,
      whatsappUserId: 'PE.111',
    };
    expect(adapter.recipientOf(customer)).toEqual({
      recipientPhone: '+51987654321',
      recipientExternalId: 'PE.111',
    });
    expect(adapter.recipientOf({ ...customer, normalizedPhone: null })).toEqual(
      { recipientPhone: null, recipientExternalId: 'PE.111' },
    );
    expect(
      adapter.recipientOf({
        ...customer,
        normalizedPhone: null,
        whatsappUserId: null,
      }),
    ).toBeNull();
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] })),
        ),
      );
    const bodies = async (address: {
      recipientPhone: string | null;
      recipientExternalId: string | null;
    }) => {
      await adapter.sendMessage(address, 'Hola');
      const [, init] = fetchMock.mock.lastCall as [string, RequestInit];
      return JSON.parse(init.body as string) as Record<string, unknown>;
    };
    const both = await bodies(adapter.recipientOf(customer)!);
    expect(both).toMatchObject({ to: '51987654321' });
    expect(both).not.toHaveProperty('recipient');
    const onlyId = await bodies({
      recipientPhone: null,
      recipientExternalId: 'PE.111',
    });
    expect(onlyId).toMatchObject({ recipient: 'PE.111', type: 'text' });
    expect(onlyId).not.toHaveProperty('to');
    fetchMock.mockRestore();
  });
  it('mueve el ID cambiado antes de guardar y nombra con @usuario o apodo, sin Meta', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const setNameIfMissing = jest.fn().mockResolvedValue(true);
    const replaceWhatsAppUserId = jest.fn().mockResolvedValue(true);
    const stored = (
      id: string,
      firstName: string | null,
      contact: Record<string, string>,
    ) => ({
      command: { externalMessageId: `wamid.${id}`, contact },
      customer: { id, firstName, lastName: null },
    });
    const ingestFromProvider = jest.fn().mockResolvedValue([
      stored('ana', null, {
        whatsappUsername: 'ana.q',
        whatsappProfileName: 'Ana',
      }),
      stored('ana', null, { whatsappUsername: 'ana.q' }),
      stored('rosa', null, { whatsappProfileName: 'Mamá Rosa' }),
      stored('luis', 'Nombre del CRM', { whatsappProfileName: 'Luis' }),
      stored('sin-perfil', null, { phone: '+51911111111' }),
    ]);
    const raw = JSON.stringify(
      event([
        message({
          type: 'system',
          from: undefined,
          from_user_id: 'PE.new',
          system: { type: 'user_changed_user_id', previous_user_id: 'PE.old' },
        }),
        message(),
      ]),
    );
    await expect(
      new WhatsAppService(
        config(),
        new WhatsAppAdapter(config()),
        {
          ingestFromProvider,
          quarantine: jest.fn(),
        } as unknown as MessagesService,
        { accept: jest.fn() } as unknown as MessageStatusService,
        {
          setNameIfMissing,
          replaceWhatsAppUserId,
        } as unknown as CustomersService,
      ).receive(
        Buffer.from(raw),
        'sha256=' +
          createHmac('sha256', settings.META_APP_SECRET)
            .update(raw)
            .digest('hex'),
      ),
    ).resolves.toEqual({ received: true });
    expect(replaceWhatsAppUserId).toHaveBeenCalledWith('PE.old', 'PE.new');
    expect(replaceWhatsAppUserId.mock.invocationCallOrder[0]).toBeLessThan(
      ingestFromProvider.mock.invocationCallOrder[0],
    );
    expect(setNameIfMissing.mock.calls).toEqual([
      ['ana', '@ana.q'],
      ['rosa', 'Mamá Rosa'],
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

describe('Webhook HTTP con bytes reales', () => {
  let app: INestApplication;
  const ingest = jest.fn().mockResolvedValue([]);
  const accept = jest.fn().mockResolvedValue(undefined);
  const quarantine = jest.fn().mockResolvedValue(undefined);
  const service = new WhatsAppService(
    config(),
    new WhatsAppAdapter(config()),
    {
      ingestFromProvider: ingest,
      quarantine,
    } as unknown as MessagesService,
    { accept } as unknown as MessageStatusService,
    { setNameIfMissing: jest.fn() } as unknown as CustomersService,
  );
  const sign = (body: string) =>
    'sha256=' +
    createHmac('sha256', settings.META_APP_SECRET).update(body).digest('hex');
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WhatsAppController],
      providers: [{ provide: WhatsAppService, useValue: service }],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    ingest.mockClear();
    accept.mockClear();
    quarantine.mockClear();
  });
  it('verifica GET y devuelve challenge sin JSON', async () => {
    await request(app.getHttpServer() as App)
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': settings.WHATSAPP_VERIFY_TOKEN,
        'hub.challenge': '12345',
      })
      .expect(200, '12345');
  });
  it.each([
    ['subscribe', 'wrong'],
    ['wrong', settings.WHATSAPP_VERIFY_TOKEN],
  ])('GET inválido %s', async (mode, token) => {
    await request(app.getHttpServer() as App)
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': mode,
        'hub.verify_token': token,
        'hub.challenge': '123',
      })
      .expect(403);
  });
  it('acepta firma con espacios reales del JSON', async () => {
    const raw = JSON.stringify(event(), null, 3);
    await request(app.getHttpServer() as App)
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw)
      .expect(200);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 'sha256=no', 'sha256=' + '0'.repeat(64)])(
    'rechaza firma %s',
    async (signature) => {
      const req = request(app.getHttpServer() as App)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json');
      if (signature) req.set('X-Hub-Signature-256', signature);
      await req.send(JSON.stringify(event())).expect(403);
      expect(ingest).not.toHaveBeenCalled();
    },
  );
  it('misma estructura con bytes diferentes no coincide', async () => {
    const payload = event();
    await request(app.getHttpServer() as App)
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(JSON.stringify(payload)))
      .send(JSON.stringify(payload, null, 2))
      .expect(403);
  });
  it('fallo DB no se confirma como aceptado', async () => {
    ingest.mockRejectedValueOnce(new Error('DB unavailable'));
    const raw = JSON.stringify(event());
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      await request(app.getHttpServer() as App)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(raw))
        .send(raw)
        .expect(500);
    } finally {
      log.mockRestore();
    }
  });
  it('quarantina lo malformado sin registrar tokens ni contenido', async () => {
    const raw = JSON.stringify(event([null]));
    const log = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await service.receive(Buffer.from(raw), sign(raw));
      expect(quarantine).toHaveBeenCalledWith(
        [expect.stringMatching(/^[a-f0-9]{64}$/)],
        'WHATSAPP_EVENT_INVALID',
      );
      const logs = JSON.stringify(log.mock.calls);
      for (const value of [
        settings.WHATSAPP_ACCESS_TOKEN,
        settings.META_APP_SECRET,
        settings.WHATSAPP_VERIFY_TOKEN,
        raw,
      ])
        expect(logs).not.toContain(value);
    } finally {
      log.mockRestore();
    }
  });
  it('sin raw body no procesa', async () => {
    await expect(service.receive(undefined, sign('{}'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('Estados y DTO de salida', () => {
  it.each([
    ['SENT', 'DELIVERED', 'DELIVERED'],
    ['DELIVERED', 'READ', 'READ'],
    ['READ', 'DELIVERED', 'READ'],
    ['READ', 'FAILED', 'READ'],
    ['DELIVERED', 'FAILED', 'DELIVERED'],
    ['SENT', 'FAILED', 'FAILED'],
    ['FAILED', 'SENT', 'FAILED'],
    ['FAILED', 'DELIVERED', 'DELIVERED'],
    ['UNKNOWN', 'SENT', 'SENT'],
    ['SENT', 'SENT', 'SENT'],
  ] as const)('%s + %s = %s', (current, incoming, expected) =>
    expect(nextDeliveryStatus(current, incoming)).toBe(expected),
  );
  it.each([
    { type: 'TEXT', content: ' ' },
    { type: 'IMAGE', content: 'Hola' },
    { type: 'TEXT', content: 'x'.repeat(4097) },
    { type: 'TEXT', content: 'Hola', to: '123' },
  ])('rechaza DTO inválido', async (body) => {
    expect(
      (
        await validate(plainToInstance(OutboundMessageDto, body), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length,
    ).toBeGreaterThan(0);
  });
});
