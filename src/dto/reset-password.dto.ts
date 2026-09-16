import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message: 'El token de recuperación no tiene un formato válido',
  })
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}
