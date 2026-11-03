export interface WhatsAppSendDiagnostic {
  httpStatus: number;
  metaCode?: number;
  metaSubcode?: number;
  isTransient?: boolean;
}

// Do not retain provider text, headers, URLs or error_data: they may echo PII
// and credentials. A strict allowlist is safer than redacting arbitrary text.
export async function readSendDiagnostic(
  response: Response,
): Promise<WhatsAppSendDiagnostic> {
  const diagnostic: WhatsAppSendDiagnostic = { httpStatus: response.status };
  const reader = response.body?.getReader();
  if (!reader) return diagnostic;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16384) throw new Error('Diagnostic size limit');
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString('utf8');
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Diagnostic timeout')), 1000);
      }),
    ]);
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return diagnostic;
    const error = (parsed as Record<string, unknown>).error;
    if (!error || typeof error !== 'object' || Array.isArray(error))
      return diagnostic;
    const fields = error as Record<string, unknown>;
    const code = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (code(fields.code)) diagnostic.metaCode = fields.code;
    if (code(fields.error_subcode))
      diagnostic.metaSubcode = fields.error_subcode;
    if (typeof fields.is_transient === 'boolean')
      diagnostic.isTransient = fields.is_transient;
  } catch {
    // Failure to inspect the body must not change delivery/retry semantics.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
  return diagnostic;
}
