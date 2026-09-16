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
  CommercialApprovalStatus,
  CommercialItemType,
  RoleCode,
} from '../../generated/prisma/enums';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  CommercialItemQueryDto,
  CreateCommercialItemDto,
  UpdateCommercialItemApprovalDto,
  UpdateCommercialItemDto,
  UpdateCommercialItemStatusDto,
} from '../dto/commercial-item.dto';
import { CommercialItemsController } from './commercial-items.controller';
import { CommercialItemsService } from './commercial-items.service';

describe('CommercialItemsController', () => {
  const itemId = '966f37f9-0ad8-41f9-bc3d-70945f5ce622';
  const categoryId = 'ab0f65a8-3059-41d4-ad0b-30a3d89831f1';
  const create = jest.fn();
  const findAll = jest.fn();
  const findOne = jest.fn();
  const update = jest.fn();
  const updateStatus = jest.fn();
  const updateApproval = jest.fn();

  const service = {
    create,
    findAll,
    findOne,
    update,
    updateStatus,
    updateApproval,
  } as unknown as CommercialItemsService;

  const controller = new CommercialItemsController(service);

  const createDto: CreateCommercialItemDto = {
    type: CommercialItemType.DISH,
    categoryId,
    nameEs: 'Ají de gallina tradicional',
    basePrice: '39.90',
  };
  const queryDto: CommercialItemQueryDto = {
    page: 1,
    limit: 20,
    sort: 'createdAt',
    order: 'desc',
  };
  const updateDto: UpdateCommercialItemDto = {
    descriptionEs: 'Descripción actualizada.',
  };
  const statusDto: UpdateCommercialItemStatusDto = {
    isActive: false,
  };
  const approvalDto: UpdateCommercialItemApprovalDto = {
    approvalStatus: CommercialApprovalStatus.APPROVED,
  };

  const rolesFor = (methodName: string): RoleCode[] => {
    const descriptor = Object.getOwnPropertyDescriptor(
      CommercialItemsController.prototype,
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
    const expected = { id: itemId };
    create.mockResolvedValue(expected);

    await expect(controller.create(createDto)).resolves.toBe(expected);
    expect(create).toHaveBeenCalledWith(createDto);
  });

  it('delega GET de listado y sus filtros en el servicio', async () => {
    const expected = {
      data: [{ id: itemId }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    };
    findAll.mockResolvedValue(expected);

    await expect(controller.findAll(queryDto)).resolves.toBe(expected);
    expect(findAll).toHaveBeenCalledWith(queryDto);
  });

  it('delega GET de detalle en el servicio', async () => {
    const expected = { id: itemId };
    findOne.mockResolvedValue(expected);

    await expect(controller.findOne(itemId)).resolves.toBe(expected);
    expect(findOne).toHaveBeenCalledWith(itemId);
  });

  it('delega PATCH general en el servicio', async () => {
    const expected = { id: itemId };
    update.mockResolvedValue(expected);

    await expect(controller.update(itemId, updateDto)).resolves.toBe(expected);
    expect(update).toHaveBeenCalledWith(itemId, updateDto);
  });

  it('delega PATCH de estado en el servicio', async () => {
    const expected = { id: itemId, isActive: false };
    updateStatus.mockResolvedValue(expected);

    await expect(controller.updateStatus(itemId, statusDto)).resolves.toBe(
      expected,
    );
    expect(updateStatus).toHaveBeenCalledWith(itemId, statusDto);
  });

  it('delega PATCH de aprobación en el servicio', async () => {
    const expected = {
      id: itemId,
      approvalStatus: CommercialApprovalStatus.APPROVED,
    };
    updateApproval.mockResolvedValue(expected);

    await expect(controller.updateApproval(itemId, approvalDto)).resolves.toBe(
      expected,
    );
    expect(updateApproval).toHaveBeenCalledWith(itemId, approvalDto);
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

  it('permite escritura, estado y aprobación únicamente a ADMIN', () => {
    for (const methodName of [
      'create',
      'update',
      'updateStatus',
      'updateApproval',
    ]) {
      expect(rolesFor(methodName)).toEqual([RoleCode.ADMIN]);
    }
  });

  it('protege el controller con access token y roles', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      CommercialItemsController,
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
        controllers: [CommercialItemsController],
        providers: [
          {
            provide: CommercialItemsService,
            useValue: {
              create,
              findAll,
              findOne,
              update,
              updateStatus,
              updateApproval,
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
      create.mockResolvedValue({ id: itemId });
      findAll.mockResolvedValue({
        data: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
      findOne.mockResolvedValue({ id: itemId });
      update.mockResolvedValue({ id: itemId });
      updateStatus.mockResolvedValue({ id: itemId, isActive: false });
      updateApproval.mockResolvedValue({
        id: itemId,
        approvalStatus: CommercialApprovalStatus.APPROVED,
      });
    });

    it('devuelve 401 sin autenticación', async () => {
      await request(httpServer).get('/commercial-items').expect(401);
    });

    it.each([RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR])(
      'permite GET a %s',
      async (role) => {
        await request(httpServer)
          .get('/commercial-items')
          .set('x-test-role', role)
          .expect(200);
      },
    );

    it('rechaza GET para SUPPORT', async () => {
      await request(httpServer)
        .get('/commercial-items')
        .set('x-test-role', RoleCode.SUPPORT)
        .expect(403);
    });

    it.each([RoleCode.OWNER, RoleCode.OPERATOR, RoleCode.SUPPORT])(
      'rechaza aprobación para %s',
      async (role) => {
        await request(httpServer)
          .patch(`/commercial-items/${itemId}/approval`)
          .set('x-test-role', role)
          .send(approvalDto)
          .expect(403);
      },
    );

    it('permite POST a ADMIN', async () => {
      await request(httpServer)
        .post('/commercial-items')
        .set('x-test-role', RoleCode.ADMIN)
        .send(createDto)
        .expect(201);
    });

    it('permite aprobación a ADMIN', async () => {
      await request(httpServer)
        .patch(`/commercial-items/${itemId}/approval`)
        .set('x-test-role', RoleCode.ADMIN)
        .send(approvalDto)
        .expect(200);
    });

    it('devuelve 400 para un UUID inválido sin invocar el servicio', async () => {
      await request(httpServer)
        .get('/commercial-items/not-a-uuid')
        .set('x-test-role', RoleCode.ADMIN)
        .expect(400);

      expect(findOne).not.toHaveBeenCalled();
    });

    it('devuelve 400 para un body inválido sin invocar el servicio', async () => {
      await request(httpServer)
        .post('/commercial-items')
        .set('x-test-role', RoleCode.ADMIN)
        .send({
          type: 'INVENTED_TYPE',
          categoryId,
          nameEs: 'Producto inválido',
          basePrice: '10.00',
        })
        .expect(400);

      expect(create).not.toHaveBeenCalled();
    });

    it('devuelve 400 para un query inválido sin invocar el servicio', async () => {
      await request(httpServer)
        .get('/commercial-items?limit=101')
        .set('x-test-role', RoleCode.ADMIN)
        .expect(400);

      expect(findAll).not.toHaveBeenCalled();
    });
  });
});
