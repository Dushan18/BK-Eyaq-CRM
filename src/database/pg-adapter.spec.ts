import type { PrismaClient } from '../../generated/prisma/client';
import { assertUtcDatabase, withUtcSession } from './pg-adapter';

describe('Sesiones UTC de PostgreSQL', () => {
  it('añade TimeZone=UTC sin perder las opciones ni los datos de DATABASE_URL', () => {
    const plain = new URL(
      withUtcSession('postgresql://crm:p%40ss@db:5432/bd_crm?schema=public'),
    );
    expect(plain.searchParams.get('options')).toBe('-c TimeZone=UTC');
    expect(plain.searchParams.get('schema')).toBe('public');
    expect(plain.password).toBe('p%40ss');

    const withOptions = new URL(
      withUtcSession(
        'postgresql://crm@db/bd_crm?options=-c%20search_path%3Dpublic',
      ),
    );
    expect(withOptions.searchParams.get('options')).toBe(
      '-c search_path=public -c TimeZone=UTC',
    );
  });

  const database = (...results: unknown[][]) => {
    const $queryRaw = jest.fn();
    for (const result of results) $queryRaw.mockResolvedValueOnce(result);
    return { $queryRaw } as unknown as Pick<PrismaClient, '$queryRaw'>;
  };

  it('arranca con la sesión en UTC y la migración de fechas aplicada', async () => {
    await expect(
      assertUtcDatabase(
        database([{ zone: 'UTC' }], [{ present: true }], [{ applied: true }]),
      ),
    ).resolves.toBeUndefined();
  });

  it('se niega a arrancar si la sesión no quedó en UTC', async () => {
    await expect(
      assertUtcDatabase(database([{ zone: 'America/Bogota' }])),
    ).rejects.toThrow('America/Bogota y no en UTC');
  });

  it.each([
    { name: 'sin historial de migraciones', results: [[{ present: false }]] },
    {
      name: 'sin la migración de fechas',
      results: [[{ present: true }], [{ applied: false }]],
    },
  ])('se niega a arrancar $name', async ({ results }) => {
    await expect(
      assertUtcDatabase(database([{ zone: 'UTC' }], ...results)),
    ).rejects.toThrow('20261103000000_utc_timestamps');
  });
});
