import { readSendDiagnostic } from './whatsapp-send-diagnostic';

describe('WhatsApp safe send diagnostics', () => {
  it('retains only numeric codes and transient flag, never provider text', async () => {
    const result = await readSendDiagnostic(
      new Response(
        JSON.stringify({
          error: {
            code: 190,
            error_subcode: 463,
            is_transient: false,
            message: 'Bearer secret-token +51987654321 private message',
            type: 'secret-type',
            fbtrace_id: 'secret-trace',
            error_data: { details: 'private detail' },
          },
        }),
        { status: 401, headers: { 'x-secret': 'secret-header' } },
      ),
    );
    expect(result).toEqual({
      httpStatus: 401,
      metaCode: 190,
      metaSubcode: 463,
      isTransient: false,
    });
  });

  it.each([
    'not JSON with private data',
    'null',
    '[]',
    '{}',
    '{"error":null}',
    '{"error":[]}',
    '{"error":{"code":"190 secret","error_subcode":{},"is_transient":"true"}}',
    '{"error":{"code":-1,"error_subcode":1.5}}',
    '{"error":{"code":1e100}}',
  ])('invalid fields fall back to HTTP only (%s)', async (body) => {
    expect(
      await readSendDiagnostic(new Response(body, { status: 400 })),
    ).toEqual({
      httpStatus: 400,
    });
  });

  it('handles an absent body', async () => {
    expect(
      await readSendDiagnostic(new Response(null, { status: 503 })),
    ).toEqual({
      httpStatus: 503,
    });
  });

  it('caps bytes even when content-length is absent and cancels the stream', async () => {
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16385));
      },
      cancel,
    });
    expect(
      await readSendDiagnostic(new Response(body, { status: 400 })),
    ).toEqual({
      httpStatus: 400,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('body read errors do not escape', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('private network exception'));
      },
    });
    expect(
      await readSendDiagnostic(new Response(body, { status: 500 })),
    ).toEqual({
      httpStatus: 500,
    });
  });

  it('bounds stalled body reads without leaving a timer', async () => {
    jest.useFakeTimers();
    try {
      const cancel = jest.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const result = readSendDiagnostic(new Response(body, { status: 429 }));
      await jest.advanceTimersByTimeAsync(1000);
      expect(await result).toEqual({ httpStatus: 429 });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
