import { Logger, ServiceUnavailableException } from '@nestjs/common';

import type { PrismaService } from '../database/prisma.service';
import { HEALTH_DATABASE_TIMEOUT_MS, HealthService } from './health.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

type QueryResult = Array<{ result: number }>;
type QueryRaw = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<QueryResult>;

describe('HealthService', () => {
  const fixedDate = new Date('2026-09-03T15:30:45.123Z');
  const queryRaw = jest.fn<ReturnType<QueryRaw>, Parameters<QueryRaw>>();
  const prisma = {
    $queryRaw: queryRaw,
  } as unknown as PrismaService;

  let service: HealthService;
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    service = new HealthService(prisma);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('devuelve estado saludable con timestamp ISO y uptime entero cuando la consulta responde', async () => {
    jest.useFakeTimers({ now: fixedDate });
    jest.spyOn(process, 'uptime').mockReturnValue(987.654);
    queryRaw.mockResolvedValue([{ result: 1 }]);

    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      services: {
        api: 'up',
        database: 'up',
      },
      timestamp: fixedDate.toISOString(),
      uptimeSeconds: 987,
    });

    expect(new Date(fixedDate.toISOString()).toISOString()).toBe(
      fixedDate.toISOString(),
    );
    expect(loggerErrorSpy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ejecuta exactamente una consulta de lectura SELECT 1', async () => {
    queryRaw.mockResolvedValue([{ result: 1 }]);

    await service.check();

    expect(queryRaw).toHaveBeenCalledTimes(1);

    const [strings, ...values] = queryRaw.mock.calls[0];
    const statement = strings.join(' ').replace(/\s+/g, ' ').trim();

    expect(values).toHaveLength(0);
    expect(statement).toBe('SELECT 1 AS "result"');
    expect(statement).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  });

  it('convierte un rechazo de Prisma en 503 sin exponer secretos ni detalles internos', async () => {
    jest.useFakeTimers({ now: fixedDate });
    jest.spyOn(process, 'uptime').mockReturnValue(42.9);

    const databaseUrl =
      'postgresql://private_user:private_password@db.internal:5432/crm';
    const prismaError = Object.assign(
      new Error(`P1001: DATABASE_URL=${databaseUrl}`),
      {
        code: 'P1001',
        stack: `Error: connection failed\nDATABASE_URL=${databaseUrl}`,
      },
    );
    queryRaw.mockRejectedValue(prismaError);

    let exception: ServiceUnavailableException | undefined;

    try {
      await service.check();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      exception = error as ServiceUnavailableException;
    }

    expect(exception).toBeDefined();
    expect(exception!.getStatus()).toBe(503);
    expect(exception!.getResponse()).toEqual({
      status: 'error',
      services: {
        api: 'up',
        database: 'down',
      },
      timestamp: fixedDate.toISOString(),
      uptimeSeconds: 42,
    });

    const publicResponse = JSON.stringify(exception!.getResponse());
    expect(publicResponse).not.toContain('message');
    expect(publicResponse).not.toContain('stack');
    expect(publicResponse).not.toContain('P1001');
    expect(publicResponse).not.toContain('DATABASE_URL');
    expect(publicResponse).not.toContain(databaseUrl);

    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy.mock.calls[0]).toEqual([
      'Health check database failed',
    ]);

    const serializedLogs = JSON.stringify(loggerErrorSpy.mock.calls);
    expect(serializedLogs).not.toContain('P1001');
    expect(serializedLogs).not.toContain('DATABASE_URL');
    expect(serializedLogs).not.toContain(databaseUrl);
    expect(serializedLogs).not.toContain('private_password');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('vence exactamente a los 3000 ms y responde con ServiceUnavailableException', async () => {
    jest.useFakeTimers({ now: fixedDate });
    jest.spyOn(process, 'uptime').mockReturnValue(3_000.4);
    queryRaw.mockImplementation(
      () => new Promise<QueryResult>(() => undefined),
    );

    expect(HEALTH_DATABASE_TIMEOUT_MS).toBe(3_000);

    const checkPromise = service.check();
    let settled = false;
    void checkPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await jest.advanceTimersByTimeAsync(HEALTH_DATABASE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);

    await expect(checkPromise).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'error',
        services: {
          api: 'up',
          database: 'down',
        },
        timestamp: new Date(
          fixedDate.getTime() + HEALTH_DATABASE_TIMEOUT_MS,
        ).toISOString(),
        uptimeSeconds: 3_000,
      },
    });
    expect(settled).toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith('Health check database failed');
    expect(jest.getTimerCount()).toBe(0);
  });
});
