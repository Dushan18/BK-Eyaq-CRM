import { applyDecorators } from '@nestjs/common';
import { Transform, type TransformFnParams, Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const provided = (_: object, value: unknown) => value !== undefined;
export const trimReservationText = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export function ReservationDate() {
  return applyDecorators(
    IsString(),
    IsISO8601({ strict: true, strictSeparator: true }),
    Matches(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
    ),
  );
}

export function ReservationText() {
  return applyDecorators(
    Transform(trimReservationText),
    IsString(),
    IsNotEmpty(),
    MaxLength(5000),
  );
}

export function PeopleCount() {
  // Límite técnico de PostgreSQL INTEGER, no capacidad del restaurante.
  return applyDecorators(IsInt(), Min(1), Max(2147483647));
}

export class ReservationBaseQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ValidateIf(provided)
  @IsUUID()
  customerId?: string;

  @ValidateIf(provided)
  @ReservationDate()
  dateFrom?: string;

  @ValidateIf(provided)
  @ReservationDate()
  dateTo?: string;
}
