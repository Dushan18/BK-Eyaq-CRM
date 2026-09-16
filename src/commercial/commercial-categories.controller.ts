import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { RoleCode } from '../../generated/prisma/enums';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CreateCommercialCategoryDto,
  UpdateCommercialCategoryDto,
  UpdateCommercialCategoryStatusDto,
} from '../dto/commercial-category.dto';
import { CommercialCategoriesService } from './commercial-categories.service';

@Controller('commercial-categories')
@UseGuards(AccessTokenGuard, RolesGuard)
export class CommercialCategoriesController {
  constructor(
    private readonly commercialCategoriesService: CommercialCategoriesService,
  ) {}

  @Post()
  @Roles(RoleCode.ADMIN)
  create(@Body() dto: CreateCommercialCategoryDto) {
    return this.commercialCategoriesService.create(dto);
  }

  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findAll() {
    return this.commercialCategoriesService.findAll();
  }

  @Get(':id')
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.commercialCategoriesService.findOne(id);
  }

  @Patch(':id')
  @Roles(RoleCode.ADMIN)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCommercialCategoryDto,
  ) {
    return this.commercialCategoriesService.update(id, dto);
  }

  @Patch(':id/status')
  @Roles(RoleCode.ADMIN)
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCommercialCategoryStatusDto,
  ) {
    return this.commercialCategoriesService.updateStatus(id, dto);
  }
}
