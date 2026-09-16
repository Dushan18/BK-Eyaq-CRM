import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import {
  CurrencyCode,
  DayOfWeek,
  LanguageCode,
  RoleCode,
} from '../../generated/prisma/enums';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PutRestaurantConfigDto } from '../dto/put-restaurant-config.dto';
import { RestaurantConfigController } from './restaurant-config.controller';
import { RestaurantConfigService } from './restaurant-config.service';

describe('RestaurantConfigController', () => {
  const findOne = jest.fn();
  const upsert = jest.fn();

  const service = {
    findOne,
    upsert,
  } as unknown as RestaurantConfigService;

  const controller = new RestaurantConfigController(service);

  const dto: PutRestaurantConfigDto = {
    businessName: 'Sabor Mágico Grill',
    address: 'Lima, Perú',
    whatsappNumber: '+51999999999',
    email: 'contacto@sabormagico.com',
    currency: CurrencyCode.PEN,
    timeZone: 'America/Lima',
    reservationPolicy: 'Reserva sujeta a disponibilidad.',
    cancellationPolicy: 'Cancelar con anticipación.',
    responseTimeoutMinutes: 15,
    languages: [LanguageCode.ES],
    schedules: Object.values(DayOfWeek).map((dayOfWeek) => ({
      dayOfWeek,
      isOpen: false,
    })),
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('delega GET en el servicio', async () => {
    const expected = { id: 'restaurant-config-id' };
    findOne.mockResolvedValue(expected);

    await expect(controller.findOne()).resolves.toBe(expected);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('delega PUT completo en el servicio', async () => {
    const expected = { id: 'restaurant-config-id' };
    upsert.mockResolvedValue(expected);

    await expect(controller.upsert(dto)).resolves.toBe(expected);
    expect(upsert).toHaveBeenCalledWith(dto);
  });

  it('permite consultar a ADMIN, OWNER y OPERATOR', () => {
    const handler = Object.getOwnPropertyDescriptor(
      RestaurantConfigController.prototype,
      'findOne',
    )?.value as () => unknown;
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as RoleCode[];

    expect(roles).toEqual([RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR]);
    expect(roles).not.toContain(RoleCode.SUPPORT);
  });

  it('permite modificar únicamente a ADMIN', () => {
    const handler = Object.getOwnPropertyDescriptor(
      RestaurantConfigController.prototype,
      'upsert',
    )?.value as (dto: PutRestaurantConfigDto) => unknown;
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as RoleCode[];

    expect(roles).toEqual([RoleCode.ADMIN]);
  });

  it('protege el controller con access token y roles', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      RestaurantConfigController,
    ) as unknown[];

    expect(guards).toEqual([AccessTokenGuard, RolesGuard]);
  });

  describe('autorización HTTP', () => {
    let app: INestApplication;
    let httpServer: App;

    class TestAccessTokenGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const request_ = context.switchToHttp().getRequest<{
          headers: Record<string, string | string[] | undefined>;
          user?: AuthenticatedUser;
        }>();
        const roleHeader = request_.headers['x-test-role'];

        if (typeof roleHeader !== 'string') {
          throw new UnauthorizedException();
        }

        request_.user = {
          id: 'test-user-id',
          sessionId: 'test-session-id',
          firstName: 'Test',
          lastName: 'User',
          email: 'test@eyaqsystems.com',
          roles: [roleHeader as RoleCode],
        };

        return true;
      }
    }

    beforeAll(async () => {
      const moduleFixture = await Test.createTestingModule({
        controllers: [RestaurantConfigController],
        providers: [
          {
            provide: RestaurantConfigService,
            useValue: {
              findOne,
              upsert,
            },
          },
          RolesGuard,
        ],
      })
        .overrideGuard(AccessTokenGuard)
        .useClass(TestAccessTokenGuard)
        .compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await app.init();
      httpServer = app.getHttpServer() as App;
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      findOne.mockResolvedValue({ id: 'restaurant-config-id' });
      upsert.mockResolvedValue({ id: 'restaurant-config-id' });
    });

    it('devuelve 401 sin autenticación', async () => {
      await request(httpServer).get('/restaurant-config').expect(401);
    });

    it('devuelve 401 al intentar modificar sin autenticación', async () => {
      await request(httpServer).put('/restaurant-config').send(dto).expect(401);
    });

    it.each([RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR])(
      'permite GET a %s',
      async (role) => {
        await request(httpServer)
          .get('/restaurant-config')
          .set('x-test-role', role)
          .expect(200);
      },
    );

    it('rechaza GET para SUPPORT', async () => {
      await request(httpServer)
        .get('/restaurant-config')
        .set('x-test-role', RoleCode.SUPPORT)
        .expect(403);
    });

    it.each([RoleCode.OWNER, RoleCode.OPERATOR, RoleCode.SUPPORT])(
      'rechaza PUT para %s',
      async (role) => {
        await request(httpServer)
          .put('/restaurant-config')
          .set('x-test-role', role)
          .send(dto)
          .expect(403);
      },
    );

    it('permite PUT a ADMIN', async () => {
      await request(httpServer)
        .put('/restaurant-config')
        .set('x-test-role', RoleCode.ADMIN)
        .send(dto)
        .expect(200);
    });
  });
});
