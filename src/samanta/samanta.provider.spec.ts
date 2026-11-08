import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SamantaConfig } from './samanta.config';
import {
  parseDraftResponse,
  SamantaProvider,
  SamantaProviderError,
} from './samanta.provider';

const draft = {
  content: '¿Para qué fecha deseas reservar?',
  intent: 'RESERVATION',
  requiresHuman: true,
  missingFields: ['fecha'],
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
