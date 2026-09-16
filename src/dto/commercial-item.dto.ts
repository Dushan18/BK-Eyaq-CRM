import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  CommercialApprovalStatus,
  CommercialItemType,
  DayOfWeek,
} from '../../generated/prisma/enums';
import {
  COMMERCIAL_MONEY_PATTERN,
  CommercialEventDetailDto,
  CommercialItemFaqDto,
  CommercialItemImageDto,
  CommercialItemScheduleDto,
  CommercialItemVariantDto,
  CommercialPromotionDetailDto,
} from './commercial-item-resource.dto';

export const COMMERCIAL_ITEM_SORT_FIELDS = [
  'category',
  'name',
  'createdAt',
] as const;
export const COMMERCIAL_ITEM_SORT_ORDERS = ['asc', 'desc'] as const;

export type CommercialItemSortField =
  (typeof COMMERCIAL_ITEM_SORT_FIELDS)[number];
export type CommercialItemSortOrder =
  (typeof COMMERCIAL_ITEM_SORT_ORDERS)[number];

const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

const parseBoolean = ({ value }: TransformFnParams): unknown => {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return value;
};

const wasProvided = (_object: object, value: unknown): boolean =>
  value !== undefined;

abstract class CommercialItemWritableFieldsDto {
  @IsUUID()
  categoryId!: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nameEs?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nameEn?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  descriptionEs?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  descriptionEn?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Matches(COMMERCIAL_MONEY_PATTERN, {
    message:
      'basePrice debe ser una cadena decimal no negativa con máximo dos decimales',
  })
  basePrice?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  displayOrder?: number;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  conditions?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  internalNotes?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  availabilityNote?: string | null;

  @ValidateIf(wasProvided)
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CommercialItemVariantDto)
  variants?: CommercialItemVariantDto[];

  @ValidateIf(wasProvided)
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CommercialItemImageDto)
  images?: CommercialItemImageDto[];

  @ValidateIf(wasProvided)
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CommercialItemFaqDto)
  faqs?: CommercialItemFaqDto[];

  @ValidateIf(wasProvided)
  @IsArray()
  @ArrayMaxSize(Object.values(DayOfWeek).length)
  @ArrayUnique((schedule: CommercialItemScheduleDto) => schedule.dayOfWeek)
  @ValidateNested({ each: true })
  @Type(() => CommercialItemScheduleDto)
  schedules?: CommercialItemScheduleDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CommercialPromotionDetailDto)
  promotionDetail?: CommercialPromotionDetailDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CommercialEventDetailDto)
  eventDetail?: CommercialEventDetailDto | null;
}

export class CreateCommercialItemDto extends CommercialItemWritableFieldsDto {
  @IsEnum(CommercialItemType)
  type!: CommercialItemType;
}

export class UpdateCommercialItemDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nameEs?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nameEn?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  descriptionEs?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  descriptionEn?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Matches(COMMERCIAL_MONEY_PATTERN, {
    message:
      'basePrice debe ser una cadena decimal no negativa con máximo dos decimales',
  })
  basePrice?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  displayOrder?: number;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  conditions?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  internalNotes?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  availabilityNote?: string | null;

  @ValidateIf(wasProvided)
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CommercialItemVariantDto)
  variants?: CommercialItemVariantDto[];

  @ValidateIf(wasProvided)
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CommercialItemImageDto)
  images?: CommercialItemImageDto[];

  @ValidateIf(wasProvided)
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CommercialItemFaqDto)
  faqs?: CommercialItemFaqDto[];

  @ValidateIf(wasProvided)
  @IsArray()
  @ArrayMaxSize(Object.values(DayOfWeek).length)
  @ArrayUnique((schedule: CommercialItemScheduleDto) => schedule.dayOfWeek)
  @ValidateNested({ each: true })
  @Type(() => CommercialItemScheduleDto)
  schedules?: CommercialItemScheduleDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CommercialPromotionDetailDto)
  promotionDetail?: CommercialPromotionDetailDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CommercialEventDetailDto)
  eventDetail?: CommercialEventDetailDto | null;
}

export class UpdateCommercialItemStatusDto {
  @IsBoolean()
  isActive!: boolean;
}

export class UpdateCommercialItemApprovalDto {
  @IsEnum(CommercialApprovalStatus)
  approvalStatus!: CommercialApprovalStatus;
}

export class CommercialItemQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsEnum(CommercialItemType)
  type?: CommercialItemType;

  @IsOptional()
  @IsEnum(CommercialApprovalStatus)
  approvalStatus?: CommercialApprovalStatus;

  @Transform(parseBoolean)
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsIn(COMMERCIAL_ITEM_SORT_FIELDS)
  sort: CommercialItemSortField = 'createdAt';

  @IsOptional()
  @IsIn(COMMERCIAL_ITEM_SORT_ORDERS)
  order: CommercialItemSortOrder = 'desc';
}
