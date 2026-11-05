import { ForbiddenException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Handshake and signature checks shared by Meta channels (WhatsApp Cloud API, Messenger).
export function verifyChallenge(
  expectedToken: string,
  mode: unknown,
  token: unknown,
  challenge: unknown,
): string {
  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(typeof token === 'string' ? token : '');
  if (
    mode !== 'subscribe' ||
    typeof challenge !== 'string' ||
    !challenge ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    throw new ForbiddenException('Verificación inválida');
  return challenge;
}
// Authenticates the exact raw bytes and parses those same bytes: a re-serialized body
// would no longer be what Meta signed.
export function parseSignedEvent(
  raw: Buffer | undefined,
  signature: string | undefined,
  appSecret: string,
): unknown {
  if (!raw || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
    throw new ForbiddenException('Firma inválida');
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    throw new ForbiddenException('Firma inválida');
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
// Quarantine key for a rejected event; never stores the event itself.
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
}
