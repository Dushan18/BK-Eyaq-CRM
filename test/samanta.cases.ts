import { randomInt, randomUUID } from 'node:crypto';
import { ConflictException, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { PrismaClient, SamantaDraft } from '../generated/prisma/client';
import { RoleCode } from '../generated/prisma/enums';
import { SamantaConfig } from '../src/samanta/samanta.config';
import {
  type DraftOutput,
  SamantaProviderError,
} from '../src/samanta/samanta.provider';
import { MessagesService } from '../src/messaging/messages.service';
import { OutboundMessagesService } from '../src/messaging/outbound-messages.service';

const output: DraftOutput = {
  content: '¿Para qué fecha deseas reservar?',
  intent: 'RESERVATION',
  requiresHuman: true,
  missingFields: ['fecha', 'hora', 'personas'],
  inputTokens: 100,
  outputTokens: 20,
};
export const samantaTestConfig = new SamantaConfig(
  new ConfigService({
    SAMANTA_ENABLED: 'true',
    OPENAI_API_KEY: 'fake-never-used',
  }),
);
export const samantaTestProvider = {
  generate: jest.fn((context: string): Promise<DraftOutput> => {
    void context;
    return Promise.resolve(output);
  }),
};
interface Context {
  app: () => INestApplication;
  prisma: () => PrismaClient;
  server: () => App;
  auth: (role?: RoleCode) => string;
}
export function registerSamantaTests(c: Context) {
  describe('Samanta v1: IA simulada, PostgreSQL y JWT reales, sin envíos', () => {
    const db = () => c.prisma();
    const incoming = async (phone = `+519${randomInt(10000000, 99999999)}`) => {
      const result = await c
        .app()
        .get(MessagesService)
        .ingestInboundMessage({
          channel: 'WHATSAPP',
          externalMessageId: `wamid.${randomUUID()}`,
          providerAccountId: '123',
          contact: { phone },
          type: 'TEXT',
          content: 'Quiero reservar',
          occurredAt: new Date().toISOString(),
        });
      return {
        sourceMessageId: result.message.id,
        conversationId: result.message.conversationId,
        phone,
      };
    };
    type Incoming = Awaited<ReturnType<typeof incoming>>;
    const base = (row: Incoming) =>
      `/conversations/${row.conversationId}/assistant-drafts`;
    const generate = (
      row: Incoming,
      key = randomUUID(),
      role = RoleCode.ADMIN,
    ) =>
      request(c.server())
        .post(base(row))
        .set('Authorization', c.auth(role))
        .set('Idempotency-Key', key)
        .send({ sourceMessageId: row.sourceMessageId });
    const ready = async (row: Incoming) =>
      (await generate(row).expect(201)).body as SamantaDraft;
    const approve = (
      row: Incoming,
      draft: SamantaDraft,
      revision = draft.revision,
    ) =>
      request(c.server())
        .post(`${base(row)}/${draft.id}/approve`)
        .set('Authorization', c.auth())
        .send({ revision });
    beforeEach(() =>
      samantaTestProvider.generate.mockReset().mockResolvedValue(output),
    );
    afterEach(() => jest.restoreAllMocks());

    it('genera un borrador sin crear salida ni reserva y reutiliza la clave', async () => {
      const row = await incoming();
      const key = randomUUID();
      const reservationCount = await db().reservation.count();
      const first = (await generate(row, key).expect(201)).body as SamantaDraft;
      const second = (await generate(row, key).expect(201))
        .body as SamantaDraft;
      expect(first).toMatchObject({
        status: 'READY',
        content: output.content,
        inputTokens: 100,
        revision: 1,
      });
      expect(second.id).toBe(first.id);
      expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
      expect(
        await db().message.count({
          where: { conversationId: row.conversationId, direction: 'OUTBOUND' },
        }),
      ).toBe(0);
      expect(await db().reservation.count()).toBe(reservationCount);
      const context = samantaTestProvider.generate.mock.calls[0][0];
      expect(context).not.toContain(row.phone);
      expect(context).not.toContain(row.conversationId);
      expect(context).not.toContain('internalNotes');
      expect(context).toContain('Quiero reservar');
    });
    it('edición con revisión optimista y aprobación concurrente produce una sola salida', async () => {
      const row = await incoming();
      const draft = await ready(row);
      const edited = (
        await request(c.server())
          .patch(`${base(row)}/${draft.id}`)
          .set('Authorization', c.auth())
          .send({ revision: 1, content: 'Hola, ¿para cuántas personas?' })
          .expect(200)
      ).body as SamantaDraft;
      expect(edited).toMatchObject({
        revision: 2,
        originalContent: output.content,
      });
      await approve(row, edited, 1).expect(409);
      const results = await Promise.all([
        approve(row, edited).expect(202),
        approve(row, edited).expect(202),
      ]);
      expect((results[0].body as SamantaDraft).outboundMessageId).toBe(
        (results[1].body as SamantaDraft).outboundMessageId,
      );
      const messages = await db().message.findMany({
        where: { conversationId: row.conversationId, direction: 'OUTBOUND' },
        include: { outbox: true },
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        status: 'QUEUED',
        content: edited.content,
        outbox: { status: 'PENDING' },
      });
    });
    it('rechazar es terminal y no envía', async () => {
      const row = await incoming();
      const draft = await ready(row);
      await request(c.server())
        .post(`${base(row)}/${draft.id}/reject`)
        .set('Authorization', c.auth())
        .send({ revision: 1 })
        .expect(200);
      await approve(row, draft).expect(409);
      expect(
        await db().message.count({
          where: { conversationId: row.conversationId, direction: 'OUTBOUND' },
        }),
      ).toBe(0);
    });
    it('un mensaje nuevo impide aprobar y persiste STALE', async () => {
      const row = await incoming();
      const draft = await ready(row);
      await incoming(row.phone);
      await approve(row, draft).expect(409);
      expect(
        await db().samantaDraft.findUnique({ where: { id: draft.id } }),
      ).toMatchObject({ status: 'STALE' });
    });
    it('un mensaje entrante durante generación invalida el resultado', async () => {
      const row = await incoming();
      samantaTestProvider.generate.mockImplementationOnce(async () => {
        await incoming(row.phone);
        return output;
      });
      expect((await generate(row).expect(201)).body).toMatchObject({
        status: 'STALE',
      });
    });
    it('pausa bloquea generar y aprobar', async () => {
      const row = await incoming();
      const draft = await ready(row);
      await db().conversation.update({
        where: { id: row.conversationId },
        data: { isAssistantPaused: true },
      });
      await generate(row).expect(409);
      await approve(row, draft).expect(409);
      expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
    });
    it('catálogo/políticas cambiadas invalidan la revisión', async () => {
      const row = await incoming();
      const draft = await ready(row);
      const restaurant = await db().restaurantConfig.findUniqueOrThrow({
        where: { scope: 'GLOBAL' },
      });
      try {
        await db().restaurantConfig.update({
          where: { id: restaurant.id },
          data: { reservationPolicy: 'Política nueva para la prueba' },
        });
        await approve(row, draft).expect(409);
        expect(
          await db().samantaDraft.findUnique({ where: { id: draft.id } }),
        ).toMatchObject({ status: 'STALE' });
      } finally {
        await db().restaurantConfig.update({
          where: { id: restaurant.id },
          data: { reservationPolicy: restaurant.reservationPolicy },
        });
      }
    });
    it('errores de IA se guardan sin secretos ni reintentos al repetir clave', async () => {
      const row = await incoming();
      const key = randomUUID();
      samantaTestProvider.generate.mockRejectedValueOnce(
        new SamantaProviderError('AI_TIMEOUT'),
      );
      expect((await generate(row, key).expect(201)).body).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_TIMEOUT',
      });
      await generate(row, key).expect(201);
      expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
    });
    it('trabajo abandonado expira sin recostear', async () => {
      const row = await incoming();
      const key = randomUUID();
      const draft = (await generate(row, key).expect(201)).body as SamantaDraft;
      await db().samantaDraft.update({
        where: { id: draft.id },
        data: { status: 'GENERATING', generationExpiresAt: new Date(0) },
      });
      expect((await generate(row, key).expect(201)).body).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_GENERATION_EXPIRED',
      });
      expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
    });
    it('borrador vencido no se puede enviar', async () => {
      const row = await incoming();
      const draft = await ready(row);
      await db().samantaDraft.update({
        where: { id: draft.id },
        data: { expiresAt: new Date(0) },
      });
      await approve(row, draft).expect(409);
    });
    it('respeta la ventana WhatsApp y no aprueba si el encolado falla', async () => {
      const row = await incoming();
      await db().message.update({
        where: { id: row.sourceMessageId },
        data: { occurredAt: new Date(Date.now() - 25 * 3600000) },
      });
      const draft = await ready(row);
      await approve(row, draft).expect(409);
      expect(
        await db().samantaDraft.findUnique({ where: { id: draft.id } }),
      ).toMatchObject({ status: 'READY', outboundMessageId: null });
    });
    it('revierte mensaje/outbox si falla la operación de aprobación', async () => {
      const row = await incoming();
      const draft = await ready(row);
      const outbound = c.app().get(OutboundMessagesService);
      const original = outbound.queueOutboundMessage.bind(
        outbound,
      ) as OutboundMessagesService['queueOutboundMessage'];
      jest
        .spyOn(outbound, 'queueOutboundMessage')
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          throw new ConflictException();
        });
      await approve(row, draft).expect(409);
      expect(
        await db().message.count({
          where: { conversationId: row.conversationId, direction: 'OUTBOUND' },
        }),
      ).toBe(0);
      expect(
        await db().samantaDraft.findUnique({ where: { id: draft.id } }),
      ).toMatchObject({ status: 'READY' });
    });
    it('autenticación, roles, aislamiento y validación de DTO', async () => {
      const row = await incoming();
      const other = await incoming();
      await request(c.server())
        .post(base(row))
        .send({ sourceMessageId: row.sourceMessageId })
        .expect(401);
      await generate(row, randomUUID(), RoleCode.OWNER).expect(403);
      await request(c.server())
        .post(base(row))
        .set('Authorization', c.auth())
        .send({ sourceMessageId: 'invalid', model: 'override' })
        .expect(400);
      const draft = await ready(row);
      await request(c.server())
        .get(`${base(other)}/${draft.id}`)
        .set('Authorization', c.auth())
        .expect(404);
      await request(c.server())
        .get(`${base(row)}/${draft.id}`)
        .set('Authorization', c.auth(RoleCode.OWNER))
        .expect(200);
    });
    it('respeta asignación a otro operador', async () => {
      const row = await incoming();
      const admin = await db().user.findUniqueOrThrow({
        where: { email: 'admin@test.example' },
      });
      await db().conversation.update({
        where: { id: row.conversationId },
        data: { assignedUserId: admin.id },
      });
      await generate(row, randomUUID(), RoleCode.OPERATOR).expect(403);
      expect(samantaTestProvider.generate).not.toHaveBeenCalled();
    });
    it('no supera el límite diario ante generación concurrente en conversaciones distintas', async () => {
      const rows = await Promise.all([incoming(), incoming()]);
      const now = new Date();
      const start = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const count = await db().samantaDraft.count({
        where: { createdAt: { gte: start } },
      });
      jest.replaceProperty(samantaTestConfig, 'dailyLimit', count + 1);
      const results = await Promise.all(rows.map((row) => generate(row)));
      expect(results.map((result) => result.status).sort()).toEqual([201, 429]);
      expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
    });
    it('una llamada en curso se reutiliza por clave y limita otras generaciones', async () => {
      const row = await incoming();
      const other = await incoming();
      const key = randomUUID();
      let release!: (value: DraftOutput) => void;
      let started!: () => void;
      const called = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<DraftOutput>((resolve) => {
        release = resolve;
      });
      samantaTestProvider.generate.mockImplementationOnce(() => {
        started();
        return gate;
      });
      jest.replaceProperty(samantaTestConfig, 'concurrentLimit', 1);
      const first = generate(row, key).then((result) => result);
      await called;
      try {
        expect((await generate(row, key).expect(201)).body).toMatchObject({
          status: 'GENERATING',
        });
        await generate(other).expect(429);
        expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
      } finally {
        release(output);
        await first;
      }
    });
    it('solo incluye catálogo aprobado/activo y no notas internas', async () => {
      const row = await incoming();
      const category = await db().commercialCategory.create({
        data: { nameEs: 'Samanta catálogo', normalizedNameEs: randomUUID() },
      });
      const items = [
        {
          nameEs: 'VISIBLE_SAMANTA',
          approvalStatus: 'APPROVED' as const,
          isActive: true,
        },
        {
          nameEs: 'DRAFT_SAMANTA_SECRET',
          approvalStatus: 'DRAFT' as const,
          isActive: true,
        },
        {
          nameEs: 'INACTIVE_SAMANTA_SECRET',
          approvalStatus: 'APPROVED' as const,
          isActive: false,
        },
      ];
      for (const item of items)
        await db().commercialItem.create({
          data: {
            ...item,
            type: 'DISH',
            normalizedName: randomUUID(),
            categoryId: category.id,
            id:
              item.nameEs === 'VISIBLE_SAMANTA'
                ? '00000000-0000-4000-8000-000000000001'
                : randomUUID(),
            displayOrder: 0,
            internalNotes: 'DO_NOT_DISCLOSE_INTERNAL_NOTES',
          },
        });
      try {
        await ready(row);
        const context = samantaTestProvider.generate.mock.calls[0][0];
        expect(context).toContain('VISIBLE_SAMANTA');
        expect(context).not.toContain('DRAFT_SAMANTA_SECRET');
        expect(context).not.toContain('INACTIVE_SAMANTA_SECRET');
        expect(context).not.toContain('DO_NOT_DISCLOSE_INTERNAL_NOTES');
      } finally {
        await db().commercialItem.deleteMany({
          where: { categoryId: category.id },
        });
        await db().commercialCategory.delete({ where: { id: category.id } });
      }
    });
    it('interruptor desactivado bloquea generación y aprobación sin llamar a IA', async () => {
      const row = await incoming();
      const draft = await ready(row);
      samantaTestProvider.generate.mockClear();
      jest.replaceProperty(samantaTestConfig, 'enabled', false);
      await generate(row).expect(503);
      await approve(row, draft).expect(503);
      expect(samantaTestProvider.generate).not.toHaveBeenCalled();
    });
  });
}
