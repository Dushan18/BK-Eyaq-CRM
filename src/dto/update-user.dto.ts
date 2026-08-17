import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'firstName no puede contener solo espacios' })
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'lastName no puede contener solo espacios' })
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;
}
