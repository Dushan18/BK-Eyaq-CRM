import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WhatsAppConfig {
  readonly enabled: boolean;
  constructor(private readonly config: ConfigService) {
    const enabled = config.get<string>('WHATSAPP_ENABLED') ?? 'false';
    if (!['true', 'false'].includes(enabled))
      throw new Error('WHATSAPP_ENABLED inválido');
    this.enabled = enabled === 'true';
    if (!this.enabled) return;
    for (const name of [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_BUSINESS_ACCOUNT_ID',
      'WHATSAPP_API_VERSION',
      'META_APP_SECRET',
    ]) {
      if (!config.get<string>(name)?.trim())
        throw new Error(`${name} requerida`);
    }
    if (
      !/^v\d+\.\d+$/.test(this.version) ||
      !/^\d{1,80}$/.test(this.phoneId) ||
      !/^\d{1,80}$/.test(this.businessId)
    )
      throw new Error('Configuración WhatsApp inválida');
    if (
      config.get<string>('MESSAGING_ENABLED') !== 'true' ||
      !config.get<string>('REDIS_URL')
    )
      throw new Error('WhatsApp requiere MESSAGING_ENABLED y REDIS_URL');
  }
  assertEnabled() {
    if (!this.enabled)
      throw new ServiceUnavailableException('WhatsApp no está habilitado');
  }
  get accessToken() {
    return this.config.get<string>('WHATSAPP_ACCESS_TOKEN') ?? '';
  }
  get verifyToken() {
    return this.config.get<string>('WHATSAPP_VERIFY_TOKEN') ?? '';
  }
  get appSecret() {
    return this.config.get<string>('META_APP_SECRET') ?? '';
  }
  get phoneId() {
    return this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID') ?? '';
  }
  get businessId() {
    return this.config.get<string>('WHATSAPP_BUSINESS_ACCOUNT_ID') ?? '';
  }
  get version() {
    return this.config.get<string>('WHATSAPP_API_VERSION') ?? '';
  }
}
