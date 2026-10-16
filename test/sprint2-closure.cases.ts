import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DayOfWeek, RoleCode } from '../generated/prisma/enums';
import { type INestApplication } from '@nestjs/common';
import { CommercialItemsService } from '../src/commercial/commercial-items.service';
import { type PasswordResetMail } from '../src/auth/mail/mail.service';

export const closureMail = {
  messages: [] as PasswordResetMail[],
  sendPasswordResetEmail(mail: PasswordResetMail): Promise<void> {
    closureMail.messages.push(mail);
    return Promise.resolve();
  },
};

interface Context {
  server: () => App;
  auth: (role?: RoleCode) => string;
  app: () => INestApplication;
}

// Registered inside the existing isolated PostgreSQL suite: real JWT and guards.
export function registerSprint2ClosureTests(context: Context): void {
  const id = '11111111-1111-4111-8111-111111111111';
  const readers = [RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR];
  const operators = [RoleCode.ADMIN, RoleCode.OPERATOR];
  const admins = [RoleCode.ADMIN];
  type Route = ['get' | 'post' | 'patch' | 'delete', string, RoleCode[]];
  const routes: Route[] = [];
  for (const resource of [
    'commercial-categories',
    'commercial-items',
    'customers',
    'reservation-requests',
    'reservations',
  ]) {
    const writers = resource.startsWith('commercial-') ? admins : operators;
    routes.push(
      ['get', `/${resource}`, readers],
      ['get', `/${resource}/${id}`, readers],
      ['post', `/${resource}`, resource === 'reservations' ? admins : writers],
      ['patch', `/${resource}/${id}`, writers],
      ['patch', `/${resource}/${id}/status`, writers],
    );
  }
  routes.push(
    ['patch', `/commercial-items/${id}/approval`, admins],
    ['post', `/customers/${id}/interests`, operators],
    ['delete', `/customers/${id}/interests/${id}`, operators],
    ['patch', `/reservations/${id}/assignee`, operators],
    ['post', `/reservations/${id}/notes`, operators],
    ['patch', `/reservations/${id}/reschedule`, operators],
  );

  describe('Cierre Sprint 2: matriz HTTP completa', () => {
    it.each(routes)(
      '%s %s aplica JWT y RBAC',
      async (method, path, allowed) => {
        await request(context.server())[method](path).send({}).expect(401);
        for (const role of Object.values(RoleCode)) {
          const response = await request(context.server())
            [method](path)
            .set('Authorization', context.auth(role))
            .send({});
          if (!allowed.includes(role)) expect(response.status).toBe(403);
          else expect([200, 400, 404]).toContain(response.status);
          // Allowed requests intentionally use missing IDs/empty DTOs: these
          // assertions prove guard admission, not a successful business mutation.
        }
      },
    );
  });

  describe('Cierre Sprint 2: catálogo HTTP', () => {
    let categoryId: string;
    let itemId: string;
    beforeAll(async () => {
      const response = await request(context.server())
        .post('/commercial-categories')
        .set('Authorization', context.auth())
        .send({ nameEs: `Cierre ${randomUUID()}` })
        .expect(201);
      categoryId = (response.body as { id: string }).id;
      const item = await request(context.server())
        .post('/commercial-items')
        .set('Authorization', context.auth())
        .send({
          categoryId,
          type: 'DISH',
          nameEs: 'Plato cierre',
          basePrice: '39.90',
        })
        .expect(201);
      itemId = (item.body as { id: string }).id;
      expect(item.body).toMatchObject({
        basePrice: '39.90',
        approvalStatus: 'DRAFT',
        isActive: true,
      });
    });

    it.each(['DISH', 'BEVERAGE', 'SERVICE', 'PROMOTION', 'EVENT'])(
      'crea %s con relaciones y Decimal',
      async (type) => {
        const response = await request(context.server())
          .post('/commercial-items')
          .set('Authorization', context.auth())
          .send({
            categoryId,
            type,
            nameEs: `Cierre ${type}`,
            variants: [{ nameEs: 'Individual', price: '19.90' }],
            images: [{ url: 'https://example.com/image.jpg', isPrimary: true }],
            faqs: [{ questionEs: '¿Disponible?', answerEs: 'Sí' }],
            schedules: [
              {
                dayOfWeek: 'MONDAY',
                isAvailable: true,
                startTime: '10:00',
                endTime: '22:00',
              },
            ],
            ...(type === 'PROMOTION'
              ? { promotionDetail: { promotionalPrice: '15.50' } }
              : {}),
            ...(type === 'EVENT' ? { eventDetail: { capacity: 20 } } : {}),
          })
          .expect(201);
        expect(response.body).toMatchObject({
          type,
          variants: [{ price: '19.90' }],
          images: [{ isPrimary: true }],
          faqs: [{ answerEs: 'Sí' }],
          schedules: [{ dayOfWeek: 'MONDAY' }],
        });
      },
    );

    it('edita categoría, estados y aprobación; filtra y pagina', async () => {
      await request(context.server())
        .patch(`/commercial-categories/${categoryId}`)
        .set('Authorization', context.auth())
        .send({ descriptionEs: 'Cierre técnico' })
        .expect(200);
      for (const isActive of [false, true]) {
        await request(context.server())
          .patch(`/commercial-categories/${categoryId}/status`)
          .set('Authorization', context.auth())
          .send({ isActive })
          .expect(200);
        await request(context.server())
          .patch(`/commercial-items/${itemId}/status`)
          .set('Authorization', context.auth())
          .send({ isActive })
          .expect(200);
      }
      for (const approvalStatus of ['REJECTED', 'DRAFT', 'APPROVED']) {
        const response = await request(context.server())
          .patch(`/commercial-items/${itemId}/approval`)
          .set('Authorization', context.auth())
          .send({ approvalStatus })
          .expect(200);
        expect(response.body).toMatchObject({ approvalStatus });
      }
      const list = await request(context.server())
        .get('/commercial-items')
        .set('Authorization', context.auth(RoleCode.OWNER))
        .query({
          categoryId,
          type: 'DISH',
          approvalStatus: 'APPROVED',
          isActive: true,
          search: 'Plato cierre',
          limit: 1,
        })
        .expect(200);
      expect(list.body).toMatchObject({
        data: [{ id: itemId }],
        pagination: { total: 1, limit: 1 },
      });
      const updated = await request(context.server())
        .patch(`/commercial-items/${itemId}`)
        .set('Authorization', context.auth())
        .send({ nameEs: 'Plato editado' })
        .expect(200);
      expect(updated.body).toMatchObject({ approvalStatus: 'DRAFT' });
    });

    it.each([
      { categoryId: null },
      { displayOrder: null },
      { schedules: [null] },
    ])('PATCH rechaza entrada inválida %j con 400', async (body) => {
      await request(context.server())
        .patch(`/commercial-items/${itemId}`)
        .set('Authorization', context.auth())
        .send(body)
        .expect(400);
    });
    it('categoría rechaza orden null con 400', async () => {
      await request(context.server())
        .patch(`/commercial-categories/${categoryId}`)
        .set('Authorization', context.auth())
        .send({ displayOrder: null })
        .expect(400);
    });
    it('paginación fuera del rango técnico devuelve 400', async () => {
      await request(context.server())
        .get('/commercial-items')
        .set('Authorization', context.auth())
        .query({ page: '1e30' })
        .expect(400);
    });
    it('categoría inexistente 400 e item inexistente 404', async () => {
      await request(context.server())
        .post('/commercial-items')
        .set('Authorization', context.auth())
        .send({
          categoryId: randomUUID(),
          type: 'SERVICE',
          nameEs: 'No existe',
        })
        .expect(400);
      await request(context.server())
        .get(`/commercial-items/${randomUUID()}`)
        .set('Authorization', context.auth())
        .expect(404);
    });
    it('consulta interna excluye borradores, inactivos y categorías inactivas', async () => {
      const service = context.app().get(CommercialItemsService);
      expect(
        await service.findAvailableForAssistant({ categoryId }),
      ).toHaveLength(0);
      await request(context.server())
        .patch(`/commercial-items/${itemId}/approval`)
        .set('Authorization', context.auth())
        .send({ approvalStatus: 'APPROVED' })
        .expect(200);
      const available = await service.findAvailableForAssistant({ categoryId });
      expect(available.map((item) => item.id)).toEqual([itemId]);
      expect(available[0]).not.toHaveProperty('internalNotes');
      await request(context.server())
        .patch(`/commercial-items/${itemId}/status`)
        .set('Authorization', context.auth())
        .send({ isActive: false })
        .expect(200);
      expect(
        await service.findAvailableForAssistant({ categoryId }),
      ).toHaveLength(0);
      await request(context.server())
        .patch(`/commercial-items/${itemId}/status`)
        .set('Authorization', context.auth())
        .send({ isActive: true })
        .expect(200);
      await request(context.server())
        .patch(`/commercial-categories/${categoryId}/status`)
        .set('Authorization', context.auth())
        .send({ isActive: false })
        .expect(200);
      expect(
        await service.findAvailableForAssistant({ categoryId }),
      ).toHaveLength(0);
    });
  });

  it('Cierre Sprint 2: clientes con JWT real, estados e intereses', async () => {
    const email = `closure-${randomUUID()}@example.com`;
    const result = await request(context.server())
      .post('/customers')
      .set('Authorization', context.auth(RoleCode.OPERATOR))
      .send({
        firstName: 'Cierre',
        phone: '+51 912 345 678',
        email: email.toUpperCase(),
        sourceChannel: 'WHATSAPP',
      })
      .expect(201);
    const customer = result.body as { id: string };
    expect(result.body).toMatchObject({ email, status: 'NEW' });
    expect(result.body).not.toHaveProperty('normalizedEmail');
    expect(result.body).not.toHaveProperty('normalizedPhone');
    await request(context.server())
      .post('/customers')
      .set('Authorization', context.auth())
      .send({ email, sourceChannel: 'PHONE' })
      .expect(409);
    await request(context.server())
      .patch(`/customers/${customer.id}`)
      .set('Authorization', context.auth())
      .send({ firstName: 'Editado' })
      .expect(200);
    for (const status of ['INTERESTED', 'IN_CONVERSATION', 'NEW']) {
      await request(context.server())
        .patch(`/customers/${customer.id}/status`)
        .set('Authorization', context.auth())
        .send({ status })
        .expect(200);
    }
    const category = await request(context.server())
      .post('/commercial-categories')
      .set('Authorization', context.auth())
      .send({ nameEs: `Interés ${randomUUID()}` })
      .expect(201);
    const item = await request(context.server())
      .post('/commercial-items')
      .set('Authorization', context.auth())
      .send({
        categoryId: (category.body as { id: string }).id,
        type: 'SERVICE',
        nameEs: 'Interés',
      })
      .expect(201);
    const commercialItemId = (item.body as { id: string }).id;
    for (let i = 0; i < 2; i++) {
      await request(context.server())
        .post(`/customers/${customer.id}/interests`)
        .set('Authorization', context.auth(RoleCode.OPERATOR))
        .send({ commercialItemId })
        .expect(200);
    }
    const list = await request(context.server())
      .get('/customers')
      .set('Authorization', context.auth(RoleCode.OWNER))
      .query({
        commercialItemId,
        search: email,
        channel: 'WHATSAPP',
        limit: 1,
      })
      .expect(200);
    expect(list.body).toMatchObject({
      data: [{ id: customer.id }],
      pagination: { total: 1 },
    });
    for (const search of ['Editado', '912345678', '+51 912 345 678', email]) {
      const found = await request(context.server())
        .get('/customers')
        .set('Authorization', context.auth(RoleCode.OWNER))
        .query({ search, commercialItemId })
        .expect(200);
      expect(found.body).toMatchObject({
        data: [{ id: customer.id }],
        pagination: { total: 1 },
      });
    }
    await request(context.server())
      .delete(`/customers/${customer.id}/interests/${commercialItemId}`)
      .set('Authorization', context.auth())
      .expect(204);
    await request(context.server())
      .get(`/customers/${customer.id}`)
      .set('Authorization', context.auth())
      .expect(200);
    await request(context.server())
      .get(`/commercial-items/${commercialItemId}`)
      .set('Authorization', context.auth())
      .expect(200);
  });

  it('Cierre Sprint 1: usuarios, revocación y recuperación sin correo externo', async () => {
    const email = `user-${randomUUID()}@example.com`;
    const password = 'ClosurePassword123!';
    const created = await request(context.server())
      .post('/users')
      .set('Authorization', context.auth())
      .send({
        firstName: 'Cierre',
        lastName: 'Test',
        email,
        password,
        roles: ['OPERATOR'],
      })
      .expect(201);
    const userId = (created.body as { id: string }).id;
    expect(created.body).not.toHaveProperty('passwordHash');
    await request(context.server())
      .patch(`/users/${userId}`)
      .set('Authorization', context.auth())
      .send({ firstName: 'Editado' })
      .expect(200);
    const login = async (secret: string) => {
      const result = await request(context.server())
        .post('/auth/login')
        .send({ email, password: secret })
        .expect(201);
      return result.body as { accessToken: string; refreshToken: string };
    };
    const initial = await login(password);
    await request(context.server())
      .patch(`/users/${userId}/status`)
      .set('Authorization', context.auth())
      .send({ isActive: false })
      .expect(200);
    await request(context.server())
      .post('/auth/login')
      .send({ email, password })
      .expect(401);
    await request(context.server())
      .get('/auth/me')
      .set('Authorization', `Bearer ${initial.accessToken}`)
      .expect(401);
    await request(context.server())
      .post('/auth/refresh')
      .send({ refreshToken: initial.refreshToken })
      .expect(401);
    await request(context.server())
      .patch(`/users/${userId}/status`)
      .set('Authorization', context.auth())
      .send({ isActive: true })
      .expect(200);
    const session = await login(password);
    const roles = await request(context.server())
      .patch(`/users/${userId}/roles`)
      .set('Authorization', context.auth())
      .send({ roles: ['OWNER'] })
      .expect(200);
    expect(roles.body).toMatchObject({ roles: ['OWNER'] });
    const known = await request(context.server())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(200);
    const unknown = await request(context.server())
      .post('/auth/forgot-password')
      .send({ email: `unknown-${randomUUID()}@example.com` })
      .expect(200);
    expect(unknown.body).toEqual(known.body);
    const mail = closureMail.messages.find((message) => message.to === email);
    expect(mail).toBeDefined();
    const token = new URL(mail!.resetUrl).searchParams.get('token');
    const newPassword = 'NewClosurePassword123!';
    await request(context.server())
      .post('/auth/reset-password')
      .send({ token, newPassword })
      .expect(200);
    await request(context.server())
      .post('/auth/reset-password')
      .send({ token, newPassword })
      .expect(400);
    await request(context.server())
      .get('/auth/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(401);
    await request(context.server())
      .post('/auth/login')
      .send({ email, password })
      .expect(401);
    await login(newPassword);
  });

  it('Cierre Sprint 1: PUT/GET configuración, idiomas, horarios y responsable', async () => {
    const users = await request(context.server())
      .get('/users')
      .set('Authorization', context.auth())
      .expect(200);
    const owner = (users.body as { id: string; roles: string[] }[]).find(
      (user) => user.roles.includes('OWNER'),
    );
    expect(owner).toBeDefined();
    const body = {
      businessName: 'Restaurante cierre',
      address: 'Lima',
      whatsappNumber: '+51987654321',
      email: 'restaurant@example.com',
      currency: 'PEN',
      timeZone: 'America/Lima',
      reservationPolicy: 'Reserva previa',
      cancellationPolicy: 'Aviso previo',
      responseTimeoutMinutes: 15,
      approvalResponsibleId: owner!.id,
      languages: ['ES', 'EN'],
      schedules: Object.values(DayOfWeek).map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: false,
      })),
    };
    await request(context.server())
      .put('/restaurant-config')
      .set('Authorization', context.auth())
      .send(body)
      .expect(200);
    const result = await request(context.server())
      .get('/restaurant-config')
      .set('Authorization', context.auth(RoleCode.OWNER))
      .expect(200);
    expect(result.body).toMatchObject({
      businessName: body.businessName,
      approvalResponsibleId: owner!.id,
    });
    expect((result.body as { schedules: unknown[] }).schedules).toHaveLength(7);
    expect((result.body as { languages: unknown[] }).languages).toHaveLength(2);
    for (const role of [RoleCode.OWNER, RoleCode.OPERATOR, RoleCode.SUPPORT]) {
      await request(context.server())
        .put('/restaurant-config')
        .set('Authorization', context.auth(role))
        .send(body)
        .expect(403);
    }
  });
}
