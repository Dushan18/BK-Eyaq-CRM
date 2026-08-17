import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { RoleCode } from '../../generated/prisma/enums';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'firstName no puede contener solo espacios' })
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'lastName no puede contener solo espacios' })
  @MaxLength(100)
  lastName!: string;

  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(RoleCode, { each: true })
  roles!: RoleCode[];
}
