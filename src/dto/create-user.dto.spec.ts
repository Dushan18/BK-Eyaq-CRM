import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RoleCode } from '../../generated/prisma/enums';
import { CreateUserDto } from './create-user.dto';

describe('CreateUserDto', () => {
  const validInput = {
    firstName: 'Carlos',
    lastName: 'Quispe',
    email: 'carlos@restaurant.com',
    password: 'Password123!',
    roles: [RoleCode.OPERATOR],
  };

  it('acepta un usuario válido', async () => {
    const dto = plainToInstance(CreateUserDto, validInput);

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rechaza roles que no pertenecen a RoleCode', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...validInput,
      roles: ['SUPER_ADMIN'],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'roles')).toBe(true);
  });

  it('rechaza roles duplicados', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...validInput,
      roles: [RoleCode.OPERATOR, RoleCode.OPERATOR],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'roles')).toBe(true);
  });

  it('rechaza un array de roles vacío', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...validInput,
      roles: [],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'roles')).toBe(true);
  });

  it('rechaza contraseñas menores a ocho caracteres', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...validInput,
      password: 'short',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'password')).toBe(true);
  });
});
