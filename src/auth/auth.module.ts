import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import type { StringValue } from 'ms';

import { PassportModule } from '@nestjs/passport';
import { AccessTokenStrategy } from '../strategies/access-token.strategy';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from '../users/users.module';
import { SessionsService } from './sessions.service';
import { RolesGuard } from './guards/roles.guard';
import { ThrottlerModule } from '@nestjs/throttler';
import { PasswordResetService } from './password-reset.service';
import { MailService } from './mail/mail.service';
import { ResendMailService } from './mail/resend-mail.service';

@Module({
  imports: [
    UsersModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 10,
      },
    ]),

    PassportModule.register({
      defaultStrategy: 'jwt',
    }),

    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],

      useFactory: (config: ConfigService): JwtModuleOptions => {
        const secret = config.get<string>('JWT_SECRET');

        const expiresIn = config.get<string>('JWT_EXPIRES_IN') as
          StringValue | undefined;

        if (!secret) {
          throw new Error('JWT_SECRET no está configurado');
        }

        if (!expiresIn) {
          throw new Error('JWT_EXPIRES_IN no está configurado');
        }

        return {
          secret,
          signOptions: {
            expiresIn,
          },
        };
      },
    }),
  ],

  controllers: [AuthController],

  providers: [
    AuthService,
    AccessTokenStrategy,
    SessionsService,
    RolesGuard,
    PasswordResetService,
    {
      provide: MailService,
      useClass: ResendMailService,
    },
  ],

  exports: [JwtModule, PassportModule, RolesGuard],
})
export class AuthModule {}
