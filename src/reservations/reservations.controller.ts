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
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  CreateReservationDto,
  ReservationQueryDto,
  UpdateReservationDto,
  UpdateReservationStatusDto,
  AssignReservationDto,
  CreateReservationNoteDto,
  RescheduleReservationDto,
} from '../dto/reservation.dto';
import { ReservationsService } from './reservations.service';

@Controller('reservations')
@UseGuards(AccessTokenGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OPERATOR)
export class ReservationsController {
  constructor(private readonly service: ReservationsService) {}

  @Post()
  @Roles(RoleCode.ADMIN)
  create(@Body() dto: CreateReservationDto) {
    return this.service.create(dto);
  }

  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findAll(@Query() query: ReservationQueryDto) {
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
    @Body() dto: UpdateReservationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateReservationStatusDto,
  ) {
    return this.service.updateStatus(id, dto);
  }

  @Patch(':id/assignee')
  assign(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignReservationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.assign(id, dto, actor);
  }

  @Post(':id/notes')
  addNote(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateReservationNoteDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.addNote(id, dto, actor);
  }

  @Patch(':id/reschedule')
  reschedule(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RescheduleReservationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.reschedule(id, dto, actor);
  }
}
