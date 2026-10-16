import { Module } from '@nestjs/common';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { WhatsAppConfig } from './whatsapp.config';

@Module({
  providers: [WhatsAppConfig, WhatsAppAdapter],
  exports: [WhatsAppConfig, WhatsAppAdapter],
})
export class WhatsAppTransportModule {}
