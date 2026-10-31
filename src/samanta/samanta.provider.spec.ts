import { ConfigService } from '@nestjs/config';
import { SamantaConfig } from './samanta.config';
import { parseDraftResponse, SamantaProvider } from './samanta.provider';

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
const config = (extra: Record<string, string> = {}) =>
  new SamantaConfig(
    new ConfigService({
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
    const disabled = new SamantaConfig(new ConfigService({}));
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
  ])('rechaza estructura de salida no válida %#', (body) => {
    expect(() => parseDraftResponse(response(body))).toThrow(
      'AI_INVALID_RESPONSE',
    );
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
      max_output_tokens: 1024,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(body).not.toHaveProperty('tools');
  });
  it.each([401, 429, 500])(
    'normaliza HTTP %s y nunca filtra contenido',
    async (status) => {
      const fetcher = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('secret-token-customer', { status }));
      await expect(
        new SamantaProvider(config()).generate('{}'),
      ).rejects.toThrow(
        status === 429 ? 'AI_RATE_LIMITED' : 'AI_REQUEST_REJECTED',
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
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
