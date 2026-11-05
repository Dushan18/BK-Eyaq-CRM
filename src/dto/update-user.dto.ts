import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

// Opcionales pero no anulables: @IsOptional() también dejaría pasar null.
const provided = (_: object, value: unknown) => value !== undefined;

export class UpdateUserDto {
  @ValidateIf(provided)
  @IsString()
  @Matches(/\S/, { message: 'firstName no puede contener solo espacios' })
  @MaxLength(100)
  firstName?: string;

  @ValidateIf(provided)
  @IsString()
  @Matches(/\S/, { message: 'lastName no puede contener solo espacios' })
  @MaxLength(100)
  lastName?: string;

  @ValidateIf(provided)
  @IsEmail()
  @MaxLength(320)
  email?: string;
}
