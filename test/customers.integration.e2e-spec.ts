import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient } from '../generated/prisma/client';
import {
  CommercialItemType,
  ContactChannel,
  CustomerStatus,
  RoleCode,
} from '../generated/prisma/enums';
import { CustomersModule } from '../src/customers/customers.module';
import { CustomersService } from '../src/customers/customers.service';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { CommonModule } from '../src/common/common.module';
import { AccessTokenGuard } from '../src/auth/guards/access-token.guard';

const integration =
  process.env.CUSTOMERS_INTEGRATION === '1' ? describe : describe.skip;

integration('Clientes: integración aislada en PostgreSQL', () => {
  jest.setTimeout(60000);
  const databaseName = 'crm_customers_test_' + randomUUID().replaceAll('-', '');
  let admin: Client;
  let prisma: PrismaClient;
  let app: INestApplication;
  let server: App;
  let service: CustomersService;
  let commercialItemId: string;
  let databaseCreated = false;
  let sequence = 0;
  const email = () => 'customer-' + ++sequence + '@example.com';
  const contact = () => ({
    email: email(),
    sourceChannel: ContactChannel.EMAIL,
    firstName: 'Juan',
  });

  class TestAuth implements CanActivate {
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string | undefined>;
        user?: { roles: RoleCode[] };
      }>();
      const role = req.headers['x-test-role'];
      if (!role) throw new UnauthorizedException();
      req.user = { roles: [role as RoleCode] };
      return true;
    }
  }

  beforeAll(async () => {
    const connectionString =
      process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString)
      throw new Error('Se requiere DATABASE_URL o TEST_DATABASE_URL');
    admin = new Client({ connectionString });
    await admin.connect();
    // Identificador generado internamente, nunca tomado de input ni del nombre de la BD real.
    if (!/^crm_customers_test_[a-f0-9]{32}$/.test(databaseName))
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
    const fixture = await Test.createTestingModule({
      imports: [DatabaseModule, CommonModule, CustomersModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideGuard(AccessTokenGuard)
      .useClass(TestAuth)
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
    service = fixture.get(CustomersService);
    const category = await prisma.commercialCategory.create({
      data: { nameEs: 'Test', normalizedNameEs: 'test' },
    });
    const item = await prisma.commercialItem.create({
      data: {
        categoryId: category.id,
        type: CommercialItemType.DISH,
        nameEs: 'Test dish',
        normalizedName: 'test dish',
        basePrice: '10.00',
      },
    });
    commercialItemId = item.id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    if (admin) {
      try {
        if (
          databaseCreated &&
          /^crm_customers_test_[a-f0-9]{32}$/.test(databaseName)
        ) {
          await admin.query('DROP DATABASE "' + databaseName + '"');
        }
      } finally {
        await admin.end();
      }
    }
  });

  it.each([RoleCode.ADMIN, RoleCode.OPERATOR])(
    '%s crea un cliente',
    async (role) => {
      await request(server)
        .post('/customers')
        .set('x-test-role', role)
        .send(contact())
        .expect(201);
    },
  );
  it.each([RoleCode.OWNER, RoleCode.SUPPORT])(
    '%s no puede escribir',
    async (role) => {
      const customer = await service.create(contact());
      await request(server)
        .post('/customers')
        .set('x-test-role', role)
        .send(contact())
        .expect(403);
      await request(server)
        .patch('/customers/' + customer.id)
        .set('x-test-role', role)
        .send({ firstName: 'Edit' })
        .expect(403);
      await request(server)
        .patch('/customers/' + customer.id + '/status')
        .set('x-test-role', role)
        .send({ status: 'LOST' })
        .expect(403);
      await request(server)
        .post('/customers/' + customer.id + '/interests')
        .set('x-test-role', role)
        .send({ commercialItemId })
        .expect(403);
      await request(server)
        .delete('/customers/' + customer.id + '/interests/' + commercialItemId)
        .set('x-test-role', role)
        .expect(403);
    },
  );
  it.each([RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR])(
    '%s consulta',
    async (role) => {
      const customer = await service.create(contact());
      await request(server)
        .get('/customers')
        .set('x-test-role', role)
        .expect(200);
      await request(server)
        .get('/customers/' + customer.id)
        .set('x-test-role', role)
        .expect(200);
    },
  );
  it('SUPPORT no consulta; sin token devuelve 401', async () => {
    await request(server)
      .get('/customers')
      .set('x-test-role', 'SUPPORT')
      .expect(403);
    await request(server).get('/customers').expect(401);
    await request(server).post('/customers').send(contact()).expect(401);
  });
  it.each([
    {},
    { phone: '987654321' },
    { email: 'bad' },
    { sourceChannel: 'INVALID', email: 'a@example.com' },
    { email: 'a@example.com', normalizedPhone: '+51987654321' },
  ])('rechaza contacto inválido %j', async (data) => {
    await request(server)
      .post('/customers')
      .set('x-test-role', 'ADMIN')
      .send({ sourceChannel: 'EMAIL', ...data })
      .expect(400);
  });
  it('duplicados de teléfono/email responden 409 sin exponer Prisma', async () => {
    const customer = await service.create({
      phone: '+51987654321',
      email: 'unique@example.com',
      sourceChannel: ContactChannel.WHATSAPP,
    });
    for (const data of [
      { phone: '+51 987 654 321' },
      { phone: '51987654321', phoneCountry: 'PE' },
      { email: ' UNIQUE@EXAMPLE.COM ' },
    ]) {
      const response = await request(server)
        .post('/customers')
        .set('x-test-role', 'ADMIN')
        .send({ sourceChannel: 'EMAIL', ...data })
        .expect(409);
      expect(JSON.stringify(response.body)).not.toMatch(
        /P2002|Prisma|SQL|stack/,
      );
    }
    expect(customer.firstContactAt).toEqual(customer.lastContactAt);
  });
  it('dos creaciones concurrentes producen un solo cliente', async () => {
    const dto = contact();
    const results = await Promise.allSettled([
      service.create(dto),
      service.create(dto),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await prisma.customer.count({ where: { normalizedEmail: dto.email } }),
    ).toBe(1);
  });
  it('findOrCreate concurrente devuelve el mismo cliente', async () => {
    const dto = contact();
    const [a, b] = await Promise.all([
      service.findOrCreateByContact(dto),
      service.findOrCreateByContact(dto),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.firstContactAt).toEqual(b.firstContactAt);
  });
  it('teléfono de A y correo de B produce conflicto y no modifica clientes', async () => {
    const a = await service.create({
      phone: '+51987654322',
      sourceChannel: ContactChannel.PHONE,
    });
    const b = await service.create(contact());
    await expect(
      service.findOrCreateByContact({
        phone: a.phone!,
        email: b.email!,
        sourceChannel: ContactChannel.EMAIL,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.findOne(a.id)).lastContactAt).toEqual(
      a.lastContactAt,
    );
  });
  it('PATCH valida el contacto final y renormaliza', async () => {
    const a = await service.create(contact());
    await expect(service.update(a.id, { email: null })).rejects.toMatchObject({
      status: 400,
    });
    const updated = await service.update(a.id, {
      email: ' CHANGED@EXAMPLE.COM ',
      firstName: ' Ana ',
    });
    expect(updated.email).toBe('changed@example.com');
    expect(updated.firstName).toBe('Ana');
    expect(updated.firstContactAt).toEqual(a.firstContactAt);
    expect(updated.lastContactAt).toEqual(a.lastContactAt);
    const b = await service.create(contact());
    await expect(
      service.update(b.id, { email: 'changed@example.com' }),
    ).rejects.toMatchObject({ status: 409 });
    await service.update(a.id, {
      phone: '987654323',
      phoneCountry: 'PE',
      email: null,
    });
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: a.id } }))
        .normalizedPhone,
    ).toBe('+51987654323');
  });
  it('PATCH concurrentes no pueden retirar entre ambos el último contacto', async () => {
    const a = await service.create({ ...contact(), phone: '+51987654324' });
    const result = await Promise.allSettled([
      service.update(a.id, { phone: null }),
      service.update(a.id, { email: null }),
    ]);
    expect(result.filter((entry) => entry.status === 'fulfilled')).toHaveLength(
      1,
    );
    const saved = await prisma.customer.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(Boolean(saved.normalizedPhone || saved.normalizedEmail)).toBe(true);
  });
  it('intereses repetidos/concurrentes no duplican y conservan fecha inicial', async () => {
    const a = await service.create(contact());
    const interest = await service.addInterest(a.id, {
      commercialItemId,
      notes: 'Consulta inicial',
    });
    const repeated = await Promise.all([
      service.addInterest(a.id, { commercialItemId }),
      service.addInterest(a.id, { commercialItemId }),
    ]);
    expect(
      repeated.every(
        (row) =>
          row.id === interest.id &&
          row.firstInterestedAt.getTime() ===
            interest.firstInterestedAt.getTime(),
      ),
    ).toBe(true);
    expect(
      await prisma.customerInterest.count({ where: { customerId: a.id } }),
    ).toBe(1);
    expect(repeated[0].notes).toBe('Consulta inicial');
    await prisma.commercialItem.update({
      where: { id: commercialItemId },
      data: { isActive: false },
    });
    const detail = await service.findOne(a.id);
    expect(detail.interests).toHaveLength(1);
    expect(detail.interests[0].commercialItem.isActive).toBe(false);
    expect(JSON.stringify(detail)).not.toMatch(
      /normalizedPhone|normalizedEmail|passwordHash|internalNotes/,
    );
    await request(server)
      .delete('/customers/' + a.id + '/interests/' + commercialItemId)
      .set('x-test-role', 'OPERATOR')
      .expect(204);
    await expect(
      service.removeInterest(a.id, commercialItemId),
    ).rejects.toMatchObject({ status: 404 });
    expect(await prisma.customer.count({ where: { id: a.id } })).toBe(1);
    expect(
      await prisma.commercialItem.count({ where: { id: commercialItemId } }),
    ).toBe(1);
  });
  it('intereses inexistentes y clientes inexistentes producen 404', async () => {
    const a = await service.create(contact());
    await expect(
      service.addInterest(a.id, { commercialItemId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.addInterest(randomUUID(), { commercialItemId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.findOne(randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.updateStatus(randomUUID(), { status: CustomerStatus.LOST }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('touch conserva firstContactAt y lastContactAt nunca retrocede', async () => {
    const a = await service.create(contact());
    const old = new Date('2020-01-01');
    const touched = await service.touchLastContact(a.id);
    const stale = await service.touchLastContact(a.id, old);
    expect(stale.firstContactAt).toEqual(a.firstContactAt);
    expect(stale.lastContactAt).toEqual(touched.lastContactAt);
    await expect(
      service.touchLastContact(a.id, new Date('2099-01-01')),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('filtros combinados, búsqueda y paginación', async () => {
    const a = await service.create({
      ...contact(),
      firstName: 'Buscable',
      lastName: 'Especial',
    });
    await service.updateStatus(a.id, { status: CustomerStatus.INTERESTED });
    await service.addInterest(a.id, { commercialItemId });
    const response = await request(server)
      .get('/customers')
      .query({
        search: 'buscable',
        status: 'INTERESTED',
        channel: 'EMAIL',
        commercialItemId,
        page: 1,
        limit: 1,
      })
      .set('x-test-role', 'ADMIN')
      .expect(200);
    const body = response.body as {
      data: { id: string }[];
      pagination: { total: number };
    };
    expect(body.data[0].id).toBe(a.id);
    expect(body.pagination.total).toBe(1);
    for (const search of [a.email!, 'Especial']) {
      const result = await request(server)
        .get('/customers')
        .query({ search })
        .set('x-test-role', 'OWNER')
        .expect(200);
      expect(
        (result.body as { data: { id: string }[] }).data.some(
          (row) => row.id === a.id,
        ),
      ).toBe(true);
    }
    await request(server)
      .get('/customers')
      .query({ search: '+51 987 654 321' })
      .set('x-test-role', 'ADMIN')
      .expect(200);
  });
  it('estado HTTP OPERATOR permitido; entrada inválida 400', async () => {
    const a = await service.create(contact());
    await request(server)
      .patch('/customers/' + a.id + '/status')
      .set('x-test-role', 'OPERATOR')
      .send({ status: 'LOST' })
      .expect(200);
    await request(server)
      .patch('/customers/' + a.id + '/status')
      .set('x-test-role', 'ADMIN')
      .send({ status: 'BAD' })
      .expect(400);
    await request(server)
      .patch('/customers/' + a.id)
      .set('x-test-role', 'ADMIN')
      .send({})
      .expect(400);
    await request(server)
      .get('/customers/UUID')
      .set('x-test-role', 'ADMIN')
      .expect(400);
  });
  it('la BD rechaza clientes sin contacto y fechas incoherentes', async () => {
    await expect(
      prisma.customer.create({ data: { sourceChannel: ContactChannel.OTHER } }),
    ).rejects.toBeDefined();
    await expect(
      prisma.customer.create({
        data: {
          email: email(),
          normalizedEmail: 'mismatch@example.com',
          sourceChannel: ContactChannel.EMAIL,
        },
      }),
    ).rejects.toBeDefined();
    const address = email();
    await expect(
      prisma.customer.create({
        data: {
          email: address,
          normalizedEmail: address,
          sourceChannel: ContactChannel.EMAIL,
          firstContactAt: new Date('2026-01-02'),
          lastContactAt: new Date('2026-01-01'),
        },
      }),
    ).rejects.toBeDefined();
  });
});
