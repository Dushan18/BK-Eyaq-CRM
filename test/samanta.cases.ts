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
  type GenerationMode,
  type ReservationAction,
  SamantaProviderError,
} from '../src/samanta/samanta.provider';
import { SamantaAutoService } from '../src/samanta/samanta-auto.service';
import {
  replies,
  SamantaReservationService,
} from '../src/samanta/samanta-reservations';
import { MessagingTransactionService } from '../src/messaging/messaging-transaction.service';
import { zonedTimeToUtc } from '../src/common/zoned-time';
import { MessagesService } from '../src/messaging/messages.service';
import { MessageProcessorService } from '../src/messaging/message-processor.service';
import { OutboundMessagesService } from '../src/messaging/outbound-messages.service';
import { SAMANTA_USER_ID } from '../src/common/constants/system-users.constants';

const output: DraftOutput = {
  content: '¿Para qué fecha deseas reservar?',
  intent: 'RESERVATION',
  requiresHuman: true,
  missingFields: ['fecha', 'hora', 'personas'],
  inputTokens: 100,
  outputTokens: 20,
};
// ConfigService gives process.env priority over the values passed here, and the
// integration suite loads the developer's .env: read only these values.
const samantaTestEnv: Record<string, string> = {
  SAMANTA_ENABLED: 'true',
  OPENAI_API_KEY: 'fake-never-used',
};
export const samantaTestConfig = new SamantaConfig({
  get: (key: string) => samantaTestEnv[key],
} as unknown as ConfigService);
export const samantaTestProvider = {
  generate: jest.fn(
    (context: string, mode?: GenerationMode): Promise<DraftOutput> => {
      void context;
      void mode;
      return Promise.resolve(output);
    },
  ),
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
    it('con la ventana WhatsApp cerrada no genera ni gasta OpenAI', async () => {
      const row = await incoming();
      await db().message.update({
        where: { id: row.sourceMessageId },
        data: { occurredAt: new Date(Date.now() - 25 * 3600000) },
      });
      const res = await generate(row).expect(409);
      expect((res.body as { message: string }).message).toMatch(/ventana/i);
      expect(samantaTestProvider.generate).not.toHaveBeenCalled();
      expect(
        await db().samantaDraft.count({
          where: { conversationId: row.conversationId },
        }),
      ).toBe(0);
    });
    it('no aprueba si la ventana se cerró después de generar', async () => {
      const row = await incoming();
      const draft = await ready(row);
      await db().message.update({
        where: { id: row.sourceMessageId },
        data: { occurredAt: new Date(Date.now() - 25 * 3600000) },
      });
      await approve(row, draft).expect(409);
      expect(
        await db().samantaDraft.findUnique({ where: { id: draft.id } }),
      ).toMatchObject({ status: 'READY', outboundMessageId: null });
    });
    it('un sticker o reacción no invalida el borrador ni impide generar', async () => {
      const row = await incoming();
      const draft = await ready(row);
      await c
        .app()
        .get(MessagesService)
        .ingestInboundMessage({
          channel: 'WHATSAPP',
          externalMessageId: `wamid.${randomUUID()}`,
          providerAccountId: '123',
          contact: { phone: row.phone },
          type: 'OTHER',
          content: '[Mensaje de WhatsApp no compatible todavía]',
          occurredAt: new Date().toISOString(),
        });
      await generate(row).expect(201);
      expect((await approve(row, draft).expect(202)).body).toMatchObject({
        status: 'APPROVED',
      });
    });
    it('consultar la lista no libera la plaza de una generación en curso', async () => {
      const row = await incoming();
      const other = await incoming();
      let release!: (value: DraftOutput) => void;
      let started!: () => void;
      const called = new Promise<void>((resolve) => {
        started = resolve;
      });
      samantaTestProvider.generate.mockImplementationOnce(() => {
        started();
        return new Promise<DraftOutput>((resolve) => {
          release = resolve;
        });
      });
      jest.replaceProperty(samantaTestConfig, 'concurrentLimit', 1);
      const first = generate(row).then((result) => result);
      await called;
      try {
        await incoming(row.phone);
        const list = await request(c.server())
          .get(base(row))
          .set('Authorization', c.auth(RoleCode.OWNER))
          .expect(200);
        expect((list.body as { data: SamantaDraft[] }).data[0].status).toBe(
          'GENERATING',
        );
        await generate(other).expect(429);
      } finally {
        release(output);
      }
      expect(((await first).body as SamantaDraft).status).toBe('STALE');
      expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
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
        where: { generationStartedAt: { gte: start } },
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
    it('el usuario de sistema de Samanta no aparece ni puede iniciar sesión', async () => {
      const users = await request(c.server())
        .get('/users')
        .set('Authorization', c.auth())
        .expect(200);
      expect(
        (users.body as { id: string }[]).some(
          (user) => user.id === SAMANTA_USER_ID,
        ),
      ).toBe(false);
      await request(c.server())
        .patch(`/users/${SAMANTA_USER_ID}/status`)
        .set('Authorization', c.auth())
        .send({ isActive: true })
        .expect(404);
      await request(c.server())
        .post('/auth/login')
        .send({
          email: 'samanta@sistema.invalid',
          password: 'CualquierClave123!',
        })
        .expect(401);
    });
    it('la pausa manual guarda su motivo', async () => {
      const row = await incoming();
      const path = `/conversations/${row.conversationId}/assistant`;
      expect(
        (
          await request(c.server())
            .patch(path)
            .set('Authorization', c.auth())
            .send({ paused: true })
            .expect(200)
        ).body,
      ).toMatchObject({
        isAssistantPaused: true,
        assistantPauseReason: 'MANUAL',
      });
      expect(
        (
          await request(c.server())
            .patch(path)
            .set('Authorization', c.auth())
            .send({ paused: false })
            .expect(200)
        ).body,
      ).toMatchObject({
        isAssistantPaused: false,
        assistantPauseReason: null,
        assistantPausedAt: null,
      });
    });

    describe('modo automático', () => {
      const reply: DraftOutput = {
        ...output,
        content: 'Abrimos de martes a domingo desde las 12:00.',
        intent: 'GENERAL',
        requiresHuman: false,
        missingFields: [],
      };
      const auto = () => c.app().get(SamantaAutoService);
      const say = async (
        phone = `+519${randomInt(10000000, 99999999)}`,
        content = '¿A qué hora abren?',
        extra: { type?: 'TEXT' | 'OTHER'; occurredAt?: string } = {},
      ) => {
        const result = await c
          .app()
          .get(MessagesService)
          .ingestInboundMessage({
            channel: 'WHATSAPP',
            externalMessageId: `wamid.${randomUUID()}`,
            providerAccountId: '123',
            contact: { phone },
            type: extra.type ?? 'TEXT',
            content,
            occurredAt: extra.occurredAt ?? new Date().toISOString(),
          });
        await expect(
          c.app().get(MessageProcessorService).process(result.message.id),
        ).resolves.toBe('processed');
        return {
          messageId: result.message.id,
          conversationId: result.message.conversationId,
          phone,
        };
      };
      type Said = Awaited<ReturnType<typeof say>>;
      const drafts = (row: Said) =>
        db().samantaDraft.findMany({
          where: { conversationId: row.conversationId, mode: 'AUTO' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
      // Skips the wait that groups consecutive customer messages.
      const due = async (row: Said) => {
        await db().samantaDraft.updateMany({
          where: { conversationId: row.conversationId, status: 'SCHEDULED' },
          data: { availableAt: new Date(0) },
        });
        await auto().runOnce();
      };
      const sent = (row: Said) =>
        db().message.findMany({
          where: { conversationId: row.conversationId, direction: 'OUTBOUND' },
        });
      const conversation = (row: Said) =>
        db().conversation.findUniqueOrThrow({
          where: { id: row.conversationId },
        });
      beforeEach(() => {
        jest.replaceProperty(samantaTestConfig, 'autoEnabled', true);
        jest.replaceProperty(samantaTestConfig, 'autoSend', true);
        samantaTestProvider.generate.mockResolvedValue(reply);
      });
      afterEach(async () => {
        // A reply left scheduled must not leak into the next test.
        await db().samantaDraft.updateMany({
          where: { status: 'SCHEDULED' },
          data: { status: 'STALE' },
        });
      });

      it('responde sola al último texto, firmada por Samanta, y nunca dos veces', async () => {
        const row = await say();
        const [scheduled] = await drafts(row);
        expect(scheduled).toMatchObject({
          mode: 'AUTO',
          status: 'SCHEDULED',
          sourceMessageId: row.messageId,
          createdById: SAMANTA_USER_ID,
          generationStartedAt: null,
        });
        expect(scheduled.availableAt!.getTime()).toBeGreaterThan(Date.now());
        await auto().runOnce();
        expect(samantaTestProvider.generate).not.toHaveBeenCalled();
        await due(row);
        expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
        const [context, mode] = samantaTestProvider.generate.mock.calls[0];
        expect(mode).toBe('auto');
        const parsed = JSON.parse(context) as {
          now: { local: string; weekday: string; timeZone: string };
          reply: { channel: string; maxCharacters: number };
          history: { content: string; at: string }[];
        };
        expect(parsed.now).toMatchObject({ timeZone: 'America/Lima' });
        expect(parsed.now.local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
        expect(parsed.reply).toEqual({
          channel: 'WHATSAPP',
          maxCharacters: 4096,
        });
        expect(parsed.history.at(-1)).toMatchObject({
          content: '¿A qué hora abren?',
        });
        expect(context).not.toContain(row.phone);
        const [answered] = await drafts(row);
        expect(answered).toMatchObject({
          status: 'APPROVED',
          reviewedById: SAMANTA_USER_ID,
          content: reply.content,
          inputTokens: 100,
        });
        const messages = await sent(row);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          id: answered.outboundMessageId,
          status: 'QUEUED',
          authorUserId: SAMANTA_USER_ID,
          content: reply.content,
        });
        await auto().runOnce();
        await expect(
          c.app().get(MessageProcessorService).process(row.messageId),
        ).resolves.toBe('terminal');
        expect(await sent(row)).toHaveLength(1);
        expect(await drafts(row)).toHaveLength(1);
        expect(await conversation(row)).toMatchObject({
          isAssistantPaused: false,
        });
      });
      it('agrupa mensajes seguidos en una sola respuesta', async () => {
        const row = await say(undefined, 'Hola');
        const second = await say(row.phone, 'Somos 4 para el sábado');
        const [first, last] = await drafts(row);
        expect(first.status).toBe('STALE');
        expect(last).toMatchObject({
          status: 'SCHEDULED',
          sourceMessageId: second.messageId,
        });
        await due(row);
        expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
        const [context] = samantaTestProvider.generate.mock.calls[0];
        expect(context).toContain('Hola');
        expect(context).toContain('Somos 4 para el sábado');
        expect(await sent(row)).toHaveLength(1);
      });
      it('transfiere a una persona cuando el caso lo requiere', async () => {
        samantaTestProvider.generate.mockResolvedValueOnce({
          ...reply,
          content: 'Te comunico con una persona del equipo.',
          intent: 'HUMAN',
          requiresHuman: true,
        });
        const row = await say(undefined, 'Quiero hablar con alguien');
        await due(row);
        expect(await sent(row)).toHaveLength(1);
        expect(await conversation(row)).toMatchObject({
          isAssistantPaused: true,
          assistantPauseReason: 'SAMANTA_HANDOFF',
        });
        await say(row.phone, '¿Hola?');
        expect(await drafts(row)).toHaveLength(1);
      });
      it('un operador que escribe pausa a Samanta y descarta la respuesta pendiente', async () => {
        const row = await say();
        await request(c.server())
          .post(`/conversations/${row.conversationId}/messages`)
          .set('Authorization', c.auth(RoleCode.OPERATOR))
          .set('Idempotency-Key', randomUUID())
          .send({ type: 'TEXT', content: 'Hola, te atiende Ana.' })
          .expect(202);
        expect(await conversation(row)).toMatchObject({
          isAssistantPaused: true,
          assistantPauseReason: 'OPERATOR_REPLIED',
        });
        await due(row);
        expect(samantaTestProvider.generate).not.toHaveBeenCalled();
        expect((await drafts(row))[0].status).toBe('STALE');
      });
      it('al devolverle la conversación, responde el mensaje que llegó durante la pausa', async () => {
        const row = await say();
        const path = `/conversations/${row.conversationId}/assistant`;
        await request(c.server())
          .patch(path)
          .set('Authorization', c.auth())
          .send({ paused: true })
          .expect(200);
        const waiting = await say(row.phone, 'Reserva para 4 personas');
        expect(
          (await drafts(row)).filter(
            (draft) => draft.sourceMessageId === waiting.messageId,
          ),
        ).toHaveLength(0);
        await request(c.server())
          .patch(path)
          .set('Authorization', c.auth())
          .send({ paused: false })
          .expect(200);
        expect(
          (await drafts(row)).filter((draft) => draft.status === 'SCHEDULED'),
        ).toMatchObject([{ sourceMessageId: waiting.messageId, mode: 'AUTO' }]);
        await due(row);
        expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
        expect((await sent(row)).map((message) => message.content)).toEqual([
          reply.content,
        ]);
      });
      it('al devolverle una conversación ya respondida por una persona, no escribe', async () => {
        const row = await say();
        await request(c.server())
          .post(`/conversations/${row.conversationId}/messages`)
          .set('Authorization', c.auth(RoleCode.OPERATOR))
          .set('Idempotency-Key', randomUUID())
          .send({ type: 'TEXT', content: 'Hola, te atiende Ana.' })
          .expect(202);
        await request(c.server())
          .patch(`/conversations/${row.conversationId}/assistant`)
          .set('Authorization', c.auth())
          .send({ paused: false })
          .expect(200);
        // Resuming schedules nothing new: the pending reply was answered by a person.
        expect(
          (await drafts(row)).filter((draft) =>
            draft.idempotencyKey.includes('-r'),
          ),
        ).toHaveLength(0);
        await due(row);
        expect(samantaTestProvider.generate).not.toHaveBeenCalled();
      });
      it('sin modo automático, escribir no pausa a Samanta', async () => {
        jest.replaceProperty(samantaTestConfig, 'autoEnabled', false);
        const row = await say();
        expect(await drafts(row)).toHaveLength(0);
        await request(c.server())
          .post(`/conversations/${row.conversationId}/messages`)
          .set('Authorization', c.auth(RoleCode.OPERATOR))
          .set('Idempotency-Key', randomUUID())
          .send({ type: 'TEXT', content: 'Hola' })
          .expect(202);
        expect(await conversation(row)).toMatchObject({
          isAssistantPaused: false,
        });
      });
      it('en modo sombra deja la respuesta como borrador para revisión', async () => {
        jest.replaceProperty(samantaTestConfig, 'autoSend', false);
        const row = await say();
        await due(row);
        const [draft] = await drafts(row);
        expect(draft).toMatchObject({
          status: 'READY',
          content: reply.content,
        });
        expect(await sent(row)).toHaveLength(0);
        await request(c.server())
          .post(
            `/conversations/${row.conversationId}/assistant-drafts/${draft.id}/approve`,
          )
          .set('Authorization', c.auth())
          .send({ revision: draft.revision })
          .expect(202);
        expect(await sent(row)).toHaveLength(1);
      });
      it('un sticker no cancela la respuesta pendiente', async () => {
        const row = await say();
        await say(row.phone, '[Mensaje de WhatsApp no compatible todavía]', {
          type: 'OTHER',
        });
        const scheduled = await drafts(row);
        expect(scheduled).toHaveLength(1);
        await due(row);
        expect((await drafts(row))[0].status).toBe('APPROVED');
      });
      it('si OpenAI falla, transfiere a una persona y guarda el motivo', async () => {
        samantaTestProvider.generate.mockRejectedValueOnce(
          new SamantaProviderError('AI_QUOTA_EXCEEDED', {
            inputTokens: 50,
            outputTokens: 0,
          }),
        );
        const row = await say();
        await due(row);
        expect((await drafts(row))[0]).toMatchObject({
          status: 'FAILED',
          errorCode: 'AI_QUOTA_EXCEEDED',
          inputTokens: 50,
        });
        expect(await sent(row)).toHaveLength(0);
        expect(await conversation(row)).toMatchObject({
          isAssistantPaused: true,
          assistantPauseReason: 'SAMANTA_HANDOFF',
        });
      });
      it('limita las respuestas por conversación y transfiere al superarlo', async () => {
        jest.replaceProperty(samantaTestConfig, 'autoMaxPerHour', 1);
        const row = await say();
        await due(row);
        await say(row.phone, 'Gracias, ¿y los domingos?');
        await due(row);
        expect(samantaTestProvider.generate).toHaveBeenCalledTimes(1);
        expect((await drafts(row)).at(-1)).toMatchObject({
          status: 'FAILED',
          errorCode: 'AUTO_CONVERSATION_LIMIT',
        });
        expect(await conversation(row)).toMatchObject({
          assistantPauseReason: 'SAMANTA_HANDOFF',
        });
      });
      it('un mensaje durante la generación descarta esa respuesta y responde al nuevo', async () => {
        const row = await say(undefined, 'Hola');
        samantaTestProvider.generate.mockImplementationOnce(async () => {
          await say(row.phone, '¿Tienen estacionamiento?');
          return reply;
        });
        await due(row);
        const [first, second] = await drafts(row);
        expect(first).toMatchObject({ status: 'STALE', inputTokens: 100 });
        expect(second.status).toBe('SCHEDULED');
        expect(await sent(row)).toHaveLength(0);
        await due(row);
        expect(await sent(row)).toHaveLength(1);
      });
      it('con la ventana cerrada no llama a OpenAI', async () => {
        const row = await say(undefined, 'Hola', {
          occurredAt: new Date(Date.now() - 25 * 3600000).toISOString(),
        });
        await due(row);
        expect(samantaTestProvider.generate).not.toHaveBeenCalled();
        expect((await drafts(row))[0]).toMatchObject({
          status: 'FAILED',
          errorCode: 'AUTO_CANNOT_REPLY',
        });
      });
      it('una conversación en pausa no programa respuestas', async () => {
        const row = await say();
        await db().conversation.update({
          where: { id: row.conversationId },
          data: { isAssistantPaused: true },
        });
        await say(row.phone, 'Otra pregunta');
        await due(row);
        expect(samantaTestProvider.generate).not.toHaveBeenCalled();
        expect((await drafts(row)).map((draft) => draft.status)).toEqual([
          'STALE',
        ]);
      });
      it('una respuesta abandonada a medias se transfiere a una persona', async () => {
        const row = await say();
        const [draft] = await drafts(row);
        await db().samantaDraft.update({
          where: { id: draft.id },
          data: {
            status: 'GENERATING',
            generationStartedAt: new Date(),
            generationExpiresAt: new Date(0),
          },
        });
        await auto().runOnce();
        expect((await drafts(row))[0]).toMatchObject({
          status: 'FAILED',
          errorCode: 'AI_GENERATION_EXPIRED',
        });
        expect(await conversation(row)).toMatchObject({
          assistantPauseReason: 'SAMANTA_HANDOFF',
        });
      });

      describe('M8.2: solicitudes registradas por Samanta', () => {
        // A date a week ahead, as the customer would say it in Lima.
        const local = (() => {
          const parts = Object.fromEntries(
            new Intl.DateTimeFormat('en-CA', {
              timeZone: 'America/Lima',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            })
              .formatToParts(new Date(Date.now() + 7 * 86400000))
              .map((part) => [part.type, part.value]),
          );
          return `${parts.year}-${parts.month}-${parts.day}`;
        })();
        const at = zonedTimeToUtc(
          {
            year: +local.slice(0, 4),
            month: +local.slice(5, 7),
            day: +local.slice(8, 10),
            hour: 19,
            minute: 30,
          },
          'America/Lima',
        )!;
        const reservation = (
          extra: Partial<ReservationAction> = {},
        ): ReservationAction => ({
          action: 'PROPOSE',
          language: 'es',
          date: local,
          time: '19:30',
          people: 4,
          service: null,
          specialRequirements: 'Mesa junto a la ventana',
          ...extra,
        });
        const answer = (
          extra: Partial<ReservationAction> = {},
          more: Partial<DraftOutput> = {},
        ) =>
          samantaTestProvider.generate.mockResolvedValueOnce({
            ...reply,
            intent: 'RESERVATION',
            content: 'Texto del modelo que no debe llegar al cliente.',
            reservation: reservation(extra),
            ...more,
          });
        const requests = (row: Said) =>
          db().reservationRequest.findMany({
            where: { conversationId: row.conversationId },
          });
        const lastSent = async (row: Said) => {
          const messages = await db().message.findMany({
            where: {
              conversationId: row.conversationId,
              direction: 'OUTBOUND',
            },
            orderBy: { sequence: 'desc' },
            take: 1,
          });
          return messages[0];
        };
        // The channel delivered the summary: only then can the customer confirm it.
        const delivered = async (row: Said) =>
          db().message.update({
            where: { id: (await lastSent(row)).id },
            data: {
              status: 'DELIVERED',
              sentAt: new Date(),
              deliveredAt: new Date(),
            },
          });
        const proposed = async () => {
          answer();
          const row = await say(
            undefined,
            'Quiero reservar para 4 el sábado a las 19:30',
          );
          await due(row);
          await delivered(row);
          return row;
        };

        it('datos completos sin confirmación: envía un resumen fijo y no crea la solicitud', async () => {
          const row = await proposed();
          const [draft] = await drafts(row);
          expect(draft).toMatchObject({
            status: 'APPROVED',
            reservationOutcome: 'PROPOSED',
            originalContent: 'Texto del modelo que no debe llegar al cliente.',
            reservationProposal: {
              date: local,
              time: '19:30',
              people: 4,
              commercialItemId: null,
              specialRequirements: 'Mesa junto a la ventana',
              language: 'es',
            },
            reservationRequestId: null,
          });
          const summary = await lastSent(row);
          expect(summary.content).toContain('¿Registro la solicitud');
          expect(summary.content).toContain('• Personas: 4');
          expect(summary.content).not.toContain('Texto del modelo');
          expect(await requests(row)).toHaveLength(0);
          expect(await conversation(row)).toMatchObject({
            isAssistantPaused: false,
          });
          // The next turn tells the model what is awaiting confirmation.
          answer({ action: 'NONE' });
          await say(row.phone, '¿Tienen estacionamiento?');
          await due(row);
          const [context] = samantaTestProvider.generate.mock.calls.at(-1)!;
          expect(
            (
              JSON.parse(context) as {
                customer: { awaitingConfirmation: unknown };
              }
            ).customer.awaitingConfirmation,
          ).toMatchObject({ date: local, time: '19:30', people: 4 });
        });

        it('confirmación explícita: crea la solicitud del cliente existente, vinculada a la conversación, sin transferir', async () => {
          const row = await proposed();
          const customers = await db().customer.count();
          const { customerId } = await conversation(row);
          answer({ action: 'CONFIRM', date: null, time: null, people: null });
          const yes = await say(row.phone, 'Sí, regístrala por favor');
          await due(row);
          const [request] = await requests(row);
          expect(request).toMatchObject({
            customerId,
            conversationId: row.conversationId,
            sourceChannel: 'WHATSAPP',
            status: 'READY_TO_SEND',
            numberOfPeople: 4,
            reservationAt: at,
            specialRequirements: 'Mesa junto a la ventana',
            commercialItemId: null,
          });
          expect(request.comments).toMatch(/^CRM: registrada por Samanta/);
          expect(await db().customer.count()).toBe(customers);
          expect(
            await db().customer.findUniqueOrThrow({
              where: { id: customerId },
            }),
          ).toMatchObject({ status: 'REQUESTED_RESERVATION' });
          // Created with its final status: the history only records later changes.
          expect(
            await db().reservationRequestStatusHistory.count({
              where: { reservationRequestId: request.id },
            }),
          ).toBe(0);
          const [summaryDraft, confirmDraft] = await drafts(row).then((all) =>
            all.filter((draft) => draft.reservationOutcome),
          );
          expect(summaryDraft.reservationRequestId).toBe(request.id);
          expect(confirmDraft).toMatchObject({
            sourceMessageId: yes.messageId,
            reservationOutcome: 'CREATED',
            requiresHuman: false,
          });
          const registered = await lastSent(row);
          expect(registered.content).toContain(request.code);
          expect(registered.content).toContain('pendiente de aprobación');
          expect(registered.content).not.toMatch(/confirmada/i);
          expect(await conversation(row)).toMatchObject({
            isAssistantPaused: false,
          });
          // No reservation enters the calendar.
          expect(
            await db().reservation.count({
              where: { reservationRequestId: request.id },
            }),
          ).toBe(0);
        });

        it('mensaje duplicado y «sí» repetido: una sola solicitud', async () => {
          const row = await proposed();
          answer({ action: 'CONFIRM' });
          const yes = await say(row.phone, 'Sí, confirmo esos datos');
          await due(row);
          // The same message processed again schedules nothing.
          await expect(
            c.app().get(MessageProcessorService).process(yes.messageId),
          ).resolves.toBe('terminal');
          await delivered(row);
          answer({ action: 'CONFIRM' });
          await say(row.phone, 'Sí');
          await due(row);
          const all = await requests(row);
          expect(all).toHaveLength(1);
          expect((await lastSent(row)).content).toContain(all[0].code);
          expect((await drafts(row)).at(-1)).toMatchObject({
            reservationOutcome: 'ALREADY_REGISTERED',
          });
        });

        it('procesamiento concurrente de la misma confirmación: una sola solicitud', async () => {
          const row = await proposed();
          const yes = await say(row.phone, 'Sí, regístrala');
          const source = await db().message.findUniqueOrThrow({
            where: { id: yes.messageId },
          });
          const confirm = () =>
            c
              .app()
              .get(MessagingTransactionService)
              .run((tx) =>
                c
                  .app()
                  .get(SamantaReservationService)
                  .confirm(
                    tx,
                    row.conversationId,
                    source.sequence,
                    'es',
                    new Date(),
                  ),
              );
          const results = await Promise.allSettled([confirm(), confirm()]);
          const codes = results.map((result) =>
            result.status === 'fulfilled' ? result.value.code : 'CONFLICT',
          );
          expect(codes.filter((code) => code === 'CREATED')).toHaveLength(1);
          expect(await requests(row)).toHaveLength(1);
        });

        it('un «sí» sin resumen previo no crea nada y pasa a una persona', async () => {
          answer({ action: 'CONFIRM' });
          const row = await say(undefined, 'Sí');
          await due(row);
          expect(await requests(row)).toHaveLength(0);
          expect((await drafts(row))[0]).toMatchObject({
            reservationOutcome: 'NO_PROPOSAL',
            requiresHuman: true,
          });
          expect(await conversation(row)).toMatchObject({
            isAssistantPaused: true,
            assistantPauseReason: 'SAMANTA_HANDOFF',
          });
        });

        it.each([
          [{ date: '2020-01-01' }, 'PAST_DATE', 'ya pasaron'],
          [
            { service: 'Servicio que no existe' },
            'UNKNOWN_SERVICE',
            'No encontré',
          ],
          [{ people: null }, 'MISSING_DATA', 'el número de personas'],
        ] as const)(
          'datos %j: %s, sin resumen, sin solicitud y sin transferir',
          async (extra, outcome, text) => {
            answer(extra);
            const row = await say(undefined, 'Quiero reservar');
            await due(row);
            expect((await drafts(row))[0]).toMatchObject({
              reservationOutcome: outcome,
              reservationProposal: null,
            });
            expect((await lastSent(row)).content).toContain(text);
            expect(await requests(row)).toHaveLength(0);
            expect(await conversation(row)).toMatchObject({
              isAssistantPaused: false,
            });
          },
        );

        it('un caso para una persona prevalece sobre la confirmación', async () => {
          const row = await proposed();
          answer(
            { action: 'CONFIRM' },
            {
              intent: 'HUMAN',
              requiresHuman: true,
              content: 'Te comunico con una persona del equipo.',
            },
          );
          await say(row.phone, 'Sí, pero uno de nosotros es alérgico al maní');
          await due(row);
          expect(await requests(row)).toHaveLength(0);
          expect((await lastSent(row)).content).toBe(
            'Te comunico con una persona del equipo.',
          );
          expect(await conversation(row)).toMatchObject({
            isAssistantPaused: true,
            assistantPauseReason: 'SAMANTA_HANDOFF',
          });
        });

        it('en modo sombra no registra nada', async () => {
          const row = await proposed();
          jest.replaceProperty(samantaTestConfig, 'autoSend', false);
          answer({ action: 'CONFIRM' });
          await say(row.phone, 'Sí, regístrala');
          await due(row);
          expect(await requests(row)).toHaveLength(0);
          expect((await drafts(row)).at(-1)).toMatchObject({
            status: 'READY',
            reservationOutcome: null,
          });
        });

        describe('content vacío de OpenAI en PROPOSE y CONFIRM', () => {
          const empty = { content: '' };
          // Every message Samanta queued in the conversation has text.
          const noEmptyMessages = async (row: Said) => {
            for (const message of await sent(row))
              expect(message.content?.trim()).toBeTruthy();
          };

          it('PROPOSE vacío con datos válidos: envía el resumen fijo', async () => {
            answer({}, empty);
            const row = await say(undefined, 'Para 4 el viernes a las 19:30');
            await due(row);
            expect((await drafts(row))[0]).toMatchObject({
              status: 'APPROVED',
              reservationOutcome: 'PROPOSED',
              originalContent: '',
            });
            expect((await lastSent(row)).content).toContain(
              '¿Registro la solicitud',
            );
            await noEmptyMessages(row);
          });

          it('CONFIRM vacío tras un resumen: registra la solicitud y responde el texto fijo', async () => {
            const row = await proposed();
            answer({ action: 'CONFIRM' }, empty);
            await say(row.phone, 'Sí, regístrala');
            await due(row);
            const [request] = await requests(row);
            expect(request).toMatchObject({
              status: 'READY_TO_SEND',
              conversationId: row.conversationId,
            });
            const registered = (await lastSent(row)).content!;
            expect(registered).toContain(request.code);
            expect(registered).toContain('pendiente de aprobación');
            expect(registered).not.toMatch(/confirmada/i);
            await noEmptyMessages(row);
          });

          it('CONFIRM vacío sin resumen previo: no registra y pasa a una persona con texto', async () => {
            answer({ action: 'CONFIRM' }, empty);
            const row = await say(undefined, 'Sí');
            await due(row);
            expect(await requests(row)).toHaveLength(0);
            expect((await drafts(row))[0]).toMatchObject({
              reservationOutcome: 'NO_PROPOSAL',
            });
            expect((await lastSent(row)).content).toBe(replies.es.noProposal);
            expect(await conversation(row)).toMatchObject({
              assistantPauseReason: 'SAMANTA_HANDOFF',
            });
          });

          it('requiresHuman con content vacío: envía el aviso de respaldo y transfiere', async () => {
            answer(
              { action: 'CONFIRM' },
              { ...empty, intent: 'HUMAN', requiresHuman: true },
            );
            const row = await say(
              undefined,
              'Sí, pero quiero hablar con alguien',
            );
            await due(row);
            expect(await requests(row)).toHaveLength(0);
            expect((await lastSent(row)).content).toBe(replies.es.emptyHandOff);
            expect((await drafts(row))[0]).toMatchObject({
              content: replies.es.emptyHandOff,
              originalContent: '',
              reservationOutcome: null,
            });
            expect(await conversation(row)).toMatchObject({
              assistantPauseReason: 'SAMANTA_HANDOFF',
            });
          });

          it('modo sombra: el borrador queda READY con texto de respaldo, nunca vacío', async () => {
            jest.replaceProperty(samantaTestConfig, 'autoSend', false);
            answer({}, empty);
            const row = await say(undefined, 'Para 4 el viernes a las 19:30');
            await due(row);
            expect((await drafts(row))[0]).toMatchObject({
              status: 'READY',
              content: replies.es.emptyReply,
              originalContent: '',
              reservationOutcome: null,
            });
            expect(await sent(row)).toHaveLength(0);
          });

          it('dos CONFIRM vacíos seguidos: una sola solicitud', async () => {
            const row = await proposed();
            answer({ action: 'CONFIRM' }, empty);
            await say(row.phone, 'Sí');
            await due(row);
            await delivered(row);
            answer({ action: 'CONFIRM' }, empty);
            await say(row.phone, 'Sí, sí');
            await due(row);
            const all = await requests(row);
            expect(all).toHaveLength(1);
            expect((await drafts(row)).at(-1)).toMatchObject({
              reservationOutcome: 'ALREADY_REGISTERED',
            });
            expect((await lastSent(row)).content).toContain(all[0].code);
            await noEmptyMessages(row);
          });
        });
      });
    });
  });
}
