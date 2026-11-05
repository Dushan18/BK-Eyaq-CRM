import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { MessagingModule } from '../messaging/messaging.module';
import { InstagramTransportModule } from './instagram-transport.module';
import { InstagramController } from './instagram.controller';
import { InstagramService } from './instagram.service';

@Module({
  imports: [MessagingModule, InstagramTransportModule, CustomersModule],
  controllers: [InstagramController],
  providers: [InstagramService],
})
export class InstagramModule {}
