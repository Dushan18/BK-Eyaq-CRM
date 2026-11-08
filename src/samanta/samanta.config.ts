import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ContactChannel } from '../../generated/prisma/enums';

export const AUTO_CHANNELS: readonly ContactChannel[] = [
  'WHATSAPP',
  'FACEBOOK',
  'INSTAGRAM',
];

@Injectable()
export class SamantaConfig {
  readonly enabled: boolean;
  readonly model: string;
  readonly dailyLimit: number;
  readonly concurrentLimit: number;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly draftTtlMs = 15 * 60 * 1000;
  // Automatic mode: Samanta answers each inbound text on her own.
  readonly autoEnabled: boolean;
  // false = shadow mode: automatic replies stay as READY drafts for review.
  readonly autoSend: boolean;
  readonly autoChannels: readonly ContactChannel[];
  // Waits for the customer to finish typing before answering several messages at once.
  readonly autoDelayMs: number;
  readonly autoMaxPerHour: number;
  constructor(private readonly config: ConfigService) {
    this.enabled = this.flag('SAMANTA_ENABLED', false);
    this.autoEnabled = this.flag('SAMANTA_AUTO_ENABLED', false);
    this.autoSend = this.flag('SAMANTA_AUTO_SEND', false);
    if (this.autoEnabled && !this.enabled)
      throw new Error('SAMANTA_AUTO_ENABLED requiere SAMANTA_ENABLED=true');
    // A disabled feature must not stop the CRM from starting: only validate when on.
    this.model = this.value('SAMANTA_MODEL') ?? 'gpt-6-luna';
    if (this.enabled && !/^[a-zA-Z0-9._-]{1,80}$/.test(this.model))
      throw new Error('SAMANTA_MODEL inválido');
    this.dailyLimit = this.integer('SAMANTA_DAILY_LIMIT', 100, 1, 10000);
    this.concurrentLimit = this.integer('SAMANTA_CONCURRENT_LIMIT', 2, 1, 10);
    this.timeoutMs = this.integer('SAMANTA_TIMEOUT_MS', 20000, 1000, 60000);
    this.maxOutputTokens = this.integer(
      'SAMANTA_MAX_OUTPUT_TOKENS',
      4096,
      256,
      16384,
    );
    this.autoDelayMs = this.integer('SAMANTA_AUTO_DELAY_MS', 8000, 0, 60000);
    this.autoMaxPerHour = this.integer('SAMANTA_AUTO_MAX_PER_HOUR', 12, 1, 100);
    this.autoChannels = this.channels();
    if (this.enabled && !this.apiKey)
      throw new Error('Falta OPENAI_API_KEY para Samanta');
  }
  // Empty values count as unset, so `SAMANTA_DAILY_LIMIT=` means "use the default".
  private value(key: string): string | undefined {
    const raw = this.config.get<string | number | boolean>(key);
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    return value || undefined;
  }
  private flag(key: string, fallback: boolean) {
    const value = this.value(key);
    if (value === undefined) return fallback;
    if (!['true', 'false'].includes(value))
      throw new Error(`${key} debe ser true o false`);
    return value === 'true';
  }
  private integer(key: string, fallback: number, min: number, max: number) {
    const raw = this.value(key);
    if (raw === undefined || !this.enabled) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${key} fuera de rango`);
    return value;
  }
  private channels(): readonly ContactChannel[] {
    const raw = this.value('SAMANTA_AUTO_CHANNELS');
    if (raw === undefined || !this.enabled) return AUTO_CHANNELS;
    const channels = raw.split(',').map((channel) => channel.trim());
    if (
      !channels.every((channel) =>
        AUTO_CHANNELS.includes(channel as ContactChannel),
      )
    )
      throw new Error(
        `SAMANTA_AUTO_CHANNELS solo admite ${AUTO_CHANNELS.join(', ')}`,
      );
    return [...new Set(channels)] as ContactChannel[];
  }
  get apiKey() {
    return this.value('OPENAI_API_KEY') ?? '';
  }
  assertEnabled() {
    if (!this.enabled)
      throw new ServiceUnavailableException('Samanta está desactivada');
  }
}
