import { IsEnum, IsIn, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { ReservationStatus } from '../../generated/prisma/enums';
import {
  PeopleCount,
  provided,
  ReservationBaseQueryDto,
  ReservationDate,
  ReservationText,
} from './reservation-common.dto';

class ReservationOptionalFieldsDto {
  @IsOptional()
  @IsUUID()
  commercialItemId?: string | null;

  @IsOptional()
  @ReservationText()
  notes?: string | null;
}

export class CreateReservationDto extends ReservationOptionalFieldsDto {
  @IsUUID()
  customerId!: string;

  @ReservationDate()
  reservationAt!: string;

  @PeopleCount()
  numberOfPeople!: number;
}

export class UpdateReservationDto extends ReservationOptionalFieldsDto {
  @ValidateIf(provided)
  @IsUUID()
  customerId?: string;

  @ValidateIf(provided)
  @ReservationDate()
  reservationAt?: string;

  @ValidateIf(provided)
  @PeopleCount()
  numberOfPeople?: number;
}

export class UpdateReservationStatusDto {
  @IsIn([
    ReservationStatus.CONFIRMED,
    ReservationStatus.IN_SERVICE,
    ReservationStatus.COMPLETED,
    ReservationStatus.CANCELLED,
    ReservationStatus.NO_SHOW,
  ])
  status!: ReservationStatus;
}

export class ReservationQueryDto extends ReservationBaseQueryDto {
  @ValidateIf(provided)
  @IsEnum(ReservationStatus)
  status?: ReservationStatus;
}
