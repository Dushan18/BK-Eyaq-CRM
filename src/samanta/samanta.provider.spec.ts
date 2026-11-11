import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SamantaConfig } from './samanta.config';
import {
  parseDraftResponse,
  SamantaProvider,
  SamantaProviderError,
} from './samanta.provider';

const none = {
  action: 'NONE',
  language: 'es',
  date: null,
  time: null,
  people: null,
  service: null,
  specialRequirements: null,
};
const draft = {
  content: '¿Para qué fecha deseas reservar?',
  intent: 'RESERVATION',
  requiresHuman: true,
  missingFields: ['fecha'],
  reservation: none,
};
const response = (data: unknown = draft) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(data) }],
    },
  ],
  usage: { input_tokens: 120, output_tokens: 30 },
});
// Reads only these values: ConfigService would give priority to process.env.
const env = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;
const config = (extra: Record<string, string> = {}) =>
  new SamantaConfig(
    env({
      SAMANTA_ENABLED: 'true',
      OPENAI_API_KEY: 'fake-api-key',
      ...extra,
    }),
  );

describe('Samanta: proveedor y configuración sin llamadas reales', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  it('desactivada por defecto y bloquea llamadas', async () => {
    const disabled = new SamantaConfig(env({}));
    expect(disabled.enabled).toBe(false);
    const fetcher = jest.spyOn(globalThis, 'fetch');
    await expect(new SamantaProvider(disabled).generate('{}')).rejects.toThrow(
      'desactivada',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requiere clave al activar', () => {
    expect(() => config({ OPENAI_API_KEY: '' })).toThrow('OPENAI_API_KEY');
  });
  it.each(['0', '-1', 'NaN', '1.5', '10001'])(
    'rechaza límite diario inválido %s',
    (limit) => {
      expect(() => config({ SAMANTA_DAILY_LIMIT: limit })).toThrow();
    },
  );
  it('una variable vacía usa su valor por defecto', () => {
    const empty = config({
      SAMANTA_MODEL: '',
      SAMANTA_DAILY_LIMIT: '',
      SAMANTA_TIMEOUT_MS: ' ',
      SAMANTA_AUTO_ENABLED: '',
      SAMANTA_AUTO_CHANNELS: '',
    });
    expect(empty).toMatchObject({
      model: 'gpt-6-luna',
      dailyLimit: 100,
      timeoutMs: 20000,
      maxOutputTokens: 4096,
      autoEnabled: false,
      autoSend: false,
      autoChannels: ['WHATSAPP', 'FACEBOOK', 'INSTAGRAM'],
    });
  });
  it.each(['TRUE', '1', 'yes', 'verdadero'])(
    'rechaza el interruptor ambiguo %s en vez de apagar Samanta en silencio',
    (value) => {
      expect(() => new SamantaConfig(env({ SAMANTA_ENABLED: value }))).toThrow(
        'SAMANTA_ENABLED debe ser true o false',
      );
    },
  );
  it('desactivada no valida el resto: un valor erróneo no impide arrancar', () => {
    const disabled = new SamantaConfig(
      env({
        SAMANTA_ENABLED: 'false',
        SAMANTA_DAILY_LIMIT: 'abc',
        SAMANTA_MODEL: 'modelo no válido',
      }),
    );
    expect(disabled.dailyLimit).toBe(100);
  });
  it('el modo automático exige Samanta activa y canales conocidos', () => {
    expect(
      () => new SamantaConfig(env({ SAMANTA_AUTO_ENABLED: 'true' })),
    ).toThrow('SAMANTA_AUTO_ENABLED requiere SAMANTA_ENABLED=true');
    expect(() => config({ SAMANTA_AUTO_CHANNELS: 'WHATSAPP,WEBSITE' })).toThrow(
      'SAMANTA_AUTO_CHANNELS',
    );
    expect(
      config({
        SAMANTA_AUTO_ENABLED: 'true',
        SAMANTA_AUTO_SEND: 'true',
        SAMANTA_AUTO_CHANNELS: 'WHATSAPP, INSTAGRAM',
      }),
    ).toMatchObject({
      autoEnabled: true,
      autoSend: true,
      autoChannels: ['WHATSAPP', 'INSTAGRAM'],
    });
  });
  it('interpreta salida estructurada y uso', () => {
    expect(parseDraftResponse(response())).toEqual({
      ...draft,
      inputTokens: 120,
      outputTokens: 30,
    });
  });
  it.each([
    { ...draft, content: '' },
    { ...draft, content: 'a'.repeat(4097) },
    { ...draft, intent: 'EXECUTE' },
    { ...draft, requiresHuman: 'false' },
    { ...draft, missingFields: Array(9).fill('x') },
    { ...draft, missingFields: [55] },
    { ...draft, extra: 'ignored?' },
    { ...draft, content: 'Hola\u0000mundo' },
    { ...draft, missingFields: ['fe\u0007cha'] },
  ])('rechaza estructura de salida no válida %#', (body) => {
    expect(() => parseDraftResponse(response(body))).toThrow(
      'AI_INVALID_RESPONSE',
    );
  });
  it('acepta saltos de línea y tabulaciones en el texto', () => {
    expect(
      parseDraftResponse(response({ ...draft, content: 'Hola\n\tmundo\r\n' }))
        .content,
    ).toBe('Hola\n\tmundo\r\n');
  });
  it('una respuesta incompleta conserva los tokens cobrados', () => {
    let error: unknown;
    try {
      parseDraftResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', summary: [] }],
        usage: { input_tokens: 6200, output_tokens: 1024 },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SamantaProviderError);
    expect(error).toMatchObject({
      code: 'AI_INCOMPLETE_RESPONSE',
      usage: { inputTokens: 6200, outputTokens: 1024 },
    });
  });
  it('rechaza respuesta incompleta, rechazo y herramientas', () => {
    expect(() =>
      parseDraftResponse({ ...response(), status: 'incomplete' }),
    ).toThrow('AI_INCOMPLETE_RESPONSE');
    expect(() =>
      parseDraftResponse({
        ...response(),
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'refusal' }],
          },
        ],
      }),
    ).toThrow('AI_REFUSED_RESPONSE');
    expect(() =>
      parseDraftResponse({
        ...response(),
        output: [{ type: 'function_call' }],
      }),
    ).toThrow('AI_INVALID_RESPONSE');
    expect(() =>
      parseDraftResponse({
        ...response(),
        usage: { input_tokens: -1, output_tokens: 0 },
      }),
    ).toThrow('AI_INVALID_RESPONSE');
  });
  it('usa Responses con store:false, JSON estricto, sin herramientas ni reintentos', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(response())));
    await expect(
      new SamantaProvider(config()).generate('{"history":[]}'),
    ).resolves.toMatchObject(draft);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body: unknown = JSON.parse(options?.body as string);
    expect(body).toMatchObject({
      store: false,
      model: 'gpt-6-luna',
      max_output_tokens: 4096,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(body).not.toHaveProperty('tools');
  });
  it('el modo automático avisa al modelo que su respuesta se envía sin revisión', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(response()))),
      );
    const provider = new SamantaProvider(config());
    await provider.generate('{}', 'draft');
    await provider.generate('{}', 'auto');
    const [draftBody, autoBody] = fetcher.mock.calls.map(
      ([, options]) =>
        JSON.parse(options?.body as string) as { instructions: string },
    );
    expect(draftBody.instructions).toContain('borrador');
    expect(autoBody.instructions).toContain('se envía directamente al cliente');
    expect(autoBody.instructions).toContain('reply.maxCharacters');
  });
  it('M8.2: el modo automático propone y confirma solicitudes en vez de transferir al confirmar', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(response()))),
      );
    const provider = new SamantaProvider(config());
    await provider.generate('{}', 'draft');
    await provider.generate('{}', 'auto');
    const [draftBody, autoBody] = fetcher.mock.calls.map(
      ([, options]) =>
        JSON.parse(options?.body as string) as {
          instructions: string;
          text: {
            format: {
              schema: {
                required: string[];
                properties: {
                  reservation: {
                    required: string[];
                    additionalProperties: boolean;
                  };
                };
              };
            };
          };
        },
    );
    expect(draftBody.instructions).toContain(
      'reservation.action siempre es "NONE"',
    );
    expect(autoBody.instructions).toContain('"PROPOSE"');
    expect(autoBody.instructions).toContain('customer.awaitingConfirmation');
    expect(autoBody.instructions).toContain(
      'nunca digas que la reserva está confirmada',
    );
    // A confirmed summary is no longer a reason to hand the conversation over.
    expect(autoBody.instructions).not.toContain(
      'cuando el cliente confirme los datos completos de su reserva',
    );
    const { schema } = autoBody.text.format;
    expect(schema.required).toContain('reservation');
    expect(schema.properties.reservation).toMatchObject({
      additionalProperties: false,
      required: [
        'action',
        'language',
        'date',
        'time',
        'people',
        'service',
        'specialRequirements',
      ],
    });
  });
  it('M8.2: interpreta la acción de reserva propuesta', () => {
    const reservation = {
      action: 'PROPOSE',
      language: 'en',
      date: '2026-11-20',
      time: '19:00',
      people: 4,
      service: 'Menú degustación',
      specialRequirements: 'Mesa en terraza',
    };
    expect(
      parseDraftResponse(response({ ...draft, reservation })).reservation,
    ).toEqual(reservation);
  });
  it.each([
    { reservation: undefined },
    { reservation: null },
    { reservation: { ...none, action: 'CREATE' } },
    { reservation: { ...none, language: 'fr' } },
    { reservation: { ...none, people: 2.5 } },
    { reservation: { ...none, people: '4' } },
    { reservation: { ...none, date: '2026-11-20T19:00' } },
    { reservation: { ...none, service: 'x'.repeat(201) } },
    { reservation: { ...none, specialRequirements: 'a\u0000b' } },
    { reservation: { ...none, extra: true } },
  ])('M8.2: rechaza una acción de reserva mal formada %#', (body) => {
    expect(() => parseDraftResponse(response({ ...draft, ...body }))).toThrow(
      'AI_INVALID_RESPONSE',
    );
  });
  it('el prompt pide content no vacío también en PROPOSE y CONFIRM', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(response())));
    await new SamantaProvider(config()).generate('{}', 'auto');
    const { instructions } = JSON.parse(
      fetcher.mock.calls[0][1]?.body as string,
    ) as { instructions: string };
    expect(instructions).toContain('nunca vacío');
    expect(instructions).toContain(
      'En las tres acciones content nunca va vacío',
    );
  });
  describe('content vacío (OpenAI lo deja así cuando el backend escribe la respuesta)', () => {
    const propose = {
      ...none,
      action: 'PROPOSE',
      date: '2026-11-20',
      time: '19:30',
      people: 4,
    };
    it.each([
      ['PROPOSE con datos válidos', propose, ''],
      ['CONFIRM', { ...none, action: 'CONFIRM' }, '   '],
    ])('%s: se acepta y queda como ""', (_name, reservation, content) => {
      const parsed = parseDraftResponse(
        response({ ...draft, requiresHuman: false, content, reservation }),
      );
      expect(parsed.content).toBe('');
      expect(parsed.reservation).toEqual(reservation);
    });
    it('con requiresHuman también se acepta (el backend pone el texto de respaldo)', () => {
      expect(
        parseDraftResponse(
          response({ ...draft, content: '', reservation: propose }),
        ),
      ).toMatchObject({ content: '', requiresHuman: true });
    });
    it.each([
      ['NONE vacío', { content: '', reservation: none }],
      ['NONE solo espacios', { content: ' \n\t', reservation: none }],
      ['sin reservation', { content: '', reservation: undefined }],
      [
        'acción inválida',
        { content: '', reservation: { ...propose, action: 'CREATE' } },
      ],
      [
        'idioma inválido',
        { content: '', reservation: { ...propose, language: 'fr' } },
      ],
      [
        'personas no enteras',
        { content: '', reservation: { ...propose, people: 2.5 } },
      ],
      [
        'intent inválido',
        { content: '', intent: 'EXECUTE', reservation: propose },
      ],
      ['campo extra', { content: '', reservation: propose, confirmed: true }],
      ['content no es texto', { content: null, reservation: propose }],
    ])('%s: sigue siendo AI_INVALID_RESPONSE', (_name, body) => {
      expect(() => parseDraftResponse(response({ ...draft, ...body }))).toThrow(
        'AI_INVALID_RESPONSE',
      );
    });
  });
  it.each([
    [401, 'invalid_api_key', 'AI_AUTH_FAILED'],
    [403, 'unsupported_country_region_territory', 'AI_AUTH_FAILED'],
    [404, 'model_not_found', 'AI_MODEL_NOT_FOUND'],
    [400, 'unsupported_parameter', 'AI_REQUEST_REJECTED'],
    [429, 'rate_limit_exceeded', 'AI_RATE_LIMITED'],
    [429, 'insufficient_quota', 'AI_QUOTA_EXCEEDED'],
    [500, 'server_error', 'AI_UNAVAILABLE'],
    [503, 'server_overloaded', 'AI_UNAVAILABLE'],
  ])(
    'normaliza HTTP %s (%s) como %s y registra solo códigos',
    async (status, providerCode, expected) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'secret-token-customer sk-proj-abc',
              code: providerCode,
              type: providerCode,
            },
          }),
          { status, headers: { 'x-request-id': 'req_123' } },
        ),
      );
      await expect(
        new SamantaProvider(config()).generate('{}'),
      ).rejects.toMatchObject({ code: expected });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).toContain(`"httpStatus":${status}`);
      expect(logged).toContain('"requestId":"req_123"');
      expect(logged).not.toContain('secret-token-customer');
      expect(logged).not.toContain('sk-proj');
    },
  );
  it('un error sin cuerpo JSON se normaliza igual', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('secret-token-customer', { status: 500 }),
      );
    await expect(
      new SamantaProvider(config()).generate('{}'),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });
  it('limita tamaño de respuesta', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('a'.repeat(262145)));
    await expect(new SamantaProvider(config()).generate('{}')).rejects.toThrow(
      'AI_RESPONSE_TOO_LARGE',
    );
  });
  it('corta la solicitud por timeout sin reintentar', async () => {
    jest.useFakeTimers();
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new Error('sensitive upstream error')),
          );
        }),
    );
    const operation = expect(
      new SamantaProvider(config()).generate('{}'),
    ).rejects.toThrow('AI_TIMEOUT');
    await jest.advanceTimersByTimeAsync(20001);
    await operation;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
