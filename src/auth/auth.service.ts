import { Injectable, UnauthorizedException, } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { LoginDto } from '../dto/login.dto';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { LoginResponse } from './interfaces/login-response.interface';

import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import type { StringValue } from 'ms';

import { SessionsService } from './sessions.service';
import { RefreshTokenPayload } from './interfaces/refresh-token-payload.interface';

@Injectable()
export class AuthService {

    constructor(
        private readonly usersService: UsersService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly sessionsService: SessionsService,
    ) { }

    async login(dto: LoginDto): Promise<LoginResponse> {
        // 1. Buscar usuario
        const user = await this.usersService.findByEmail(dto.email);

        if (!user) {
            throw new UnauthorizedException(
                'Correo o contraseña incorrectos',
            );
        }
        // 2. Verificar que esté activo
        if (!user.isActive) {
            throw new UnauthorizedException(
                'Correo o contraseña incorrectos',
            );
        }
        // 3. Validar contraseña
        const passwordIsValid = await bcrypt.compare(
            dto.password,
            user.passwordHash,
        );

        if (!passwordIsValid) {
            throw new UnauthorizedException(
                'Correo o contraseña incorrectos',
            );
        }
        // 4. Obtener roles
        const roles = user.roles.map(
            (userRole) => userRole.role.code,
        );
        // 5. Crear primero el ID de la sesión
        const sessionId = randomUUID();

        // 6. Generar Access Token asociado a esa sesión
        const accessPayload: JwtPayload = {
            sub: user.id,
            sessionId,
            email: user.email,
            roles,
        };

        const accessToken =
            await this.jwtService.signAsync(accessPayload);

        // 7. Generar Refresh Token asociado a esa sesión
        const refreshToken =
            await this.generateRefreshToken(
                user.id,
                sessionId,
            );

        const refreshTokenHash =
            this.hashRefreshToken(refreshToken);

        const expiresAt = new Date();

        expiresAt.setDate(
            expiresAt.getDate() + 7,
        );

        await this.sessionsService.create({
            id: sessionId,
            userId: user.id,
            refreshTokenHash,
            expiresAt,
        });

        await this.usersService.updateLastLogin(user.id);

        return {
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                roles,
            },
        };
    }

    private async generateRefreshToken(
        userId: string,
        sessionId: string,

    ): Promise<string> {
        const secret =
            this.configService.get<string>('JWT_REFRESH_SECRET');

        const expiresIn =
            this.configService.get<string>(
                'JWT_REFRESH_EXPIRES_IN',
            ) as StringValue | undefined;

        if (!secret) {
            throw new Error(
                'JWT_REFRESH_SECRET no está configurado',
            );
        }

        if (!expiresIn) {
            throw new Error(
                'JWT_REFRESH_EXPIRES_IN no está configurado',
            );
        }

        const payload: RefreshTokenPayload = {
            sub: userId,
            sessionId,
            jti: randomUUID(),
        };

        return this.jwtService.signAsync(payload, {
            secret,
            expiresIn,
        });
    }


    async refresh(refreshToken: string) {
        const secret = this.configService.get<string>(
            'JWT_REFRESH_SECRET',
        );

        if (!secret) {
            throw new Error(
                'JWT_REFRESH_SECRET no está configurado',
            );
        }

        // 1. Verificar firma y expiración del Refresh Token
        let payload: RefreshTokenPayload;

        try {
            payload =
                await this.jwtService.verifyAsync<RefreshTokenPayload>(
                    refreshToken,
                    {
                        secret,
                    },
                );
        } catch {
            throw new UnauthorizedException(
                'Refresh token inválido o expirado',
            );
        }

        // 2. Buscar la sesión asociada al token
        const session = await this.sessionsService.findById(
            payload.sessionId,
        );

        if (!session) {
            throw new UnauthorizedException(
                'Sesión no válida',
            );
        }

        // 3. Verificar que la sesión pertenezca al usuario
        if (session.userId !== payload.sub) {
            throw new UnauthorizedException(
                'Sesión no válida',
            );
        }

        // 4. Verificar que la sesión no haya sido revocada
        if (session.revokedAt) {
            throw new UnauthorizedException(
                'Sesión revocada',
            );
        }

        // 5. Verificar que la sesión no haya expirado
        if (session.expiresAt <= new Date()) {
            throw new UnauthorizedException(
                'Sesión expirada',
            );
        }

        // 6. Comparar el Refresh Token con su hash
        const receivedTokenHash = this.hashRefreshToken(refreshToken);

        const tokenIsValid = this.hashesMatch(
            receivedTokenHash,
            session.refreshTokenHash,
        );

        if (!tokenIsValid) {
            throw new UnauthorizedException(
                'Refresh token inválido',
            );
        }

        // 7. Buscar al usuario actual
        const user = await this.usersService.findById(
            payload.sub,
        );

        if (!user || !user.isActive) {
            throw new UnauthorizedException(
                'Usuario no autorizado',
            );
        }

        const roles = user.roles.map(
            (userRole) => userRole.role.code,
        );

        // 8. Generar un nuevo Access Token
        const accessPayload: JwtPayload = {
            sub: user.id,
            sessionId: session.id,
            email: user.email,
            roles,
        };

        const accessToken =
            await this.jwtService.signAsync(accessPayload);

        // 9. Generar un nuevo Refresh Token
        const newRefreshToken =
            await this.generateRefreshToken(
                user.id,
                session.id,
            );

        // 10. Guardar solamente su hash
        const newRefreshTokenHash =
            this.hashRefreshToken(newRefreshToken);

        const rotationResult =
            await this.sessionsService.rotateRefreshToken(
                session.id,
                receivedTokenHash,
                newRefreshTokenHash,
            );

        if (rotationResult.count !== 1) {
            throw new UnauthorizedException(
                'Refresh token ya utilizado o sesión no válida',
            );
        }

        return {
            accessToken,
            refreshToken: newRefreshToken,
        };
    }

    private hashRefreshToken(token: string): string {
        return createHash('sha256')
            .update(token)
            .digest('hex');
    }

    private hashesMatch(
        receivedHash: string,
        storedHash: string,
    ): boolean {
        if (!/^[a-f0-9]{64}$/i.test(storedHash)) {
            return false;
        }

        const receivedBuffer = Buffer.from(receivedHash, 'hex');
        const storedBuffer = Buffer.from(storedHash, 'hex');

        return (
            receivedBuffer.length === storedBuffer.length &&
            timingSafeEqual(receivedBuffer, storedBuffer)
        );
    }

    async logout(sessionId: string) {
        await this.sessionsService.revoke(sessionId);

        return {
            message: 'Sesión cerrada correctamente',
        };
    }
}
