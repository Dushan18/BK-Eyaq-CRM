/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { BadRequestException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';

import type { PrismaService } from '../database/prisma.service';
import type { MailService } from './mail/mail.service';
import { PasswordResetService } from './password-reset.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('PasswordResetService', () => {
  let loggerErrorSpy: jest.SpyInstance;
  const userFindUnique = jest.fn();
  const tokenDeleteMany = jest.fn();
  const transaction = jest.fn();
  const sendPasswordResetEmail = jest.fn();

  const prisma = {
    user: { findUnique: userFindUnique },
    passwordResetToken: { deleteMany: tokenDeleteMany },
    $transaction: transaction,
  } as unknown as PrismaService;

  const configService = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        PASSWORD_RESET_TOKEN_TTL_MINUTES: '15',
        FRONTEND_RESET_PASSWORD_URL: 'http://localhost:5173/reset-password',
      };

      return values[key];
    }),
  } as unknown as ConfigService;

  const mailService = {
    sendPasswordResetEmail,
  } as unknown as MailService;

  let service: PasswordResetService;

  beforeEach(() => {
    jest.resetAllMocks();
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    service = new PasswordResetService(prisma, configService, mailService);
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  it('guarda solo SHA-256 y envía el token crudo únicamente por correo', async () => {
    const tx = {
      passwordResetToken: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'reset-token-id' }),
      },
    };

    userFindUnique.mockResolvedValue({
      id: 'user-id',
      email: 'user@eyaq.systems',
      firstName: 'Ana',
      isActive: true,
    });
    transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    sendPasswordResetEmail.mockResolvedValue(undefined);

    const response = await service.forgotPassword({
      email: ' USER@EYAQ.SYSTEMS ',
    });

    const mail = sendPasswordResetEmail.mock.calls[0][0] as {
      resetUrl: string;
    };
    const rawToken = new URL(mail.resetUrl).searchParams.get('token');
    const createData = tx.passwordResetToken.create.mock.calls[0][0].data as {
      tokenHash: string;
    };

    expect(rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(createData.tokenHash).toBe(
      createHash('sha256').update(rawToken!).digest('hex'),
    );
    expect(createData.tokenHash).not.toBe(rawToken);
    expect(response).toEqual({
      message:
        'Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña',
    });
  });

  it('responde igual y no envía correo si el usuario no existe', async () => {
    userFindUnique.mockResolvedValue(null);

    await expect(
      service.forgotPassword({ email: 'missing@eyaq.systems' }),
    ).resolves.toEqual({
      message:
        'Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña',
    });

    expect(transaction).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('invalida el token si falla el envío del correo', async () => {
    const tx = {
      passwordResetToken: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'reset-token-id' }),
      },
    };

    userFindUnique.mockResolvedValue({
      id: 'user-id',
      email: 'user@eyaq.systems',
      firstName: 'Ana',
      isActive: true,
    });
    transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );
    sendPasswordResetEmail.mockRejectedValue(new Error('SMTP unavailable'));
    tokenDeleteMany.mockResolvedValue({ count: 1 });

    await service.forgotPassword({ email: 'user@eyaq.systems' });

    expect(tokenDeleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'reset-token-id',
        usedAt: null,
      }),
    });
  });

  it('cambia la contraseña, consume el token y revoca todas las sesiones', async () => {
    const rawToken = 'a'.repeat(64);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const tx = {
      passwordResetToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reset-token-id',
          userId: 'user-id',
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: null,
          user: { isActive: true },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      user: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      session: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );

    await expect(
      service.resetPassword({
        token: rawToken,
        newPassword: 'NuevaPassword123!',
      }),
    ).resolves.toEqual({
      message: 'Contraseña restablecida correctamente',
    });

    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ tokenHash, usedAt: null }),
      data: { usedAt: expect.any(Date) },
    });
    const passwordHash = tx.user.updateMany.mock.calls[0][0].data
      .passwordHash as string;
    await expect(
      bcrypt.compare('NuevaPassword123!', passwordHash),
    ).resolves.toBe(true);
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-id', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('rechaza un token que otra solicitud ya consumió', async () => {
    const tx = {
      passwordResetToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reset-token-id',
          userId: 'user-id',
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: null,
          user: { isActive: true },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );

    await expect(
      service.resetPassword({
        token: 'b'.repeat(64),
        newPassword: 'NuevaPassword123!',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un token expirado', async () => {
    const tx = {
      passwordResetToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reset-token-id',
          userId: 'user-id',
          expiresAt: new Date(Date.now() - 60_000),
          usedAt: null,
          user: { isActive: true },
        }),
      },
    };

    transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );

    await expect(
      service.resetPassword({
        token: 'd'.repeat(64),
        newPassword: 'NuevaPassword123!',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza el reset si el usuario fue desactivado', async () => {
    const tx = {
      passwordResetToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reset-token-id',
          userId: 'user-id',
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: null,
          user: { isActive: false },
        }),
      },
    };

    transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    );

    await expect(
      service.resetPassword({
        token: 'c'.repeat(64),
        newPassword: 'NuevaPassword123!',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
