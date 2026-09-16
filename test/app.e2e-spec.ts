import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { HealthResponse } from './../src/health/health.service';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/health (GET) comprueba PostgreSQL sin autenticación', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect((response) => {
        const body = response.body as HealthResponse;

        expect(body.status).toBe('ok');
        expect(body.services).toEqual({
          api: 'up',
          database: 'up',
        });
        expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
        expect(body.uptimeSeconds).toEqual(expect.any(Number));
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
