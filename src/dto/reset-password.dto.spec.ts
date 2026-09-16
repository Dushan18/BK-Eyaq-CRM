import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ForgotPasswordDto } from './forgot-password.dto';
import { ResetPasswordDto } from './reset-password.dto';

describe('DTOs de recuperación de contraseña', () => {
  it('acepta un email válido para solicitar recuperación', async () => {
    const dto = plainToInstance(ForgotPasswordDto, {
      email: 'user@eyaq.systems',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rechaza un token con formato inválido', async () => {
    const dto = plainToInstance(ResetPasswordDto, {
      token: 'token-invalido',
      newPassword: 'NuevaPassword123!',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'token')).toBe(true);
  });

  it('rechaza una contraseña demasiado corta', async () => {
    const dto = plainToInstance(ResetPasswordDto, {
      token: 'a'.repeat(64),
      newPassword: 'corta',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'newPassword')).toBe(true);
  });
});
