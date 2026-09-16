import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';

import { RoleCode } from '../../generated/prisma/enums';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PutRestaurantConfigDto } from '../dto/put-restaurant-config.dto';
import { RestaurantConfigService } from './restaurant-config.service';

@Controller('restaurant-config')
@UseGuards(AccessTokenGuard, RolesGuard)
export class RestaurantConfigController {
  constructor(
    private readonly restaurantConfigService: RestaurantConfigService,
  ) {}

  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findOne() {
    return this.restaurantConfigService.findOne();
  }

  @Put()
  @Roles(RoleCode.ADMIN)
  upsert(@Body() dto: PutRestaurantConfigDto) {
    return this.restaurantConfigService.upsert(dto);
  }
}
