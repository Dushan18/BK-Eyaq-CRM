import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Transform, type TransformFnParams } from 'class-transformer';
import { ReservationStatus } from '../../generated/prisma/enums';
import {
  PeopleCount,
  provided,
  ReservationBaseQueryDto,
  ReservationDate,
  ReservationText,
  trimReservationText,
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
    ReservationStatus.UPCOMING,
    ReservationStatus.IN_SERVICE,
    ReservationStatus.COMPLETED,
    ReservationStatus.CANCELLED,
    ReservationStatus.NO_SHOW,
  ])
  status!: ReservationStatus;
}

export class ReservationQueryDto extends ReservationBaseQueryDto {
  @ValidateIf(provided)
  @IsUUID()
  commercialItemId?: string;

  @ValidateIf(provided)
  @IsUUID()
  assignedUserId?: string;

  @Transform(trimReservationText)
  @ValidateIf(provided)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  search?: string;

  @Transform(({ value }: TransformFnParams): unknown =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @ValidateIf(provided)
  @IsBoolean()
  excludeCancelled?: boolean;

  @ValidateIf(provided)
  @IsEnum(ReservationStatus)
  status?: ReservationStatus;
}

export class AssignReservationDto {
  // null desasigna; undefined no es una operación válida.
  @ValidateIf((_: object, value: unknown) => value !== null)
  @IsUUID()
  assignedUserId!: string | null;
}

export class CreateReservationNoteDto {
  @ReservationText()
  content!: string;
}

export class RescheduleReservationDto {
  @ReservationDate()
  reservationAt!: string;

  @IsOptional()
  @ReservationText()
  reason?: string | null;
}
