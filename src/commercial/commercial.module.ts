import { Module } from '@nestjs/common';

import { CommercialCategoriesController } from './commercial-categories.controller';
import { CommercialCategoriesService } from './commercial-categories.service';
import { CommercialItemsController } from './commercial-items.controller';
import { CommercialItemsService } from './commercial-items.service';

@Module({
  controllers: [CommercialCategoriesController, CommercialItemsController],
  providers: [CommercialCategoriesService, CommercialItemsService],
  exports: [CommercialCategoriesService, CommercialItemsService],
})
export class CommercialModule {}
