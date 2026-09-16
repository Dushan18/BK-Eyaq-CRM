import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';

import { PASSWORD_SALT_ROUNDS } from '../common/constants/security.constants';
import { PrismaService } from '../database/prisma.service';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { MailService } from './mail/mail.service';

const GENERIC_FORGOT_PASSWORD_RESPONSE = {
  message:
    'Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña',
};

const INVALID_RESET_TOKEN_MESSAGE =
  'El enlace de recuperación es inválido o ha expirado';

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly tokenTtlMinutes: number;
  private readonly frontendResetUrl: URL;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {
    this.tokenTtlMinutes = this.readTokenTtl();
    this.frontendResetUrl = this.readFrontendResetUrl();
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.trim().toLowerCase();

    // Generar siempre el material criptográfico reduce diferencias entre rutas.
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        firstName: true,
        isActive: true,
      },
    });

    if (!user?.isActive) {
      return GENERIC_FORGOT_PASSWORD_RESPONSE;
    }

    const expiresAt = new Date(Date.now() + this.tokenTtlMinutes * 60 * 1000);

    let resetTokenId: string;

    try {
      resetTokenId = await this.prisma.$transaction(
        async (tx) => {
          await tx.passwordResetToken.deleteMany({
            where: { userId: user.id },
          });

          const resetToken = await tx.passwordResetToken.create({
            data: {
              userId: user.id,
              tokenHash,
              expiresAt,
            },
            select: { id: true },
          });

          return resetToken.id;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch {
      this.logger.error(
        'No se pudo crear el token de recuperación de contraseña',
      );
      return GENERIC_FORGOT_PASSWORD_RESPONSE;
    }

    const resetUrl = new URL(this.frontendResetUrl.toString());
    resetUrl.searchParams.set('token', rawToken);

    try {
      await this.mailService.sendPasswordResetEmail({
        to: user.email,
        firstName: user.firstName,
        resetUrl: resetUrl.toString(),
        expiresInMinutes: this.tokenTtlMinutes,
      });
    } catch {
      try {
        await this.prisma.passwordResetToken.deleteMany({
          where: {
            id: resetTokenId,
            tokenHash,
            usedAt: null,
          },
        });
      } catch {
        this.logger.error(
          'No se pudo invalidar un token cuyo correo no fue enviado',
        );
      }

      this.logger.error(
        'No se pudo enviar el correo de recuperación de contraseña',
      );
    }

    return GENERIC_FORGOT_PASSWORD_RESPONSE;
  }

  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = this.hashToken(dto.token);
    const passwordHash = await bcrypt.hash(
      dto.newPassword,
      PASSWORD_SALT_ROUNDS,
    );
    const now = new Date();

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const resetToken = await tx.passwordResetToken.findUnique({
            where: { tokenHash },
            select: {
              id: true,
              userId: true,
              expiresAt: true,
              usedAt: true,
              user: {
                select: { isActive: true },
              },
            },
          });

          if (
            !resetToken ||
            resetToken.usedAt ||
            resetToken.expiresAt <= now ||
            !resetToken.user.isActive
          ) {
            throw new BadRequestException(INVALID_RESET_TOKEN_MESSAGE);
          }

          const consumedToken = await tx.passwordResetToken.updateMany({
            where: {
              id: resetToken.id,
              tokenHash,
              usedAt: null,
              expiresAt: { gt: now },
            },
            data: { usedAt: now },
          });

          if (consumedToken.count !== 1) {
            throw new BadRequestException(INVALID_RESET_TOKEN_MESSAGE);
          }

          const updatedUser = await tx.user.updateMany({
            where: {
              id: resetToken.userId,
              isActive: true,
            },
            data: { passwordHash },
          });

          if (updatedUser.count !== 1) {
            throw new BadRequestException(INVALID_RESET_TOKEN_MESSAGE);
          }

          await tx.session.updateMany({
            where: {
              userId: resetToken.userId,
              revokedAt: null,
            },
            data: { revokedAt: now },
          });

          await tx.passwordResetToken.deleteMany({
            where: {
              userId: resetToken.userId,
              id: { not: resetToken.id },
            },
          });
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error: unknown) {
      if (
        error instanceof BadRequestException ||
        this.isPrismaConflict(error)
      ) {
        throw new BadRequestException(INVALID_RESET_TOKEN_MESSAGE);
      }

      throw error;
    }

    return {
      message: 'Contraseña restablecida correctamente',
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private readTokenTtl(): number {
    const rawTtl =
      this.configService.get<string>('PASSWORD_RESET_TOKEN_TTL_MINUTES') ??
      '15';
    const ttl = Number(rawTtl);

    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 1440) {
      throw new Error(
        'PASSWORD_RESET_TOKEN_TTL_MINUTES debe ser un entero entre 1 y 1440',
      );
    }

    return ttl;
  }

  private readFrontendResetUrl(): URL {
    const configuredUrl =
      this.configService.get<string>('FRONTEND_RESET_PASSWORD_URL') ??
      'http://localhost:5173/reset-password';

    try {
      const resetUrl = new URL(configuredUrl);

      if (!['http:', 'https:'].includes(resetUrl.protocol)) {
        throw new Error('Protocolo inválido');
      }

      return resetUrl;
    } catch {
      throw new Error(
        'FRONTEND_RESET_PASSWORD_URL debe ser una URL HTTP o HTTPS válida',
      );
    }
  }

  private isPrismaConflict(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2034'
    );
  }
}
