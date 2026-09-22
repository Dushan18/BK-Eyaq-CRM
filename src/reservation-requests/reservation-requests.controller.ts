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
import {
  CreateReservationRequestDto,
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
  ) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateReservationRequestStatusDto,
  ) {
    return this.service.updateStatus(id, dto);
  }
}
