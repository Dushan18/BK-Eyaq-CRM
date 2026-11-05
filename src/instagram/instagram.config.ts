import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InstagramConfig {
  readonly enabled: boolean;
  constructor(private readonly config: ConfigService) {
    const flag = config.get<string>('INSTAGRAM_ENABLED') ?? 'false';
    if (!['true', 'false'].includes(flag))
      throw new Error('INSTAGRAM_ENABLED inválido');
    this.enabled = flag === 'true';
    if (!this.enabled) return;
    for (const key of [
      'INSTAGRAM_ACCOUNT_ID',
      'INSTAGRAM_VERIFY_TOKEN',
      'META_APP_SECRET',
    ]) {
      if (!config.get<string>(key)?.trim()) throw new Error(`${key} requerida`);
    }
    if (!/^\d{1,80}$/.test(this.accountId))
      throw new Error('INSTAGRAM_ACCOUNT_ID inválido');
    // The token is optional: without it, messages still arrive but customers stay unnamed.
    if (this.accessToken && !/^v\d+\.\d+$/.test(this.version))
      throw new Error('INSTAGRAM_API_VERSION inválida');
    if (
      config.get<string>('MESSAGING_ENABLED') !== 'true' ||
      !config.get<string>('REDIS_URL')?.trim()
    )
      throw new Error('Instagram requiere MESSAGING_ENABLED y REDIS_URL');
  }
  assertEnabled() {
    if (!this.enabled)
      throw new ServiceUnavailableException('Instagram no está habilitado');
  }
  // Replies need the access token; without it Instagram only receives.
  get canSend() {
    return this.enabled && !!this.accessToken;
  }
  assertCanSend() {
    this.assertEnabled();
    if (!this.accessToken)
      throw new ServiceUnavailableException(
        'El envío por Instagram no está configurado',
      );
  }
  get accountId() {
    return this.config.get<string>('INSTAGRAM_ACCOUNT_ID') ?? '';
  }
  get verifyToken() {
    return this.config.get<string>('INSTAGRAM_VERIFY_TOKEN') ?? '';
  }
  // Graph API token with instagram_manage_messages (used for the User Profile API).
  get accessToken() {
    return this.config.get<string>('INSTAGRAM_ACCESS_TOKEN')?.trim() ?? '';
  }
  get version() {
    return this.config.get<string>('INSTAGRAM_API_VERSION')?.trim() ?? '';
  }
  // Unified Login: secret of the Meta app that owns this webhook.
  get appSecret() {
    return this.config.get<string>('META_APP_SECRET') ?? '';
  }
}
