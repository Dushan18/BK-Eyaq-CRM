import { Module } from '@nestjs/common';
import { MessengerConfig } from './messenger.config';
import { MessengerAdapter } from './messenger.adapter';

@Module({
  providers: [MessengerConfig, MessengerAdapter],
  exports: [MessengerConfig, MessengerAdapter],
})
export class MessengerTransportModule {}
