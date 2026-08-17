import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RoleCode } from '../../../generated/prisma/enums';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  let guard: RolesGuard;

  const createContext = (
    user?: AuthenticatedUser,
  ): ExecutionContext =>
    ({
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    };

    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('permite el acceso cuando la ruta no requiere roles', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    expect(guard.canActivate(createContext())).toBe(true);
  });

  it('permite el acceso cuando coincide alguno de los roles', () => {
    reflector.getAllAndOverride.mockReturnValue([
      RoleCode.ADMIN,
      RoleCode.OWNER,
    ]);

    const user = {
      id: 'user-id',
      sessionId: 'session-id',
      firstName: 'Admin',
      lastName: 'EYAQ',
      email: 'admin@eyaq.systems',
      roles: [RoleCode.ADMIN],
    } satisfies AuthenticatedUser;

    expect(guard.canActivate(createContext(user))).toBe(true);
  });

  it('rechaza el acceso cuando el usuario no tiene el rol requerido', () => {
    reflector.getAllAndOverride.mockReturnValue([
      RoleCode.ADMIN,
    ]);

    const user = {
      id: 'user-id',
      sessionId: 'session-id',
      firstName: 'Operator',
      lastName: 'EYAQ',
      email: 'operator@eyaq.systems',
      roles: [RoleCode.OPERATOR],
    } satisfies AuthenticatedUser;

    expect(() => guard.canActivate(createContext(user))).toThrow(
      ForbiddenException,
    );
  });

  it('rechaza el acceso cuando no existe un usuario autenticado', () => {
    reflector.getAllAndOverride.mockReturnValue([
      RoleCode.ADMIN,
    ]);

    expect(() => guard.canActivate(createContext())).toThrow(
      ForbiddenException,
    );
  });
});
