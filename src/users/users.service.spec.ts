import { ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { RoleCode } from '../../generated/prisma/enums';
import type { PrismaService } from '../database/prisma.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { UsersService } from './users.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('UsersService', () => {
  let service: UsersService;

  type UserCreateArguments = {
    data: {
      email: string;
      firstName: string;
      lastName: string;
      passwordHash: string;
    };
  };

  const userFindUnique = jest.fn();
  const userFindMany = jest.fn();
  const userCreate = jest.fn<Promise<unknown>, [UserCreateArguments]>();
  const roleFindMany = jest.fn();
  const transaction = jest.fn();

  const prisma = {
    user: {
      findUnique: userFindUnique,
      findMany: userFindMany,
      create: userCreate,
    },
    role: {
      findMany: roleFindMany,
    },
    $transaction: transaction,
  } as unknown as PrismaService;

  const publicUser = {
    id: '6fbf2ed0-6e36-4e82-9d32-73929a5c188e',
    firstName: 'Carlos',
    lastName: 'Quispe',
    email: 'carlos@restaurant.com',
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-08-16T00:00:00.000Z'),
    updatedAt: new Date('2026-08-16T00:00:00.000Z'),
    roles: [
      {
        role: {
          code: RoleCode.OPERATOR,
        },
      },
    ],
  };

  beforeEach(() => {
    jest.resetAllMocks();

    service = new UsersService(prisma);
  });

  it('crea el usuario con bcrypt y no retorna passwordHash', async () => {
    const dto: CreateUserDto = {
      firstName: ' Carlos ',
      lastName: ' Quispe ',
      email: 'CARLOS@RESTAURANT.COM',
      password: 'Password123!',
      roles: [RoleCode.OPERATOR],
    };

    userFindUnique.mockResolvedValue(null);
    roleFindMany.mockResolvedValue([
      {
        id: 'operator-role-id',
        code: RoleCode.OPERATOR,
      },
    ]);
    userCreate.mockResolvedValue(publicUser);

    const result = await service.create(dto);
    const createArguments = userCreate.mock.calls[0][0];

    expect(createArguments.data.email).toBe('carlos@restaurant.com');
    expect(createArguments.data.firstName).toBe('Carlos');
    expect(createArguments.data.lastName).toBe('Quispe');
    expect(createArguments.data.passwordHash).not.toBe(dto.password);
    await expect(
      bcrypt.compare(dto.password, createArguments.data.passwordHash),
    ).resolves.toBe(true);
    expect(result).not.toHaveProperty('passwordHash');
    expect(result.roles).toEqual([RoleCode.OPERATOR]);
  });

  it('rechaza un email duplicado', async () => {
    userFindUnique.mockResolvedValue({
      id: 'existing-user-id',
    });

    await expect(
      service.create({
        firstName: 'Carlos',
        lastName: 'Quispe',
        email: 'carlos@restaurant.com',
        password: 'Password123!',
        roles: [RoleCode.OPERATOR],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(userCreate).not.toHaveBeenCalled();
  });

  it('lista usuarios sin información sensible', async () => {
    userFindMany.mockResolvedValue([publicUser]);

    const result = await service.findAll();

    expect(result).toEqual([
      expect.objectContaining({
        id: publicUser.id,
        roles: [RoleCode.OPERATOR],
      }),
    ]);
    expect(result[0]).not.toHaveProperty('passwordHash');
  });

  it('impide desactivar al último ADMIN activo', async () => {
    const userUpdate = jest.fn();
    const sessionUpdateMany = jest.fn();
    const transactionClient = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-id',
          isActive: true,
          roles: [
            {
              role: {
                code: RoleCode.ADMIN,
              },
            },
          ],
        }),
        count: jest.fn().mockResolvedValue(1),
        update: userUpdate,
      },
      session: {
        updateMany: sessionUpdateMany,
      },
    };

    transaction.mockImplementation(
      async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient),
    );

    await expect(
      service.updateStatus('admin-id', {
        isActive: false,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(userUpdate).not.toHaveBeenCalled();
    expect(sessionUpdateMany).not.toHaveBeenCalled();
  });
});
