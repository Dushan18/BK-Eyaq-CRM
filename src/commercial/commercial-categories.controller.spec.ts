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

import { RoleCode } from '../../generated/prisma/enums';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  CreateCommercialCategoryDto,
  UpdateCommercialCategoryDto,
  UpdateCommercialCategoryStatusDto,
} from '../dto/commercial-category.dto';
import { CommercialCategoriesController } from './commercial-categories.controller';
import { CommercialCategoriesService } from './commercial-categories.service';

describe('CommercialCategoriesController', () => {
  const categoryId = 'ab0f65a8-3059-41d4-ad0b-30a3d89831f1';
  const create = jest.fn();
  const findAll = jest.fn();
  const findOne = jest.fn();
  const update = jest.fn();
  const updateStatus = jest.fn();

  const service = {
    create,
    findAll,
    findOne,
    update,
    updateStatus,
  } as unknown as CommercialCategoriesService;

  const controller = new CommercialCategoriesController(service);

  const createDto: CreateCommercialCategoryDto = {
    nameEs: 'Entradas',
    nameEn: 'Starters',
    displayOrder: 1,
  };
  const updateDto: UpdateCommercialCategoryDto = {
    descriptionEs: 'Opciones para comenzar.',
  };
  const statusDto: UpdateCommercialCategoryStatusDto = {
    isActive: false,
  };

  const rolesFor = (methodName: string): RoleCode[] => {
    const descriptor = Object.getOwnPropertyDescriptor(
      CommercialCategoriesController.prototype,
      methodName,
    );
    const handler: unknown = descriptor?.value;

    if (typeof handler !== 'function') {
      throw new Error(`No existe el método ${methodName}`);
    }

    return Reflect.getMetadata(ROLES_KEY, handler) as RoleCode[];
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('delega POST en el servicio', async () => {
    const expected = { id: categoryId };
    create.mockResolvedValue(expected);

    await expect(controller.create(createDto)).resolves.toBe(expected);
    expect(create).toHaveBeenCalledWith(createDto);
  });

  it('delega GET de listado en el servicio', async () => {
    const expected = [{ id: categoryId }];
    findAll.mockResolvedValue(expected);

    await expect(controller.findAll()).resolves.toBe(expected);
    expect(findAll).toHaveBeenCalledTimes(1);
  });

  it('delega GET de detalle en el servicio', async () => {
    const expected = { id: categoryId };
    findOne.mockResolvedValue(expected);

    await expect(controller.findOne(categoryId)).resolves.toBe(expected);
    expect(findOne).toHaveBeenCalledWith(categoryId);
  });

  it('delega PATCH general en el servicio', async () => {
    const expected = { id: categoryId };
    update.mockResolvedValue(expected);

    await expect(controller.update(categoryId, updateDto)).resolves.toBe(
      expected,
    );
    expect(update).toHaveBeenCalledWith(categoryId, updateDto);
  });

  it('delega PATCH de estado en el servicio', async () => {
    const expected = { id: categoryId, isActive: false };
    updateStatus.mockResolvedValue(expected);

    await expect(controller.updateStatus(categoryId, statusDto)).resolves.toBe(
      expected,
    );
    expect(updateStatus).toHaveBeenCalledWith(categoryId, statusDto);
  });

  it('permite las lecturas a ADMIN, OWNER y OPERATOR', () => {
    for (const methodName of ['findAll', 'findOne']) {
      const roles = rolesFor(methodName);

      expect(roles).toEqual([
        RoleCode.ADMIN,
        RoleCode.OWNER,
        RoleCode.OPERATOR,
      ]);
      expect(roles).not.toContain(RoleCode.SUPPORT);
    }
  });

  it('permite las escrituras únicamente a ADMIN', () => {
    for (const methodName of ['create', 'update', 'updateStatus']) {
      expect(rolesFor(methodName)).toEqual([RoleCode.ADMIN]);
    }
  });

  it('protege el controller con access token y roles', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      CommercialCategoriesController,
    ) as unknown[];

    expect(guards).toEqual([AccessTokenGuard, RolesGuard]);
  });

  describe('autorización y validación HTTP', () => {
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
        controllers: [CommercialCategoriesController],
        providers: [
          {
            provide: CommercialCategoriesService,
            useValue: {
              create,
              findAll,
              findOne,
              update,
              updateStatus,
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
      create.mockResolvedValue({ id: categoryId });
      findAll.mockResolvedValue([]);
      findOne.mockResolvedValue({ id: categoryId });
      update.mockResolvedValue({ id: categoryId });
      updateStatus.mockResolvedValue({ id: categoryId, isActive: false });
    });

    it('devuelve 401 sin autenticación', async () => {
      await request(httpServer).get('/commercial-categories').expect(401);
    });

    it.each([RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR])(
      'permite GET a %s',
      async (role) => {
        await request(httpServer)
          .get('/commercial-categories')
          .set('x-test-role', role)
          .expect(200);
      },
    );

    it('rechaza GET para SUPPORT', async () => {
      await request(httpServer)
        .get('/commercial-categories')
        .set('x-test-role', RoleCode.SUPPORT)
        .expect(403);
    });

    it.each([RoleCode.OWNER, RoleCode.OPERATOR, RoleCode.SUPPORT])(
      'rechaza POST para %s',
      async (role) => {
        await request(httpServer)
          .post('/commercial-categories')
          .set('x-test-role', role)
          .send(createDto)
          .expect(403);
      },
    );

    it('permite POST a ADMIN', async () => {
      await request(httpServer)
        .post('/commercial-categories')
        .set('x-test-role', RoleCode.ADMIN)
        .send(createDto)
        .expect(201);
    });

    it('devuelve 400 para un UUID inválido sin invocar el servicio', async () => {
      await request(httpServer)
        .get('/commercial-categories/not-a-uuid')
        .set('x-test-role', RoleCode.ADMIN)
        .expect(400);

      expect(findOne).not.toHaveBeenCalled();
    });

    it('devuelve 400 para un body inválido sin invocar el servicio', async () => {
      await request(httpServer)
        .post('/commercial-categories')
        .set('x-test-role', RoleCode.ADMIN)
        .send({ nameEs: 'Entradas', displayOrder: -1 })
        .expect(400);

      expect(create).not.toHaveBeenCalled();
    });
  });
});
