import { Module } from '@nestjs/common';
import { InstagramConfig } from './instagram.config';
import { InstagramAdapter } from './instagram.adapter';

@Module({
  providers: [InstagramConfig, InstagramAdapter],
  exports: [InstagramConfig, InstagramAdapter],
})
export class InstagramTransportModule {}
