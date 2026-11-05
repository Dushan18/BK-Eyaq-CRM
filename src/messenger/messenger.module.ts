import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { MessagingModule } from '../messaging/messaging.module';
import { MessengerTransportModule } from './messenger-transport.module';
import { MessengerController } from './messenger.controller';
import { MessengerService } from './messenger.service';

@Module({
  imports: [MessagingModule, MessengerTransportModule, CustomersModule],
  controllers: [MessengerController],
  providers: [MessengerService],
})
export class MessengerModule {}
