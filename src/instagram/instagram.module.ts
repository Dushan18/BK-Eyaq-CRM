import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { MessagingModule } from '../messaging/messaging.module';
import { InstagramConfig } from './instagram.config';
import { InstagramAdapter } from './instagram.adapter';
import { InstagramController } from './instagram.controller';
import { InstagramService } from './instagram.service';

@Module({
  imports: [MessagingModule, CustomersModule],
  controllers: [InstagramController],
  providers: [InstagramConfig, InstagramAdapter, InstagramService],
})
export class InstagramModule {}
