import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RoleCode } from '../../../generated/prisma/enums';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

@Injectable()
export class RolesGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) { }

    canActivate(context: ExecutionContext): boolean {
        const requiredRoles =
            this.reflector.getAllAndOverride<RoleCode[]>(
                ROLES_KEY,
                [
                    context.getHandler(),
                    context.getClass(),
                ],
            );

        if (!requiredRoles || requiredRoles.length === 0) {
            return true;
        }

        const request = context
            .switchToHttp()
            .getRequest<{ user?: AuthenticatedUser }>();

        const user = request.user;

        if (!user) {
            throw new ForbiddenException(
                'Usuario no disponible en la solicitud',
            );
        }

        const userRoles = user.roles;

        const hasRole = requiredRoles.some((role) =>
            userRoles.includes(role),
        );

        if (!hasRole) {
            throw new ForbiddenException(
                'No tienes permisos para realizar esta acción',
            );
        }

        return true;
    }
}
