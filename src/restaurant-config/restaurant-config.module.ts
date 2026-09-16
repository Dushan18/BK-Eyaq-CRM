import { Module } from '@nestjs/common';

import { RestaurantConfigController } from './restaurant-config.controller';
import { RestaurantConfigService } from './restaurant-config.service';

@Module({
  controllers: [RestaurantConfigController],
  providers: [RestaurantConfigService],
  exports: [RestaurantConfigService],
})
export class RestaurantConfigModule {}
