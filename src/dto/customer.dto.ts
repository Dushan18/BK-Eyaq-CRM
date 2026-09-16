import { Transform, type TransformFnParams, Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
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
} from 'class-validator';
import { ContactChannel, CustomerStatus } from '../../generated/prisma/enums';
import { normalizeContactEmail } from '../common/contact-normalization';

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;
const email = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? normalizeContactEmail(value) : value;
const provided = (_: object, value: unknown) => value !== undefined;

class CustomerFieldsDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string | null;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string | null;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  phone?: string | null;

  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  phoneCountry?: string | null;

  @Transform(email)
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string | null;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  notes?: string | null;
}

export class CreateCustomerDto extends CustomerFieldsDto {
  @IsEnum(ContactChannel)
  sourceChannel!: ContactChannel;
}

export class UpdateCustomerDto extends CustomerFieldsDto {
  @ValidateIf(provided)
  @IsEnum(ContactChannel)
  sourceChannel?: ContactChannel;
}

export class UpdateCustomerStatusDto {
  @IsEnum(CustomerStatus)
  status!: CustomerStatus;
}

export class CreateCustomerInterestDto {
  @IsUUID()
  commercialItemId!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  notes?: string | null;
}

export class CustomerQueryDto {
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

  @Transform(trim)
  @ValidateIf(provided)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  search?: string;

  @ValidateIf(provided)
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  @ValidateIf(provided)
  @IsEnum(ContactChannel)
  channel?: ContactChannel;

  @ValidateIf(provided)
  @IsUUID()
  commercialItemId?: string;
}
