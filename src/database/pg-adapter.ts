import { PrismaPg } from '@prisma/adapter-pg';
import type { PrismaClient } from '../../generated/prisma/client';

export const UTC_TIMESTAMPS_MIGRATION = '20261103000000_utc_timestamps';

// @prisma/adapter-pg sends timestamps as UTC wall-clock text without an offset and drops the
// offset when it reads timestamptz values back. Outside a UTC session PostgreSQL therefore
// stores every instant shifted by the server's zone (America/Bogota: 5 h ahead) while the
// app reads it back "correctly". Every client must use this factory; migration
// 20261103000000_utc_timestamps repaired the values written before it existed.
export function createPgAdapter(connectionString: string) {
  return new PrismaPg({ connectionString: withUtcSession(connectionString) });
}

// pg gives the connection string's own parameters precedence over the adapter config, so an
// `options` parameter in DATABASE_URL would silently drop a separate TimeZone option. It is
// appended to that parameter instead.
export function withUtcSession(connectionString: string): string {
  const url = new URL(connectionString);
  const options = url.searchParams.get('options');
  url.searchParams.set(
    'options',
    options ? `${options} -c TimeZone=UTC` : '-c TimeZone=UTC',
  );
  return url.toString();
}

// A pooler that ignores startup parameters (e.g. PgBouncer with ignore_startup_parameters)
// keeps the server zone, and starting before the repair migration leaves the old values
// shifted: either way new and old instants would mix without any error, so refuse to start.
export async function assertUtcDatabase(
  prisma: Pick<PrismaClient, '$queryRaw'>,
): Promise<void> {
  const [session] = await prisma.$queryRaw<{ zone: string }[]>`
    SELECT current_setting('TimeZone') AS zone`;
  if (session?.zone !== 'UTC') {
    throw new Error(
      `PostgreSQL abrió la sesión en la zona ${session?.zone ?? 'desconocida'} y no en UTC: revisa el parámetro options de DATABASE_URL o el pooler de conexiones`,
    );
  }
  const [table] = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('_prisma_migrations') IS NOT NULL AS present`;
  const [migration] = table?.present
    ? await prisma.$queryRaw<{ applied: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM _prisma_migrations
           WHERE migration_name = ${UTC_TIMESTAMPS_MIGRATION}
             AND finished_at IS NOT NULL AND rolled_back_at IS NULL
        ) AS applied`
    : [];
  if (!migration?.applied) {
    throw new Error(
      `Falta aplicar la migración ${UTC_TIMESTAMPS_MIGRATION}: ejecuta npx prisma migrate deploy antes de arrancar el backend`,
    );
  }
}
