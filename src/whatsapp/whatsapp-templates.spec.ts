import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { WhatsAppConfig } from './whatsapp.config';
import { ChannelSendError } from '../messaging/channel-transport';

const adapter = () =>
  new WhatsAppAdapter(
    new WhatsAppConfig(
      new ConfigService({
        WHATSAPP_ENABLED: 'true',
        MESSAGING_ENABLED: 'true',
        REDIS_URL: 'redis://localhost:6379',
        WHATSAPP_ACCESS_TOKEN: 'fake-test-token',
        WHATSAPP_VERIFY_TOKEN: 'fake-test-verify',
        WHATSAPP_PHONE_NUMBER_ID: '123',
        WHATSAPP_BUSINESS_ACCOUNT_ID: '456',
        WHATSAPP_API_VERSION: 'v25.0',
        META_APP_SECRET: 'fake-test-secret',
      }),
    ),
  );
const event = (message: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '456',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: '123' },
            messages: [
              {
                id: 'wamid.reply',
                from: '51987654321',
                timestamp: String(Math.floor(Date.now() / 1000)),
                context: { from: '51900000000', id: 'wamid.template' },
                ...message,
              },
            ],
          },
        },
      ],
    },
  ],
});

describe('WhatsApp: plantillas y respuestas con botones', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('envía la plantilla con su idioma y los parámetros del cuerpo en orden', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.tpl' }] })),
    );
    await expect(
      adapter().sendTemplate(
        { recipientPhone: '+51987654321', recipientExternalId: null },
        {
          name: 'solicitud_reserva_web',
          language: 'es',
          parameters: ['Ana', 'SM-20261029-B65A25', '29/10/2026', '19:30', '3'],
        },
      ),
    ).resolves.toBe('wamid.tpl');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v25.0/123/messages');
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '51987654321',
      type: 'template',
      template: {
        name: 'solicitud_reserva_web',
        language: { code: 'es' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana' },
              { type: 'text', text: 'SM-20261029-B65A25' },
              { type: 'text', text: '29/10/2026' },
              { type: 'text', text: '19:30' },
              { type: 'text', text: '3' },
            ],
          },
        ],
      },
    });
  });
  it('quita saltos de línea y espacios repetidos de los parámetros', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.tpl' }] })),
    );
    await adapter().sendTemplate(
      { recipientPhone: '+51987654321', recipientExternalId: null },
      {
        name: 'x',
        language: 'es',
        parameters: ['Ana\n\tMaría     Pérez', '  '],
      },
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      template: { components: { parameters: { text: string }[] }[] };
    };
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Ana María Pérez' },
      { type: 'text', text: '-' },
    ]);
  });
  it('un rechazo de Meta (plantilla no aprobada) es definitivo', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 132001, message: 'no existe' } }),
        { status: 400 },
      ),
    );
    await expect(
      adapter().sendTemplate(
        { recipientPhone: '+51987654321', recipientExternalId: null },
        { name: 'x', language: 'es', parameters: [] },
      ),
    ).rejects.toMatchObject({
      outcome: 'failed',
    } satisfies Partial<ChannelSendError>);
  });
  it('un toque en un botón de plantilla llega como texto', () => {
    const [command] = adapter().parse(
      event({
        type: 'button',
        button: { text: 'Sí, continuar', payload: 'Sí, continuar' },
      }),
    ).messages;
    expect(command).toMatchObject({ type: 'TEXT', content: 'Sí, continuar' });
  });
  it.each([
    ['button_reply', { id: 'confirm', title: 'Confirmar' }, 'Confirmar'],
    [
      'list_reply',
      { id: 'r1', title: 'Sábado', description: '20:00' },
      'Sábado',
    ],
  ])(
    'una respuesta interactiva (%s) llega como su título',
    (kind, reply, text) => {
      const [command] = adapter().parse(
        event({
          type: 'interactive',
          interactive: { type: kind, [kind]: reply },
        }),
      ).messages;
      expect(command).toMatchObject({ type: 'TEXT', content: text });
    },
  );
  it('un botón sin texto sigue siendo un mensaje no compatible', () => {
    const [command] = adapter().parse(
      event({ type: 'button', button: { payload: 'x' } }),
    ).messages;
    expect(command.type).toBe('OTHER');
  });
  it('M9.2: un botón conserva el mensaje que responde (context.id) y se marca como botón', () => {
    const [command] = adapter().parse(
      event({
        type: 'button',
        button: { text: 'Aceptar', payload: 'Aceptar' },
        context: { from: '51900000000', id: 'wamid.plantilla-dueno' },
      }),
    ).messages;
    expect(command).toMatchObject({
      type: 'TEXT',
      content: 'Aceptar',
      buttonReply: true,
      replyToExternalMessageId: 'wamid.plantilla-dueno',
    });
  });
  it('M9.2: un texto citado conserva context.id pero no es un botón', () => {
    const [command] = adapter().parse(
      event({
        type: 'text',
        text: { body: 'Aceptar' },
        context: { id: 'wamid.citado' },
      }),
    ).messages;
    expect(command).toMatchObject({
      type: 'TEXT',
      replyToExternalMessageId: 'wamid.citado',
    });
    expect(command.buttonReply).toBeUndefined();
    const [plain] = adapter().parse(
      event({ type: 'text', text: { body: 'Hola' }, context: undefined }),
    ).messages;
    expect(plain.replyToExternalMessageId).toBeUndefined();
  });
});
