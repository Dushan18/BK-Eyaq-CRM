import 'reflect-metadata';

import { INestApplication, Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { HealthController } from './health.controller';
import { HealthResponse, HealthService } from './health.service';

describe('HealthController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delega el health check en HealthService', async () => {
    const expected: HealthResponse = {
      status: 'ok',
      services: {
        api: 'up',
        database: 'up',
      },
      timestamp: '2026-09-03T00:00:00.000Z',
      uptimeSeconds: 10,
    };
    const check = jest.fn().mockResolvedValue(expected);
    const service = { check } as unknown as HealthService;
    const controller = new HealthController(service);

    await expect(controller.check()).resolves.toBe(expected);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith();
  });

  it('no declara guards ni roles en el controller o en el endpoint', () => {
    const handler = Object.getOwnPropertyDescriptor(
      HealthController.prototype,
      'check',
    )?.value as () => unknown;

    expect(
      Reflect.getMetadata(GUARDS_METADATA, HealthController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, HealthController)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
  });

  describe('endpoint HTTP público', () => {
    const queryRaw = jest.fn();

    let app: INestApplication;
    let httpServer: App;
    let loggerErrorSpy: jest.SpiedFunction<Logger['error']>;

    beforeAll(async () => {
      loggerErrorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const moduleFixture = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          HealthService,
          {
            provide: PrismaService,
            useValue: {
              $queryRaw: queryRaw,
            },
          },
        ],
      }).compile();

      app = moduleFixture.createNestApplication();
      await app.init();
      httpServer = app.getHttpServer() as App;
    });

    afterAll(async () => {
      loggerErrorSpy.mockRestore();
      await app.close();
    });

    it('responde 200 sin Authorization cuando API y base de datos están saludables', async () => {
      queryRaw.mockResolvedValueOnce([{ result: 1 }]);

      const response = await request(httpServer).get('/health').expect(200);
      const body = response.body as HealthResponse;

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(body.status).toBe('ok');
      expect(body.services).toEqual({ api: 'up', database: 'up' });
      expect(Object.keys(body).sort()).toEqual([
        'services',
        'status',
        'timestamp',
        'uptimeSeconds',
      ]);
      expect(typeof body.timestamp).toBe('string');
      expect(typeof body.uptimeSeconds).toBe('number');
      expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
      expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('responde 503 con un body sanitizado si la base de datos falla', async () => {
      const sensitiveDatabaseError =
        'password=secret postgresql://admin:secret@database SELECT 1';
      queryRaw.mockRejectedValueOnce(new Error(sensitiveDatabaseError));

      const response = await request(httpServer).get('/health').expect(503);
      const body = response.body as HealthResponse;

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(body.status).toBe('error');
      expect(body.services).toEqual({ api: 'up', database: 'down' });
      expect(Object.keys(body).sort()).toEqual([
        'services',
        'status',
        'timestamp',
        'uptimeSeconds',
      ]);
      expect(typeof body.timestamp).toBe('string');
      expect(typeof body.uptimeSeconds).toBe('number');
      expect(response.text).not.toContain(sensitiveDatabaseError);
      expect(response.text).not.toContain('password=secret');
      expect(response.text).not.toContain('postgresql://');
      expect(response.text).not.toContain('stack');
    });
  });
});
