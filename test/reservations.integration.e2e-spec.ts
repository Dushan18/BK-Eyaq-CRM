import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient } from '../generated/prisma/client';
import { RoleCode } from '../generated/prisma/enums';
import { PrismaService } from '../src/database/prisma.service';
import { AppModule } from '../src/app.module';

interface BookingResponse {
  id: string;
  code: string;
  status: string;
  reservationAt: string | null;
  numberOfPeople: number | null;
  quotedPrice?: string | null;
  currency?: string | null;
  comments?: string | null;
  notes?: string | null;
  updatedAt: string;
  commercialItem?: { id: string; isActive: boolean } | null;
}
interface BookingPage {
  data: BookingResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const integration =
  process.env.RESERVATIONS_INTEGRATION === '1' ? describe : describe.skip;

integration('Reservas: PostgreSQL aislado, JWT y módulos reales', () => {
  jest.setTimeout(60000);
  const databaseName =
    'crm_reservations_test_' + randomUUID().replaceAll('-', '');
  let databaseCreated = false;
  let admin: Client;
  let prisma: PrismaClient;
  let app: INestApplication;
  let server: App;
  let customerId: string;
  let itemId: string;
  let inactiveId: string;
  let draftId: string;
  const tokens = {} as Record<RoleCode, string>;
  const password = 'OnlyForIsolatedTest123!';
  const future = (days = 7) =>
    new Date(Date.now() + days * 86400000).toISOString();
  const reqBody = () => ({ customerId, sourceChannel: 'PHONE' });
  const resBody = () => ({
    customerId,
    reservationAt: future(),
    numberOfPeople: 4,
  });
  const auth = (role: RoleCode = RoleCode.ADMIN) => `Bearer ${tokens[role]}`;
  const createRequest = async (extra: object = {}) => {
    const result = await request(server)
      .post('/reservation-requests')
      .set('Authorization', auth())
      .send({ ...reqBody(), ...extra })
      .expect(201);
    return result.body as BookingResponse;
  };
  const createReservation = async (extra: object = {}) => {
    const result = await request(server)
      .post('/reservations')
      .set('Authorization', auth())
      .send({ ...resBody(), ...extra })
      .expect(201);
    return result.body as BookingResponse;
  };

  beforeAll(async () => {
    const connectionString =
      process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString)
      throw new Error('Se requiere TEST_DATABASE_URL o DATABASE_URL');
    admin = new Client({ connectionString });
    await admin.connect();
    if (!/^crm_reservations_test_[a-f0-9]{32}$/.test(databaseName))
      throw new Error('Nombre temporal inválido');
    await admin.query('CREATE DATABASE "' + databaseName + '"');
    databaseCreated = true;
    const testUrl = new URL(connectionString);
    testUrl.pathname = '/' + databaseName;
    testUrl.searchParams.delete('schema');
    const migrationClient = new Client({
      connectionString: testUrl.toString(),
    });
    await migrationClient.connect();
    try {
      const migrationRoot = resolve(__dirname, '../prisma/migrations');
      for (const folder of readdirSync(migrationRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        await migrationClient.query(
          readFileSync(
            resolve(migrationRoot, folder.name, 'migration.sql'),
            'utf8',
          ),
        );
      }
    } finally {
      await migrationClient.end();
    }
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testUrl.toString() }),
    });
    await prisma.$connect();
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = fixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    server = app.getHttpServer() as App;
    await prisma.restaurantConfig.create({
      data: {
        businessName: 'Test restaurant',
        address: 'Test address',
        whatsappNumber: '+51987654321',
        email: 'restaurant@example.com',
        currency: 'PEN',
        timeZone: 'America/Lima',
        reservationPolicy: 'Test policy',
        cancellationPolicy: 'Test cancellation',
        responseTimeoutMinutes: 15,
      },
    });
    const passwordHash = await bcrypt.hash(password, 4);
    for (const role of Object.values(RoleCode)) {
      const createdRole = await prisma.role.create({
        data: { code: role, name: role },
      });
      await prisma.user.create({
        data: {
          firstName: role,
          lastName: 'Test',
          email: `${role.toLowerCase()}@test.example`,
          passwordHash,
          roles: { create: { roleId: createdRole.id } },
        },
      });
      const login = await request(server)
        .post('/auth/login')
        .send({ email: `${role.toLowerCase()}@test.example`, password })
        .expect(201);
      tokens[role] = (login.body as Tokens).accessToken;
    }
    const customer = await prisma.customer.create({
      data: {
        firstName: 'ReservaTest',
        email: 'customer@example.com',
        normalizedEmail: 'customer@example.com',
        sourceChannel: 'PHONE',
        phone: '+51 987 654 321',
        normalizedPhone: '+51987654321',
      },
    });
    customerId = customer.id;
    const category = await prisma.commercialCategory.create({
      data: { nameEs: 'Test category', normalizedNameEs: 'test category' },
    });
    for (const [name, active, approved] of [
      ['active', true, true],
      ['inactive', false, true],
      ['draft', true, false],
    ] as const) {
      const item = await prisma.commercialItem.create({
        data: {
          nameEs: name,
          normalizedName: name,
          categoryId: category.id,
          type: 'SERVICE',
          isActive: active,
          approvalStatus: approved ? 'APPROVED' : 'DRAFT',
        },
      });
      if (name === 'active') itemId = item.id;
      if (name === 'inactive') inactiveId = item.id;
      if (name === 'draft') draftId = item.id;
    }
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      if (prisma) await prisma.$disconnect();
      if (admin) {
        try {
          if (
            databaseCreated &&
            /^crm_reservations_test_[a-f0-9]{32}$/.test(databaseName)
          )
            await admin.query('DROP DATABASE "' + databaseName + '"');
        } finally {
          await admin.end();
        }
      }
    }
  });

  it.each([RoleCode.ADMIN, RoleCode.OPERATOR])(
    '%s crea solicitud incompleta con JWT real',
    async (role) => {
      const result = await request(server)
        .post('/reservation-requests')
        .set('Authorization', auth(role))
        .send(reqBody())
        .expect(201);
      expect((result.body as BookingResponse).status).toBe('INCOMPLETE_DATA');
    },
  );

  it.each([RoleCode.OWNER, RoleCode.SUPPORT])(
    '%s no escribe solicitudes',
    async (role) => {
      const id = randomUUID();
      await request(server)
        .post('/reservation-requests')
        .set('Authorization', auth(role))
        .send(reqBody())
        .expect(403);
      await request(server)
        .patch(`/reservation-requests/${id}`)
        .set('Authorization', auth(role))
        .send({ comments: 'Test' })
        .expect(403);
      await request(server)
        .patch(`/reservation-requests/${id}/status`)
        .set('Authorization', auth(role))
        .send({ status: 'CANCELLED' })
        .expect(403);
    },
  );

  it.each([RoleCode.OPERATOR, RoleCode.OWNER, RoleCode.SUPPORT])(
    '%s no crea reserva manual',
    async (role) => {
      await request(server)
        .post('/reservations')
        .set('Authorization', auth(role))
        .send(resBody())
        .expect(403);
    },
  );

  it.each([RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR])(
    '%s consulta listas y detalles',
    async (role) => {
      const rr = await createRequest();
      const r = await createReservation();
      for (const path of [
        '/reservation-requests',
        `/reservation-requests/${rr.id}`,
        '/reservations',
        `/reservations/${r.id}`,
      ])
        await request(server)
          .get(path)
          .set('Authorization', auth(role))
          .expect(200);
    },
  );

  it('SUPPORT no lee, OWNER/SUPPORT no actualizan reservas', async () => {
    const r = await createReservation();
    for (const path of [
      '/reservation-requests',
      '/reservations',
      `/reservations/${r.id}`,
    ])
      await request(server)
        .get(path)
        .set('Authorization', auth(RoleCode.SUPPORT))
        .expect(403);
    for (const role of [RoleCode.OWNER, RoleCode.SUPPORT]) {
      await request(server)
        .patch(`/reservations/${r.id}`)
        .set('Authorization', auth(role))
        .send({ notes: 'Test' })
        .expect(403);
      await request(server)
        .patch(`/reservations/${r.id}/status`)
        .set('Authorization', auth(role))
        .send({ status: 'CANCELLED' })
        .expect(403);
    }
  });

  it('sin token o token inválido devuelve 401', async () => {
    for (const path of ['/reservation-requests', '/reservations']) {
      await request(server).get(path).expect(401);
      await request(server).post(path).send({}).expect(401);
      await request(server)
        .get(path)
        .set('Authorization', 'Bearer invalid')
        .expect(401);
    }
  });

  it('cliente inexistente devuelve 404 en ambos módulos', async () => {
    await request(server)
      .post('/reservation-requests')
      .set('Authorization', auth())
      .send({ ...reqBody(), customerId: randomUUID() })
      .expect(404);
    await request(server)
      .post('/reservations')
      .set('Authorization', auth())
      .send({ ...resBody(), customerId: randomUUID() })
      .expect(404);
  });

  it('item inexistente 404, inactivo/borrador 400', async () => {
    for (const [commercialItemId, expected] of [
      [randomUUID(), 404],
      [inactiveId, 400],
      [draftId, 400],
    ] as const) {
      await request(server)
        .post('/reservation-requests')
        .set('Authorization', auth())
        .send({ ...reqBody(), commercialItemId })
        .expect(expected);
      await request(server)
        .post('/reservations')
        .set('Authorization', auth())
        .send({ ...resBody(), commercialItemId })
        .expect(expected);
    }
  });

  it.each([
    { numberOfPeople: 0 },
    { numberOfPeople: 1.5 },
    { reservationAt: 'bad' },
    { reservationAt: '2030-01-01T12:00:00' },
    { reservationAt: '2000-01-01T12:00:00Z' },
    { quotedPrice: '-1.00' },
    { quotedPrice: '1.234' },
    { status: 'ACCEPTED' },
  ])('rechaza solicitud inválida %j', async (bad) => {
    await request(server)
      .post('/reservation-requests')
      .set('Authorization', auth())
      .send({ ...reqBody(), ...bad })
      .expect(400);
  });

  it('completa y vuelve a incompleta sin alterar Customer', async () => {
    const before = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    const rr = await createRequest();
    const complete = await request(server)
      .patch(`/reservation-requests/${rr.id}`)
      .set('Authorization', auth(RoleCode.OPERATOR))
      .send({ reservationAt: future(), numberOfPeople: 4 })
      .expect(200);
    expect((complete.body as BookingResponse).status).toBe('READY_TO_SEND');
    const incomplete = await request(server)
      .patch(`/reservation-requests/${rr.id}`)
      .set('Authorization', auth())
      .send({ numberOfPeople: null })
      .expect(200);
    expect((incomplete.body as BookingResponse).status).toBe('INCOMPLETE_DATA');
    expect(
      await prisma.customer.findUniqueOrThrow({ where: { id: customerId } }),
    ).toEqual(before);
  });

  it('precio string y moneda snapshot, PATCH omisión/null', async () => {
    const rr = await createRequest({
      quotedPrice: '150.00',
      comments: 'Original',
    });
    expect(rr).toMatchObject({ quotedPrice: '150.00', currency: 'PEN' });
    await prisma.restaurantConfig.update({
      where: { scope: 'GLOBAL' },
      data: { currency: 'USD' },
    });
    try {
      const patched = await request(server)
        .patch(`/reservation-requests/${rr.id}`)
        .set('Authorization', auth())
        .send({ specialRequirements: 'Test' })
        .expect(200);
      expect(patched.body as BookingResponse).toMatchObject({
        quotedPrice: '150.00',
        currency: 'PEN',
        comments: 'Original',
      });
      await request(server)
        .patch(`/reservation-requests/${rr.id}`)
        .set('Authorization', auth())
        .send({ currency: null })
        .expect(400);
      const cleared = await request(server)
        .patch(`/reservation-requests/${rr.id}`)
        .set('Authorization', auth())
        .send({ quotedPrice: null, comments: null })
        .expect(200);
      expect(cleared.body as BookingResponse).toMatchObject({
        quotedPrice: null,
        currency: null,
        comments: null,
      });
    } finally {
      await prisma.restaurantConfig.update({
        where: { scope: 'GLOBAL' },
        data: { currency: 'PEN' },
      });
    }
    await request(server)
      .post('/reservation-requests')
      .set('Authorization', auth())
      .send({ ...reqBody(), currency: 'USD' })
      .expect(400);
  });

  it('cancela idempotentemente y no reactiva mediante PATCH', async () => {
    const rr = await createRequest();
    const path = `/reservation-requests/${rr.id}`;
    const cancelled = await request(server)
      .patch(`${path}/status`)
      .set('Authorization', auth())
      .send({ status: 'CANCELLED' })
      .expect(200);
    const repeated = await request(server)
      .patch(`${path}/status`)
      .set('Authorization', auth())
      .send({ status: 'CANCELLED' })
      .expect(200);
    expect((repeated.body as BookingResponse).updatedAt).toBe(
      (cancelled.body as BookingResponse).updatedAt,
    );
    await request(server)
      .patch(path)
      .set('Authorization', auth())
      .send({ reservationAt: future(), numberOfPeople: 2 })
      .expect(409);
  });

  it.each(['ACCEPTED', 'REJECTED', 'READY_TO_SEND', 'RENEGOTIATING'])(
    'no permite asignar manualmente %s',
    async (status) => {
      const rr = await createRequest();
      await request(server)
        .patch(`/reservation-requests/${rr.id}/status`)
        .set('Authorization', auth())
        .send({ status })
        .expect(400);
    },
  );

  it('creaciones concurrentes generan códigos únicos', async () => {
    const requests = await Promise.all(
      Array.from({ length: 8 }, () => createRequest()),
    );
    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => createReservation()),
    );
    expect(new Set(requests.map((row) => row.code)).size).toBe(8);
    expect(new Set(reservations.map((row) => row.code)).size).toBe(8);
    for (const row of requests) expect(row.code).toMatch(/^RES-\d{4}-\d{6,}$/);
    for (const row of reservations)
      expect(row.code).toMatch(/^R-\d{4}-\d{6,}$/);
  });

  it('cancelación concurrente no se pierde frente a edición', async () => {
    const rr = await createRequest();
    const results = await Promise.all([
      request(server)
        .patch(`/reservation-requests/${rr.id}/status`)
        .set('Authorization', auth())
        .send({ status: 'CANCELLED' }),
      request(server)
        .patch(`/reservation-requests/${rr.id}`)
        .set('Authorization', auth())
        .send({ numberOfPeople: 3, reservationAt: future() }),
    ]);
    expect(results[0].status).toBe(200);
    expect([200, 409]).toContain(results[1].status);
    expect(
      (
        await prisma.reservationRequest.findUniqueOrThrow({
          where: { id: rr.id },
        })
      ).status,
    ).toBe('CANCELLED');
  });

  it('filtros combinables y búsqueda de código, nombre y teléfono', async () => {
    const rr = await createRequest({
      commercialItemId: itemId,
      reservationAt: future(20),
      numberOfPeople: 2,
    });
    const result = await request(server)
      .get('/reservation-requests')
      .set('Authorization', auth())
      .query({
        search: rr.code,
        status: 'READY_TO_SEND',
        customerId,
        commercialItemId: itemId,
        channel: 'PHONE',
        dateFrom: future(19),
        dateTo: future(21),
        page: 1,
        limit: 1,
      })
      .expect(200);
    expect((result.body as BookingPage).data.map((row) => row.id)).toEqual([
      rr.id,
    ]);
    expect((result.body as BookingPage).pagination).toEqual({
      page: 1,
      limit: 1,
      total: 1,
      totalPages: 1,
    });
    for (const search of ['ReservaTest', '987654321']) {
      const found = await request(server)
        .get('/reservation-requests')
        .set('Authorization', auth())
        .query({ search, commercialItemId: itemId, limit: 100 })
        .expect(200);
      expect(
        (found.body as BookingPage).data.some((row) => row.id === rr.id),
      ).toBe(true);
    }
    const otherChannel = await request(server)
      .get('/reservation-requests')
      .set('Authorization', auth())
      .query({ search: rr.code, channel: 'EMAIL' })
      .expect(200);
    expect((otherChannel.body as BookingPage).pagination.total).toBe(0);
  });

  it('historial conserva item desactivado y permite editar notas', async () => {
    const rr = await createRequest({
      commercialItemId: itemId,
      reservationAt: future(),
      numberOfPeople: 2,
    });
    const r = await createReservation({ commercialItemId: itemId });
    await prisma.commercialItem.update({
      where: { id: itemId },
      data: { isActive: false },
    });
    try {
      for (const [path, body] of [
        [
          `/reservation-requests/${rr.id}`,
          { comments: 'histórico', commercialItemId: itemId },
        ],
        [
          `/reservations/${r.id}`,
          { notes: 'histórico', commercialItemId: itemId },
        ],
      ] as const) {
        const updated = await request(server)
          .patch(path)
          .set('Authorization', auth())
          .send(body)
          .expect(200);
        expect((updated.body as BookingResponse).commercialItem).toMatchObject({
          id: itemId,
          isActive: false,
        });
      }
    } finally {
      await prisma.commercialItem.update({
        where: { id: itemId },
        data: { isActive: true },
      });
    }
  });

  it('reserva manual confirmada no acepta vínculo ni estado ni fechas pasadas', async () => {
    const r = await createReservation();
    expect(r.status).toBe('CONFIRMED');
    for (const bad of [
      { reservationRequestId: randomUUID() },
      { status: 'COMPLETED' },
      { reservationAt: '2000-01-01T12:00:00Z' },
      { numberOfPeople: null },
    ]) {
      await request(server)
        .post('/reservations')
        .set('Authorization', auth())
        .send({ ...resBody(), ...bad })
        .expect(400);
    }
  });

  it('OPERATOR reprograma, conserva código y cancela', async () => {
    const r = await createReservation();
    const updated = await request(server)
      .patch(`/reservations/${r.id}`)
      .set('Authorization', auth(RoleCode.OPERATOR))
      .send({ reservationAt: future(10), numberOfPeople: 6, notes: 'Cambio' })
      .expect(200);
    expect(updated.body as BookingResponse).toMatchObject({
      code: r.code,
      numberOfPeople: 6,
      status: 'CONFIRMED',
    });
    await request(server)
      .patch(`/reservations/${r.id}/status`)
      .set('Authorization', auth(RoleCode.OPERATOR))
      .send({ status: 'CANCELLED' })
      .expect(200);
    await request(server)
      .patch(`/reservations/${r.id}`)
      .set('Authorization', auth())
      .send({ notes: 'No permitido' })
      .expect(409);
    await request(server)
      .patch(`/reservations/${r.id}/status`)
      .set('Authorization', auth())
      .send({ status: 'CONFIRMED' })
      .expect(409);
  });

  it('flujo operativo y no-show respetan hora reservada', async () => {
    const r = await createReservation();
    for (const status of ['IN_SERVICE', 'NO_SHOW', 'COMPLETED'])
      await request(server)
        .patch(`/reservations/${r.id}/status`)
        .set('Authorization', auth())
        .send({ status })
        .expect(409);
    // Fixture histórica: la API manual no permite importar reservas pasadas.
    await prisma.reservation.update({
      where: { id: r.id },
      data: { reservationAt: new Date(Date.now() - 60000) },
    });
    await request(server)
      .patch(`/reservations/${r.id}`)
      .set('Authorization', auth())
      .send({ notes: 'Nota histórica' })
      .expect(200);
    await request(server)
      .patch(`/reservations/${r.id}/status`)
      .set('Authorization', auth(RoleCode.OPERATOR))
      .send({ status: 'IN_SERVICE' })
      .expect(200);
    await request(server)
      .patch(`/reservations/${r.id}/status`)
      .set('Authorization', auth(RoleCode.OPERATOR))
      .send({ status: 'COMPLETED' })
      .expect(200);
    const absent = await createReservation();
    await prisma.reservation.update({
      where: { id: absent.id },
      data: { reservationAt: new Date(Date.now() - 60000) },
    });
    await request(server)
      .patch(`/reservations/${absent.id}/status`)
      .set('Authorization', auth())
      .send({ status: 'NO_SHOW' })
      .expect(200);
  });

  it('calendario excluye solicitudes, rango semiabierto y orden cronológico', async () => {
    const start = new Date(Date.now() + 60 * 86400000);
    start.setUTCHours(0, 0, 0, 0);
    const middle = new Date(start.getTime() + 3600000);
    const end = new Date(start.getTime() + 86400000);
    const ready = await createRequest({
      reservationAt: start.toISOString(),
      numberOfPeople: 2,
    });
    const rejected = await createRequest({
      reservationAt: start.toISOString(),
      numberOfPeople: 2,
    });
    await prisma.reservationRequest.update({
      where: { id: rejected.id },
      data: { status: 'REJECTED' },
    });
    const later = await createReservation({
      reservationAt: middle.toISOString(),
    });
    const first = await createReservation({
      reservationAt: start.toISOString(),
    });
    await createReservation({ reservationAt: end.toISOString() });
    const result = await request(server)
      .get('/reservations')
      .set('Authorization', auth())
      .query({
        dateFrom: start.toISOString(),
        dateTo: end.toISOString(),
        status: 'CONFIRMED',
        customerId,
      })
      .expect(200);
    const ids = (result.body as BookingPage).data.map((row) => row.id);
    expect(ids).toEqual([first.id, later.id]);
    expect(ids).not.toContain(ready.id);
    expect(ids).not.toContain(rejected.id);
    const page = await request(server)
      .get('/reservations')
      .set('Authorization', auth())
      .query({
        dateFrom: start.toISOString(),
        dateTo: end.toISOString(),
        limit: 1,
        page: 2,
      })
      .expect(200);
    expect((page.body as BookingPage).data.map((row) => row.id)).toEqual([
      later.id,
    ]);
    expect((page.body as BookingPage).pagination.totalPages).toBe(2);
  });

  it('normaliza offset al mismo instante UTC', async () => {
    const day = future(40).slice(0, 10);
    const r = await createReservation({
      reservationAt: `${day}T12:00:00-05:00`,
    });
    expect(r.reservationAt).toBe(`${day}T17:00:00.000Z`);
  });

  it('rango invertido, UUID inválido, ausencia y PATCH vacío', async () => {
    for (const root of ['/reservation-requests', '/reservations']) {
      await request(server)
        .get(root)
        .set('Authorization', auth())
        .query({ dateFrom: future(10), dateTo: future(1) })
        .expect(400);
      await request(server)
        .get(`${root}/invalid`)
        .set('Authorization', auth())
        .expect(400);
      await request(server)
        .get(`${root}/${randomUUID()}`)
        .set('Authorization', auth())
        .expect(404);
      await request(server)
        .patch(`${root}/${randomUUID()}`)
        .set('Authorization', auth())
        .send({})
        .expect(400);
      await request(server)
        .patch(`${root}/${randomUUID()}`)
        .set('Authorization', auth())
        .send(
          root === '/reservations' ? { notes: 'Test' } : { comments: 'Test' },
        )
        .expect(404);
    }
  });

  it('DB garantiza una sola reserva por solicitud bajo concurrencia', async () => {
    const rr = await createRequest({
      reservationAt: future(),
      numberOfPeople: 2,
    });
    // Fixture futura ACCEPTED, no endpoint de aprobación.
    await prisma.reservationRequest.update({
      where: { id: rr.id },
      data: { status: 'ACCEPTED' },
    });
    const outcomes = await Promise.allSettled(
      [1, 2].map((n) =>
        prisma.reservation.create({
          data: {
            code: `FIXTURE-${n}-${rr.id.slice(0, 24)}`,
            customerId,
            reservationRequestId: rr.id,
            reservationAt: new Date(future()),
            numberOfPeople: 2,
          },
        }),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await prisma.reservation.count({
        where: { reservationRequestId: rr.id },
      }),
    ).toBe(1);
  });

  it('restricciones SQL impiden datos inválidos y eliminación del historial', async () => {
    const rr = await createRequest();
    await expect(
      prisma.reservationRequest.update({
        where: { id: rr.id },
        data: { status: 'READY_TO_SEND' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.reservationRequest.update({
        where: { id: rr.id },
        data: { numberOfPeople: 0 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.reservationRequest.update({
        where: { id: rr.id },
        data: { quotedPrice: '-1', currency: 'PEN' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.reservationRequest.update({
        where: { id: rr.id },
        data: { currency: 'PEN' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.customer.delete({ where: { id: customerId } }),
    ).rejects.toThrow();
    await expect(
      prisma.commercialItem.delete({ where: { id: itemId } }),
    ).rejects.toThrow();
  });

  it('sin configuración falla de forma controlada y no crea registros', async () => {
    const config = await prisma.restaurantConfig.findUniqueOrThrow({
      where: { scope: 'GLOBAL' },
    });
    const before = await prisma.reservationRequest.count();
    await prisma.restaurantConfig.delete({ where: { id: config.id } });
    try {
      await request(server)
        .post('/reservation-requests')
        .set('Authorization', auth())
        .send(reqBody())
        .expect(409);
      await request(server)
        .post('/reservations')
        .set('Authorization', auth())
        .send(resBody())
        .expect(409);
      expect(await prisma.reservationRequest.count()).toBe(before);
    } finally {
      await prisma.restaurantConfig.create({ data: config });
    }
  });

  it('PATCH valida relaciones nuevas, conserva omitidos y elimina opcionales', async () => {
    const rr = await createRequest({
      commercialItemId: itemId,
      comments: 'Original',
    });
    const r = await createReservation({
      commercialItemId: itemId,
      notes: 'Original',
    });
    for (const path of [
      `/reservation-requests/${rr.id}`,
      `/reservations/${r.id}`,
    ]) {
      await request(server)
        .patch(path)
        .set('Authorization', auth())
        .send({ customerId: randomUUID() })
        .expect(404);
      await request(server)
        .patch(path)
        .set('Authorization', auth())
        .send({ commercialItemId: randomUUID() })
        .expect(404);
      await request(server)
        .patch(path)
        .set('Authorization', auth())
        .send({ commercialItemId: draftId })
        .expect(400);
      const result = await request(server)
        .patch(path)
        .set('Authorization', auth())
        .send({ commercialItemId: null })
        .expect(200);
      expect((result.body as BookingResponse).commercialItem).toBeNull();
    }
    const detail = await request(server)
      .get(`/reservations/${r.id}`)
      .set('Authorization', auth())
      .expect(200);
    expect((detail.body as BookingResponse).notes).toBe('Original');
    expect(detail.text).not.toMatch(
      /normalizedPhone|normalizedEmail|passwordHash|internalNotes/,
    );
  });

  it('edición concurrente no reactiva una reserva cancelada', async () => {
    const r = await createReservation();
    const results = await Promise.all([
      request(server)
        .patch(`/reservations/${r.id}/status`)
        .set('Authorization', auth())
        .send({ status: 'CANCELLED' }),
      request(server)
        .patch(`/reservations/${r.id}`)
        .set('Authorization', auth())
        .send({ reservationAt: future(15) }),
    ]);
    expect(results[0].status).toBe(200);
    expect([200, 409]).toContain(results[1].status);
    expect(
      (await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } }))
        .status,
    ).toBe('CANCELLED');
  });

  it('restricciones únicas de código y completitud son independientes del servicio', async () => {
    const rr = await createRequest({
      reservationAt: future(),
      numberOfPeople: 2,
    });
    const other = await createRequest();
    await expect(
      prisma.reservationRequest.update({
        where: { id: other.id },
        data: { code: rr.code },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.reservationRequest.update({
        where: { id: rr.id },
        data: { status: 'INCOMPLETE_DATA' },
      }),
    ).rejects.toThrow();
    const r = await createReservation();
    const otherR = await createReservation();
    await expect(
      prisma.reservation.update({
        where: { id: otherR.id },
        data: { code: r.code },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.reservation.update({
        where: { id: r.id },
        data: { numberOfPeople: 0 },
      }),
    ).rejects.toThrow();
  });

  it('solicitud histórica admite notas sin modificar su fecha', async () => {
    const rr = await createRequest({
      reservationAt: future(),
      numberOfPeople: 2,
    });
    const past = new Date(Date.now() - 86400000);
    await prisma.reservationRequest.update({
      where: { id: rr.id },
      data: { reservationAt: past },
    });
    const result = await request(server)
      .patch(`/reservation-requests/${rr.id}`)
      .set('Authorization', auth())
      .send({ comments: 'Nota histórica' })
      .expect(200);
    expect((result.body as BookingResponse).reservationAt).toBe(
      past.toISOString(),
    );
    await request(server)
      .patch(`/reservation-requests/${rr.id}`)
      .set('Authorization', auth())
      .send({ reservationAt: past.toISOString() })
      .expect(400);
  });

  it('APIs existentes y login/refresh/logout siguen operativos', async () => {
    for (const path of [
      '/users',
      '/customers',
      '/commercial-items',
      '/restaurant-config',
      '/auth/me',
    ])
      await request(server).get(path).set('Authorization', auth()).expect(200);
    await request(server).get('/health').expect(200);
    const login = await request(server)
      .post('/auth/login')
      .send({ email: 'admin@test.example', password })
      .expect(201);
    const initial = login.body as Tokens;
    const refresh = await request(server)
      .post('/auth/refresh')
      .send({ refreshToken: initial.refreshToken })
      .expect(201);
    const rotated = refresh.body as Tokens;
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    await request(server)
      .post('/auth/refresh')
      .send({ refreshToken: initial.refreshToken })
      .expect(401);
    await request(server)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${rotated.accessToken}`)
      .expect(201);
    await request(server)
      .get('/reservations')
      .set('Authorization', `Bearer ${rotated.accessToken}`)
      .expect(401);
    await request(server)
      .post('/auth/refresh')
      .send({ refreshToken: rotated.refreshToken })
      .expect(401);
  });
});
