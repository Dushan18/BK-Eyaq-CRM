import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { UsersService } from './../users/users.service';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { SessionsService } from '../auth/sessions.service';

@Injectable()
export class AccessTokenStrategy extends PassportStrategy(
    Strategy,
    'jwt',
) {
    constructor(
        configService: ConfigService,
        private readonly usersService: UsersService,
        private readonly sessionsService: SessionsService,
    ) {
        const secret = configService.get<string>('JWT_SECRET');

        if (!secret) {
            throw new Error('JWT_SECRET no está configurado');
        }

        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: secret,
            ignoreExpiration: false,
        });
    }

    async validate(payload: JwtPayload) {
        if (!payload.sub || !payload.sessionId) {
            throw new UnauthorizedException(
                'Token de acceso inválido',
            );
        }

        const user = await this.usersService.findById(payload.sub);

        if (!user || !user.isActive) {
            throw new UnauthorizedException(
                'Usuario no autorizado',
            );
        }

        const session =
            await this.sessionsService.findActiveByIdAndUserId(
                payload.sessionId,
                user.id,
            );

        if (!session) {
            throw new UnauthorizedException(
                'Sesión no válida o expirada',
            );
        }

        return {
            id: user.id,
            sessionId: session.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            roles: user.roles.map(
                (userRole) => userRole.role.code,
            ),
        };
    }
}
