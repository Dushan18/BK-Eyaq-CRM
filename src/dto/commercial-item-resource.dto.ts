import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import { DayOfWeek } from '../../generated/prisma/enums';

export const COMMERCIAL_MONEY_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;
export const COMMERCIAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

type CommercialScheduleTimeFields = {
  isAvailable: boolean;
  startTime?: string | null;
  endTime?: string | null;
};

export function isCommercialScheduleTimeCoherent(
  schedule: CommercialScheduleTimeFields,
): boolean {
  if (schedule.isAvailable === false) {
    return schedule.startTime == null && schedule.endTime == null;
  }

  if (schedule.isAvailable !== true) {
    return false;
  }

  return (
    typeof schedule.startTime === 'string' &&
    typeof schedule.endTime === 'string' &&
    COMMERCIAL_TIME_PATTERN.test(schedule.startTime) &&
    COMMERCIAL_TIME_PATTERN.test(schedule.endTime) &&
    schedule.startTime !== schedule.endTime
  );
}

@ValidatorConstraint({ name: 'commercialScheduleTimes', async: false })
class CommercialScheduleTimesConstraint implements ValidatorConstraintInterface {
  validate(_value: boolean, arguments_: ValidationArguments): boolean {
    return isCommercialScheduleTimeCoherent(
      arguments_.object as CommercialScheduleTimeFields,
    );
  }

  defaultMessage(): string {
    return 'Un horario disponible requiere startTime y endTime distintos en formato HH:mm; un horario no disponible no admite horas';
  }
}

export class CommercialItemVariantDto {
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  nameEs?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  nameEn?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  descriptionEs?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  descriptionEn?: string | null;

  @Transform(trimString)
  @IsString()
  @Matches(COMMERCIAL_MONEY_PATTERN, {
    message:
      'price debe ser una cadena decimal no negativa con máximo dos decimales',
  })
  price!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  displayOrder?: number;
}

export class CommercialItemImageDto {
  @Transform(trimString)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  url!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  altTextEs?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  altTextEn?: string | null;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  displayOrder?: number;
}

export class CommercialItemFaqDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  questionEs!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  questionEn?: string | null;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  answerEs!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  answerEn?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  displayOrder?: number;
}

export class CommercialItemScheduleDto {
  @IsEnum(DayOfWeek)
  dayOfWeek!: DayOfWeek;

  @IsBoolean()
  @Validate(CommercialScheduleTimesConstraint)
  isAvailable!: boolean;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Matches(COMMERCIAL_TIME_PATTERN, {
    message: 'startTime debe tener el formato HH:mm',
  })
  startTime?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Matches(COMMERCIAL_TIME_PATTERN, {
    message: 'endTime debe tener el formato HH:mm',
  })
  endTime?: string | null;
}

export class CommercialPromotionDetailDto {
  @Transform(trimString)
  @IsOptional()
  @IsDateString({}, { message: 'validFrom debe ser una fecha ISO 8601 válida' })
  validFrom?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsDateString(
    {},
    { message: 'validUntil debe ser una fecha ISO 8601 válida' },
  )
  validUntil?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Matches(COMMERCIAL_MONEY_PATTERN, {
    message:
      'promotionalPrice debe ser una cadena decimal no negativa con máximo dos decimales',
  })
  promotionalPrice?: string | null;
}

export class CommercialEventDetailDto {
  @Transform(trimString)
  @IsOptional()
  @IsDateString({}, { message: 'startAt debe ser una fecha ISO 8601 válida' })
  startAt?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsDateString({}, { message: 'endAt debe ser una fecha ISO 8601 válida' })
  endAt?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  capacity?: number | null;
}
