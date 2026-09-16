import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RoleCode } from '../../generated/prisma/enums';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  CreateCustomerDto,
  CreateCustomerInterestDto,
  CustomerQueryDto,
  UpdateCustomerDto,
  UpdateCustomerStatusDto,
} from '../dto/customer.dto';
import { CustomersService } from './customers.service';

@Controller('customers')
@UseGuards(AccessTokenGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OPERATOR)
export class CustomersController {
  constructor(private readonly service: CustomersService) {}

  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.service.create(dto);
  }

  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findAll(@Query() query: CustomerQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCustomerStatusDto,
  ) {
    return this.service.updateStatus(id, dto);
  }

  @Post(':id/interests')
  @HttpCode(200)
  addInterest(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateCustomerInterestDto,
  ) {
    return this.service.addInterest(id, dto);
  }

  @Delete(':id/interests/:commercialItemId')
  @HttpCode(204)
  removeInterest(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('commercialItemId', new ParseUUIDPipe()) commercialItemId: string,
  ) {
    return this.service.removeInterest(id, commercialItemId);
  }
}
