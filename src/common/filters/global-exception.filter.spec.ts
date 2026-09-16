import 'reflect-metadata';

import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  INestApplication,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { CommonModule } from '../common.module';

const validationMessages = [
  'email must be an email',
  'password must be longer than or equal to 8 characters',
];

const degradedHealthResponse = {
  status: 'error',
  services: {
    api: 'up',
    database: 'down',
  },
  timestamp: '2026-09-03T00:00:00.000Z',
  uptimeSeconds: 12,
};

interface ValidationErrorResponse {
  message: string[];
  error: string;
  statusCode: number;
}

interface InternalServerErrorResponse {
  statusCode: number;
  message: string;
  path: string;
  method: string;
  timestamp: string;
}

@Controller('exception-filter-test')
class ExceptionFilterTestController {
  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException('Solicitud inválida');
  }

  @Get('validation')
  validation(): never {
    throw new BadRequestException(validationMessages);
  }

  @Get('unauthorized')
  unauthorized(): never {
    throw new UnauthorizedException('No autenticado');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException('Acceso denegado');
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundException('Recurso no encontrado');
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException('El recurso ya existe');
  }

  @Get('service-unavailable')
  serviceUnavailable(): never {
    throw new ServiceUnavailableException(degradedHealthResponse);
  }

  @Get('unexpected')
  unexpected(): never {
    const error = new Error(
      'password=database-secret postgresql://admin:secret@database',
    );
    error.stack = `${error.message}\nAuthorization: Bearer secret-access-token`;

    throw error;
  }
}

describe('GlobalExceptionFilter', () => {
  let app: INestApplication;
  let httpServer: App;
  let loggerErrorSpy: jest.SpiedFunction<Logger['error']>;

  beforeAll(async () => {
    loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const moduleFixture = await Test.createTestingModule({
      imports: [CommonModule],
      controllers: [ExceptionFilterTestController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    httpServer = app.getHttpServer() as App;
  });

  beforeEach(() => {
    loggerErrorSpy.mockClear();
  });

  afterAll(async () => {
    await app.close();
    loggerErrorSpy.mockRestore();
  });

  it.each([
    {
      route: 'bad-request',
      statusCode: 400,
      expectedBody: {
        message: 'Solicitud inválida',
        error: 'Bad Request',
        statusCode: 400,
      },
    },
    {
      route: 'unauthorized',
      statusCode: 401,
      expectedBody: {
        message: 'No autenticado',
        error: 'Unauthorized',
        statusCode: 401,
      },
    },
    {
      route: 'forbidden',
      statusCode: 403,
      expectedBody: {
        message: 'Acceso denegado',
        error: 'Forbidden',
        statusCode: 403,
      },
    },
    {
      route: 'not-found',
      statusCode: 404,
      expectedBody: {
        message: 'Recurso no encontrado',
        error: 'Not Found',
        statusCode: 404,
      },
    },
    {
      route: 'conflict',
      statusCode: 409,
      expectedBody: {
        message: 'El recurso ya existe',
        error: 'Conflict',
        statusCode: 409,
      },
    },
    {
      route: 'service-unavailable',
      statusCode: 503,
      expectedBody: degradedHealthResponse,
    },
  ])(
    'preserva el contrato HTTP $statusCode',
    async ({ route, statusCode, expectedBody }) => {
      const response = await request(httpServer)
        .get(`/exception-filter-test/${route}`)
        .expect(statusCode);

      expect(response.body).toEqual(expectedBody);

      if (statusCode < 500) {
        expect(loggerErrorSpy).not.toHaveBeenCalled();
      } else {
        expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('conserva el 404 generado por Nest para una ruta inexistente', async () => {
    const response = await request(httpServer)
      .get('/exception-filter-test/missing-route')
      .expect(404);

    expect(response.body).toEqual({
      message: 'Cannot GET /exception-filter-test/missing-route',
      error: 'Not Found',
      statusCode: 404,
    });
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it('conserva los mensajes de validación como array', async () => {
    const response = await request(httpServer)
      .get('/exception-filter-test/validation')
      .expect(400);
    const body = response.body as ValidationErrorResponse;

    expect(body).toEqual({
      message: validationMessages,
      error: 'Bad Request',
      statusCode: 400,
    });
    expect(Array.isArray(body.message)).toBe(true);
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it('responde y registra de forma segura los errores inesperados', async () => {
    const response = await request(httpServer)
      .get('/exception-filter-test/unexpected?token=secret-query-token')
      .set('Authorization', 'Bearer secret-header-token')
      .expect(500);
    const body = response.body as InternalServerErrorResponse;

    expect(body).toMatchObject({
      statusCode: 500,
      message: 'Ocurrió un error interno',
      path: '/exception-filter-test/unexpected',
      method: 'GET',
    });
    expect(Object.keys(body).sort()).toEqual([
      'message',
      'method',
      'path',
      'statusCode',
      'timestamp',
    ]);
    expect(typeof body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);

    const serializedResponse = JSON.stringify(body);
    const serializedLog = JSON.stringify(loggerErrorSpy.mock.calls);

    for (const output of [serializedResponse, serializedLog]) {
      expect(output).not.toContain('database-secret');
      expect(output).not.toContain('postgresql://');
      expect(output).not.toContain('secret-access-token');
      expect(output).not.toContain('secret-query-token');
      expect(output).not.toContain('secret-header-token');
      expect(output).not.toContain('Authorization');
      expect(output).not.toContain('stack');
    }
  });
});
