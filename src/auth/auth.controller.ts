import { Body, Controller, Post, Get, UseGuards, } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from '../dto/login.dto';

import { AccessTokenGuard } from './guards/access-token.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { RoleCode } from '../../generated/prisma/enums';
import { Roles } from './decorators/roles.decorator';
import { RolesGuard } from './guards/roles.guard';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
    ) { }

    @Post('login')
    login(@Body() dto: LoginDto) {
        return this.authService.login(dto);
    }

    @Get('me')
    @UseGuards(AccessTokenGuard)
    getProfile(
        @CurrentUser() user: AuthenticatedUser,
    ) {
        return user;
    }

    @Get('test-admin')
    @UseGuards(AccessTokenGuard, RolesGuard)
    @Roles(RoleCode.ADMIN)
    testAdmin() {
        return {
            message: 'Acceso autorizado para administrador',
        };
    }

    @Post('refresh')
    refresh(
        @Body() dto: RefreshTokenDto,
    ) {
        return this.authService.refresh(
            dto.refreshToken,
        );
    }

    @Post('logout')
    @UseGuards(AccessTokenGuard)
    logout(
        @CurrentUser() user: AuthenticatedUser,
    ) {
        return this.authService.logout(user.sessionId);
    }
}
