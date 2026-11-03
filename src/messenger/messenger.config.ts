import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MessengerConfig {
  readonly enabled: boolean;
  constructor(private readonly config: ConfigService) {
    const flag = config.get<string>('MESSENGER_ENABLED') ?? 'false';
    if (!['true', 'false'].includes(flag))
      throw new Error('MESSENGER_ENABLED inválido');
    this.enabled = flag === 'true';
    if (!this.enabled) return;
    for (const key of [
      'MESSENGER_PAGE_ACCESS_TOKEN',
      'MESSENGER_PAGE_ID',
      'MESSENGER_VERIFY_TOKEN',
      'MESSENGER_API_VERSION',
      'META_APP_SECRET',
    ]) {
      if (!config.get<string>(key)?.trim()) throw new Error(`${key} requerida`);
    }
    if (!/^\d{1,80}$/.test(this.pageId) || !/^v\d+\.\d+$/.test(this.version))
      throw new Error('Configuración Messenger inválida');
    if (
      config.get<string>('MESSAGING_ENABLED') !== 'true' ||
      !config.get<string>('REDIS_URL')
    )
      throw new Error('Messenger requiere MESSAGING_ENABLED y REDIS_URL');
  }
  assertEnabled() {
    if (!this.enabled)
      throw new ServiceUnavailableException('Messenger no está habilitado');
  }
  get pageId() {
    return this.config.get<string>('MESSENGER_PAGE_ID') ?? '';
  }
  get accessToken() {
    return this.config.get<string>('MESSENGER_PAGE_ACCESS_TOKEN') ?? '';
  }
  get verifyToken() {
    return this.config.get<string>('MESSENGER_VERIFY_TOKEN') ?? '';
  }
  get version() {
    return this.config.get<string>('MESSENGER_API_VERSION') ?? '';
  }
  get appSecret() {
    return this.config.get<string>('META_APP_SECRET') ?? '';
  }
}
