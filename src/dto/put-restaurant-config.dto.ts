import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  CurrencyCode,
  DayOfWeek,
  LanguageCode,
} from '../../generated/prisma/enums';
import { RestaurantScheduleDto } from './restaurant-schedule.dto';

const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

const normalizeEmail = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const coordinatesWereProvided = (object: {
  latitude?: unknown;
  longitude?: unknown;
}): boolean => object.latitude != null || object.longitude != null;

export class PutRestaurantConfigDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  businessName!: string;

  @Transform(trimString)
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  logoUrl?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description?: string | null;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address!: string;

  @ValidateIf(coordinatesWereProvided)
  @IsNumber({
    allowInfinity: false,
    allowNaN: false,
    maxDecimalPlaces: 7,
  })
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  @ValidateIf(coordinatesWereProvided)
  @IsNumber({
    allowInfinity: false,
    allowNaN: false,
    maxDecimalPlaces: 7,
  })
  @Min(-180)
  @Max(180)
  longitude?: number | null;

  @Transform(trimString)
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'whatsappNumber debe usar formato internacional E.164',
  })
  @MaxLength(16)
  whatsappNumber!: string;

  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @Transform(trimString)
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  website?: string | null;

  @IsEnum(CurrencyCode)
  currency!: CurrencyCode;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @IsTimeZone()
  @MaxLength(64)
  timeZone!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  reservationPolicy!: string;

  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  cancellationPolicy!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  responseTimeoutMinutes!: number;

  @IsOptional()
  @IsUUID()
  approvalResponsibleId?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(Object.values(LanguageCode).length)
  @ArrayUnique()
  @IsEnum(LanguageCode, { each: true })
  languages!: LanguageCode[];

  @IsArray()
  @ArrayMinSize(Object.values(DayOfWeek).length)
  @ArrayMaxSize(Object.values(DayOfWeek).length)
  @ArrayUnique((schedule: RestaurantScheduleDto) => schedule.dayOfWeek)
  @ValidateNested({ each: true })
  @Type(() => RestaurantScheduleDto)
  schedules!: RestaurantScheduleDto[];
}
