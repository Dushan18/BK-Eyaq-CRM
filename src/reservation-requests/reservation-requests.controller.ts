import {
  Body,
  Controller,
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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  CreateReservationRequestDto,
  RejectReservationRequestDto,
  ReservationRequestQueryDto,
  UpdateReservationRequestDto,
  UpdateReservationRequestStatusDto,
} from '../dto/reservation-request.dto';
import { ReservationRequestsService } from './reservation-requests.service';

@Controller('reservation-requests')
@UseGuards(AccessTokenGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OPERATOR)
export class ReservationRequestsController {
  constructor(private readonly service: ReservationRequestsService) {}

  @Post()
  create(@Body() dto: CreateReservationRequestDto) {
    return this.service.create(dto);
  }

  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findAll(@Query() query: ReservationRequestQueryDto) {
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
    @Body() dto: UpdateReservationRequestDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateReservationRequestStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.updateStatus(id, dto, actor);
  }

  // Manual approval by the owner or an administrator. Idempotent: 200 every time.
  @Post(':id/approve')
  @HttpCode(200)
  @Roles(RoleCode.ADMIN, RoleCode.OWNER)
  approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.approve(id, actor);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles(RoleCode.ADMIN, RoleCode.OWNER)
  reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RejectReservationRequestDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.reject(id, dto, actor);
  }
}
