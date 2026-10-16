import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { WhatsAppTransportModule } from './whatsapp-transport.module';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';

@Module({
  imports: [MessagingModule, WhatsAppTransportModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
})
export class WhatsAppModule {}
