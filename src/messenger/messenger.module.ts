import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { MessengerTransportModule } from './messenger-transport.module';
import { MessengerController } from './messenger.controller';
import { MessengerService } from './messenger.service';

@Module({
  imports: [MessagingModule, MessengerTransportModule],
  controllers: [MessengerController],
  providers: [MessengerService],
})
export class MessengerModule {}
