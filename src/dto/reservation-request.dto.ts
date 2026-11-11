import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  ContactChannel,
  CurrencyCode,
  ReservationRequestStatus,
} from '../../generated/prisma/enums';
import {
  PeopleCount,
  provided,
  ReservationBaseQueryDto,
  ReservationDate,
  ReservationText,
  trimReservationText,
} from './reservation-common.dto';

class ReservationRequestFieldsDto {
  @IsOptional()
  @IsUUID()
  commercialItemId?: string | null;

  // A conversation of the request's customer; null unlinks it.
  @IsOptional()
  @IsUUID()
  conversationId?: string | null;

  @IsOptional()
  @ReservationDate()
  reservationAt?: string | null;

  @IsOptional()
  @PeopleCount()
  numberOfPeople?: number | null;

  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
  quotedPrice?: string | null;

  @IsOptional()
  @IsEnum(CurrencyCode)
  currency?: CurrencyCode | null;

  @IsOptional()
  @ReservationText()
  comments?: string | null;

  @IsOptional()
  @ReservationText()
  specialRequirements?: string | null;
}

export class CreateReservationRequestDto extends ReservationRequestFieldsDto {
  @IsUUID()
  customerId!: string;

  @IsEnum(ContactChannel)
  sourceChannel!: ContactChannel;
}

export class UpdateReservationRequestDto extends ReservationRequestFieldsDto {
  @ValidateIf(provided)
  @IsUUID()
  customerId?: string;

  @ValidateIf(provided)
  @IsEnum(ContactChannel)
  sourceChannel?: ContactChannel;
}

export class UpdateReservationRequestStatusDto {
  @IsIn([ReservationRequestStatus.CANCELLED])
  status!: typeof ReservationRequestStatus.CANCELLED;

  // Kept in the status history.
  @IsOptional()
  @Transform(trimReservationText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason?: string | null;
}

// POST /reservation-requests/:id/reject. The reason stays in the status history.
export class RejectReservationRequestDto {
  @IsOptional()
  @Transform(trimReservationText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason?: string | null;
}

export class ReservationRequestQueryDto extends ReservationBaseQueryDto {
  @ValidateIf(provided)
  @IsEnum(ReservationRequestStatus)
  status?: ReservationRequestStatus;

  @ValidateIf(provided)
  @IsEnum(ContactChannel)
  channel?: ContactChannel;

  @ValidateIf(provided)
  @IsUUID()
  commercialItemId?: string;

  @ValidateIf(provided)
  @IsUUID()
  conversationId?: string;

  @Transform(trimReservationText)
  @ValidateIf(provided)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  search?: string;
}
