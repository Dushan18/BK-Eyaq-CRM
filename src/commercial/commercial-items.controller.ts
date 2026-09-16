import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { RoleCode } from '../../generated/prisma/enums';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CommercialItemQueryDto,
  CreateCommercialItemDto,
  UpdateCommercialItemApprovalDto,
  UpdateCommercialItemDto,
  UpdateCommercialItemStatusDto,
} from '../dto/commercial-item.dto';
import { CommercialItemsService } from './commercial-items.service';

@Controller('commercial-items')
@UseGuards(AccessTokenGuard, RolesGuard)
export class CommercialItemsController {
  constructor(
    private readonly commercialItemsService: CommercialItemsService,
  ) {}

  @Post()
  @Roles(RoleCode.ADMIN)
  create(@Body() dto: CreateCommercialItemDto) {
    return this.commercialItemsService.create(dto);
  }

  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findAll(@Query() query: CommercialItemQueryDto) {
    return this.commercialItemsService.findAll(query);
  }

  @Get(':id')
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.commercialItemsService.findOne(id);
  }

  @Patch(':id')
  @Roles(RoleCode.ADMIN)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCommercialItemDto,
  ) {
    return this.commercialItemsService.update(id, dto);
  }

  @Patch(':id/status')
  @Roles(RoleCode.ADMIN)
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCommercialItemStatusDto,
  ) {
    return this.commercialItemsService.updateStatus(id, dto);
  }

  @Patch(':id/approval')
  @Roles(RoleCode.ADMIN)
  updateApproval(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCommercialItemApprovalDto,
  ) {
    return this.commercialItemsService.updateApproval(id, dto);
  }
}
