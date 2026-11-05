import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            ttl: 60_000,
            limit: 10,
          },
        ]),
      ],
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {},
        },
        {
          provide: PasswordResetService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

describe('AuthController: límites de intentos', () => {
  let app: INestApplication;
  let server: App;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }])],
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: { login: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: PasswordResetService,
          useValue: {
            forgotPassword: jest.fn().mockResolvedValue({}),
            resetPassword: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    server = app.getHttpServer() as App;
  });

  afterEach(async () => {
    await app.close();
  });

  // Detrás del BFF todas las peticiones llegan con la misma IP: un usuario no
  // debe agotar el cupo de los demás.
  it.each([
    {
      path: 'login',
      limit: 5,
      account: { email: 'ana@example.com', password: 'secreto123' },
      sameAccount: { email: ' Ana@Example.com ', password: 'otra-clave' },
      otherAccount: { email: 'luis@example.com', password: 'secreto123' },
    },
    {
      path: 'forgot-password',
      limit: 3,
      account: { email: 'ana@example.com' },
      sameAccount: { email: 'ANA@example.com' },
      otherAccount: { email: 'luis@example.com' },
    },
    {
      path: 'reset-password',
      limit: 5,
      account: { token: 'a'.repeat(64), newPassword: 'Clave-nueva-1' },
      sameAccount: { token: 'a'.repeat(64), newPassword: 'Clave-nueva-2' },
      otherAccount: { token: 'b'.repeat(64), newPassword: 'Clave-nueva-1' },
    },
  ])(
    '$path limita los intentos por cuenta sin bloquear a las demás',
    async ({ path, limit, account, sameAccount, otherAccount }) => {
      const send = (body: object) =>
        request(server).post(`/auth/${path}`).send(body);

      for (let attempt = 0; attempt < limit; attempt++) {
        expect((await send(account)).status).toBeLessThan(300);
      }
      expect((await send(sameAccount)).status).toBe(429);
      expect((await send(otherAccount)).status).toBeLessThan(300);
    },
  );
});
