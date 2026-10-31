import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SamantaConfig {
  readonly enabled: boolean;
  readonly model: string;
  readonly dailyLimit: number;
  readonly concurrentLimit: number;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly draftTtlMs = 15 * 60 * 1000;
  constructor(private readonly config: ConfigService) {
    this.enabled = config.get<string>('SAMANTA_ENABLED', 'false') === 'true';
    this.model = config.get<string>('SAMANTA_MODEL', 'gpt-6-luna');
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(this.model))
      throw new Error('SAMANTA_MODEL inválido');
    this.dailyLimit = this.integer('SAMANTA_DAILY_LIMIT', 100, 1, 10000);
    this.concurrentLimit = this.integer('SAMANTA_CONCURRENT_LIMIT', 2, 1, 10);
    this.timeoutMs = this.integer('SAMANTA_TIMEOUT_MS', 20000, 1000, 60000);
    this.maxOutputTokens = this.integer(
      'SAMANTA_MAX_OUTPUT_TOKENS',
      1024,
      256,
      4096,
    );
    if (this.enabled && !this.apiKey)
      throw new Error('Falta OPENAI_API_KEY para Samanta');
  }
  private integer(key: string, fallback: number, min: number, max: number) {
    const value = Number(this.config.get<string | number>(key, fallback));
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${key} fuera de rango`);
    return value;
  }
  get apiKey() {
    return this.config.get<string>('OPENAI_API_KEY', '').trim();
  }
  assertEnabled() {
    if (!this.enabled)
      throw new ServiceUnavailableException('Samanta está desactivada');
  }
}
