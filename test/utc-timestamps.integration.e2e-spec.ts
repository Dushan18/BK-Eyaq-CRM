import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { createPgAdapter } from '../src/database/pg-adapter';

const integration =
  process.env.RESERVATIONS_INTEGRATION === '1' ? describe : describe.skip;
const FIX = '20261103000000_utc_timestamps';
const migrations = resolve(__dirname, '..', 'prisma', 'migrations');
const sql = (folder: string) =>
  readFileSync(resolve(migrations, folder, 'migration.sql'), 'utf8');
// Pinned so the test does not depend on the server's own default zone.
const OLD_ZONE = '-c TimeZone=America/Bogota';

integration('Fechas timestamptz: sesiones UTC y reparación de datos', () => {
  let admin: Client;
  let url: URL;
  let name: string;
  const run = async (options: string, text: string) => {
    const client = new Client({ connectionString: url.toString(), options });
    await client.connect();
    try {
      await client.query(text);
    } finally {
      await client.end();
    }
  };
  const epoch = async (prisma: PrismaClient, id: string) =>
    (
      await prisma.$queryRaw<{ value: number }[]>`
        SELECT extract(epoch FROM "lastMessageAt")::float8 AS value
          FROM conversations WHERE id = ${id}`
    )[0].value * 1000;
  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!base) throw new Error('Se requiere TEST_DATABASE_URL o DATABASE_URL');
    name = `crm_utc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const adminUrl = new URL(base);
    adminUrl.pathname = '/postgres';
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    url = new URL(base);
    url.pathname = `/${name}`;
    const folders = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < FIX)
      .map((entry) => entry.name)
      .sort();
    for (const folder of folders) await run(OLD_ZONE, sql(folder));
  });
  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });
  it('repairs instants written by non-UTC sessions; the UTC adapter keeps them exact', async () => {
    const meant = new Date('2026-11-03T01:03:12.089Z');
    const old = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url.toString(),
        options: OLD_ZONE,
      }),
    });
    const fixed = new PrismaClient({
      adapter: createPgAdapter(url.toString()),
    });
    try {
      const customer = await old.customer.create({
        data: {
          sourceChannel: 'WHATSAPP',
          phone: '+51987654321',
          normalizedPhone: '+51987654321',
        },
        select: { id: true },
      });
      const { id } = await old.conversation.create({
        data: {
          customerId: customer.id,
          channel: 'WHATSAPP',
          lastMessageAt: meant,
        },
        select: { id: true },
      });
      // The bug: stored 5 h ahead, while the old client still read it back unchanged.
      expect(await epoch(fixed, id)).toBeCloseTo(
        meant.getTime() + 5 * 3600000,
        0,
      );
      // Select the column: this database stops before later migrations, so the
      // current client's other Conversation columns may not exist yet.
      expect(
        (
          await old.conversation.findUniqueOrThrow({
            where: { id },
            select: { lastMessageAt: true },
          })
        ).lastMessageAt,
      ).toEqual(meant);
      // migrate deploy runs in the same default zone the app used to write.
      await run(OLD_ZONE, sql(FIX));
      expect(await epoch(fixed, id)).toBeCloseTo(meant.getTime(), 0);
      expect(
        (
          await fixed.conversation.findUniqueOrThrow({
            where: { id },
            select: { lastMessageAt: true },
          })
        ).lastMessageAt,
      ).toEqual(meant);
      const later = new Date('2026-11-03T02:00:00.000Z');
      await fixed.conversation.update({
        where: { id },
        data: { lastMessageAt: later },
        select: { id: true },
      });
      expect(await epoch(fixed, id)).toBeCloseTo(later.getTime(), 0);
      // On a database whose default zone is UTC the migration changes nothing.
      await run('-c TimeZone=UTC', sql(FIX));
      expect(await epoch(fixed, id)).toBeCloseTo(later.getTime(), 0);
    } finally {
      await old.$disconnect();
      await fixed.$disconnect();
    }
  });
});
