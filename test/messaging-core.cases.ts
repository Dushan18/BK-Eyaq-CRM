import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { PrismaClient } from '../generated/prisma/client';
import { RoleCode } from '../generated/prisma/enums';
import { MessagesService } from '../src/messaging/messages.service';
import { ConversationsService } from '../src/messaging/conversations.service';
import {
  MessagePreparationService,
  MessageProcessorService,
  TerminalMessageError,
} from '../src/messaging/message-processor.service';
import { MessagingQueueService } from '../src/messaging/messaging-queue.service';
import { MessagingOutboxService } from '../src/messaging/messaging-outbox.service';
import { MessagingTransactionService } from '../src/messaging/messaging-transaction.service';
import { CustomersService } from '../src/customers/customers.service';
import { PrismaService } from '../src/database/prisma.service';
import { Queue } from 'bullmq';
import {
  redisConnection,
  INBOUND_QUEUE,
} from '../src/messaging/messaging-queue.service';

interface Context {
  app: () => INestApplication;
  prisma: () => PrismaClient;
  server: () => App;
  auth: (role?: RoleCode) => string;
}
export function registerMessagingCoreTests(c: Context) {
  const input = (extra: object = {}) => ({
    channel: 'WHATSAPP',
    externalMessageId: randomUUID(),
    type: 'TEXT',
    content: 'Hola',
    contact: { email: `msg-${randomUUID()}@example.com`, firstName: 'Mensaje' },
    ...extra,
  });
  const service = () => c.app().get(MessagesService);
  const processor = () => c.app().get(MessageProcessorService);
  const db = () => c.prisma();
  describe('Mensajería core: PostgreSQL y JWT reales', () => {
    it('diez ingestiones concurrentes crean un cliente, conversación, mensaje y outbox', async () => {
      const command = input();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          service().ingestInboundMessage(command),
        ),
      );
      expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(
        await db().customer.count({
          where: { normalizedEmail: command.contact.email },
        }),
      ).toBe(1);
      expect(
        await db().message.count({
          where: { externalMessageId: command.externalMessageId },
        }),
      ).toBe(1);
      expect(
        await db().messagingOutbox.count({
          where: { messageId: results[0].message.id },
        }),
      ).toBe(1);
      expect(results[0].message).toMatchObject({
        direction: 'INBOUND',
        status: 'RECEIVED',
        readAt: null,
        sequence: 1,
      });
    });
    it('reutiliza contacto/conversación, conserva primera fecha y duplicado no toca contacto', async () => {
      const command = input({
        contact: {
          phone: '+51 945 678 123',
          email: `reuse-${randomUUID()}@example.com`,
        },
      });
      const first = await service().ingestInboundMessage(command);
      const conversation = await db().conversation.findUniqueOrThrow({
        where: { id: first.message.conversationId },
      });
      const before = await db().customer.findUniqueOrThrow({
        where: { id: conversation.customerId },
      });
      await service().ingestInboundMessage(command);
      const duplicate = await db().customer.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(duplicate.lastContactAt).toEqual(before.lastContactAt);
      const next = await service().ingestInboundMessage({
        ...command,
        externalMessageId: randomUUID(),
        occurredAt: '2020-01-01T00:00:00Z',
      });
      expect(next.message.conversationId).toBe(first.message.conversationId);
      expect(next.message.sequence).toBe(2);
      const after = await db().customer.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.firstContactAt).toEqual(before.firstContactAt);
      expect(after.lastContactAt.getTime()).toBeGreaterThanOrEqual(
        before.lastContactAt.getTime(),
      );
      expect(after.normalizedPhone).toBe('+51945678123');
      const convo = await db().conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      });
      expect(convo.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(
        conversation.lastMessageAt!.getTime(),
      );
      await expect(
        service().ingestInboundMessage({
          ...command,
          contact: { email: 'different@example.com' },
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('fallo tras resolver Customer revierte todas las escrituras', async () => {
      const command = input();
      const customers = c.app().get(CustomersService);
      const original = new CustomersService(c.app().get(PrismaService));
      const spy = jest
        .spyOn(customers, 'findOrCreateByContact')
        .mockImplementationOnce(async (...args) => {
          await original.findOrCreateByContact(...args);
          throw new Error('simulated rollback');
        });
      try {
        await expect(service().ingestInboundMessage(command)).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
      expect(
        await db().customer.count({
          where: { normalizedEmail: command.contact.email },
        }),
      ).toBe(0);
      expect(
        await db().message.count({
          where: { externalMessageId: command.externalMessageId },
        }),
      ).toBe(0);
    });
    it.each(['IMAGE', 'FILE'])(
      'persiste metadata %s sin binarios',
      async (type) => {
        const result = await service().ingestInboundMessage(
          input({
            type,
            content: undefined,
            attachments: [
              {
                type,
                fileName: 'demo',
                externalMediaId: 'media-1',
                sizeBytes: 100,
              },
            ],
          }),
        );
        expect(result.message.attachments[0]).toMatchObject({
          type,
          sizeBytes: 100,
          externalMediaId: 'media-1',
        });
      },
    );
    it('paginación, filtros, unread y corte de lectura idempotente', async () => {
      const command = input({
        contact: {
          email: `filters-${randomUUID()}@example.com`,
          firstName: 'FiltroPrueba',
        },
      });
      const first = await service().ingestInboundMessage(command);
      const second = await service().ingestInboundMessage({
        ...command,
        externalMessageId: randomUUID(),
      });
      const id = first.message.conversationId;
      const detail = await request(c.server())
        .get(`/conversations/${id}`)
        .set('Authorization', c.auth())
        .expect(200);
      expect(detail.body).toMatchObject({ unreadCount: 2 });
      expect(detail.body).not.toHaveProperty('messages');
      expect(detail.body).not.toHaveProperty('lastSequence');
      expect(JSON.stringify(detail.body)).not.toMatch(
        /normalizedEmail|passwordHash|processingToken/,
      );
      const customerId = (detail.body as { customerId: string }).customerId;
      const page = await request(c.server())
        .get(`/conversations/${id}/messages`)
        .query({ limit: 1 })
        .set('Authorization', c.auth())
        .expect(200);
      expect(page.body).toMatchObject({
        data: [{ id: second.message.id }],
        pagination: { total: 2 },
      });
      await request(c.server())
        .patch(`/conversations/${id}/read`)
        .set('Authorization', c.auth())
        .send({ throughMessageId: first.message.id })
        .expect(200, { updated: 1, throughMessageId: first.message.id });
      await request(c.server())
        .patch(`/conversations/${id}/read`)
        .set('Authorization', c.auth())
        .send({ throughMessageId: first.message.id })
        .expect(200, { updated: 0, throughMessageId: first.message.id });
      const next = await service().ingestInboundMessage({
        ...command,
        externalMessageId: randomUUID(),
      });
      const found = await request(c.server())
        .get('/conversations')
        .query({
          channel: 'WHATSAPP',
          customerId,
          unreadOnly: true,
          isAssistantPaused: false,
          search: 'FiltroPrueba',
          limit: 1,
        })
        .set('Authorization', c.auth(RoleCode.OWNER))
        .expect(200);
      expect(found.body).toMatchObject({
        data: [{ id, unreadCount: 2 }],
        pagination: { total: 1 },
      });
      expect(
        (
          await db().message.findUniqueOrThrow({
            where: { id: next.message.id },
          })
        ).readAt,
      ).toBeNull();
      await request(c.server())
        .patch(`/conversations/${id}/read`)
        .set('Authorization', c.auth())
        .send({ throughMessageId: next.message.id })
        .expect(200);
      const empty = await request(c.server())
        .get('/conversations')
        .query({ customerId, unreadOnly: true })
        .set('Authorization', c.auth())
        .expect(200);
      expect(empty.body).toMatchObject({ data: [], pagination: { total: 0 } });
    });
    it('lectura concurrente no consume un mensaje posterior al corte; OUTBOUND no cuenta', async () => {
      const command = input();
      const first = await service().ingestInboundMessage(command);
      const [next] = await Promise.all([
        service().ingestInboundMessage({
          ...command,
          externalMessageId: randomUUID(),
        }),
        c
          .app()
          .get(ConversationsService)
          .markRead(first.message.conversationId, {
            throughMessageId: first.message.id,
          }),
      ]);
      expect(
        (
          await db().message.findUniqueOrThrow({
            where: { id: next.message.id },
          })
        ).readAt,
      ).toBeNull();
      await db().message.create({
        data: {
          conversationId: first.message.conversationId,
          channel: 'WHATSAPP',
          sequence: 99,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          type: 'TEXT',
          content: 'No enviado',
        },
      });
      expect(
        await c
          .app()
          .get(ConversationsService)
          .findOne(first.message.conversationId),
      ).toMatchObject({ unreadCount: 1 });
    });
    it('pausa y asignación independientes; autoasignación y usuario no elegible', async () => {
      const message = await service().ingestInboundMessage(input());
      const id = message.message.conversationId;
      const operator = await db().user.findUniqueOrThrow({
        where: { email: 'operator@test.example' },
      });
      for (const paused of [true, false])
        await request(c.server())
          .patch(`/conversations/${id}/assistant`)
          .set('Authorization', c.auth(RoleCode.OPERATOR))
          .send({ paused })
          .expect(200);
      const assigned = await request(c.server())
        .patch(`/conversations/${id}/assignee`)
        .set('Authorization', c.auth(RoleCode.OPERATOR))
        .send({ assignedUserId: operator.id })
        .expect(200);
      expect(assigned.body).toMatchObject({
        assignedUserId: operator.id,
        isAssistantPaused: false,
        assignedUser: { isEligible: true },
      });
      await request(c.server())
        .patch(`/conversations/${id}/assignee`)
        .set('Authorization', c.auth())
        .send({ assignedUserId: null })
        .expect(200);
      for (const role of ['owner', 'support']) {
        const user = await db().user.findUniqueOrThrow({
          where: { email: `${role}@test.example` },
        });
        await request(c.server())
          .patch(`/conversations/${id}/assignee`)
          .set('Authorization', c.auth())
          .send({ assignedUserId: user.id })
          .expect(400);
      }
      await request(c.server())
        .patch(`/conversations/${id}/assignee`)
        .set('Authorization', c.auth())
        .send({ assignedUserId: randomUUID() })
        .expect(404);
      await request(c.server())
        .patch(`/conversations/${id}/assignee`)
        .set('Authorization', c.auth())
        .send({})
        .expect(400);
    });
    it.each([
      ['get', '', true],
      ['get', '/id', true],
      ['get', '/id/messages', true],
      ['patch', '/id/read', false],
      ['patch', '/id/assistant', false],
      ['patch', '/id/assignee', false],
    ] as const)('RBAC real %s %s', async (method, suffix, read) => {
      const path = `/conversations${suffix.replace('/id', '/' + randomUUID())}`;
      await request(c.server())[method](path).send({}).expect(401);
      for (const role of Object.values(RoleCode)) {
        const result = await request(c.server())
          [method](path)
          .set('Authorization', c.auth(role))
          .send({});
        if (role === 'SUPPORT' || (role === 'OWNER' && !read))
          expect(result.status).toBe(403);
        else expect([200, 400, 404]).toContain(result.status);
      }
    });
    it('worker duplicado es idempotente y confirma outbox con mensaje', async () => {
      const result = await service().ingestInboundMessage(input());
      await Promise.all([
        processor().process(result.message.id),
        processor().process(result.message.id),
      ]);
      await processor().process(result.message.id);
      const message = await db().message.findUniqueOrThrow({
        where: { id: result.message.id },
      });
      expect(message).toMatchObject({
        status: 'PROCESSED',
        processingAttempts: 1,
        processingToken: null,
      });
      expect(
        await db().messagingOutbox.findUniqueOrThrow({
          where: { messageId: message.id },
        }),
      ).toMatchObject({ status: 'COMPLETED' });
    });
    it('errores temporales agotan presupuesto persistente y no guardan secretos', async () => {
      const result = await service().ingestInboundMessage(input());
      const spy = jest
        .spyOn(c.app().get(MessagePreparationService), 'prepare')
        .mockRejectedValue(new Error('PRIVATE_CONTENT_SECRET'));
      try {
        for (let i = 0; i < 4; i++)
          await expect(processor().process(result.message.id)).rejects.toThrow(
            'MESSAGE_PROCESSING_TEMPORARY',
          );
        await expect(processor().process(result.message.id)).resolves.toBe(
          'terminal',
        );
        await expect(processor().process(result.message.id)).resolves.toBe(
          'terminal',
        );
      } finally {
        spy.mockRestore();
      }
      const row = await db().message.findUniqueOrThrow({
        where: { id: result.message.id },
      });
      expect(row).toMatchObject({ status: 'FAILED', processingAttempts: 5 });
      expect(JSON.stringify(row)).not.toContain('PRIVATE_CONTENT_SECRET');
    });
    it('error definitivo no reintenta', async () => {
      const result = await service().ingestInboundMessage(input());
      const spy = jest
        .spyOn(c.app().get(MessagePreparationService), 'prepare')
        .mockRejectedValueOnce(new TerminalMessageError());
      try {
        await expect(processor().process(result.message.id)).resolves.toBe(
          'terminal',
        );
      } finally {
        spy.mockRestore();
      }
      expect(
        await db().message.findUniqueOrThrow({
          where: { id: result.message.id },
        }),
      ).toMatchObject({ status: 'FAILED', processingAttempts: 1 });
    });
    it('reinicio recupera lease vencido y worker antiguo no confirma', async () => {
      const result = await service().ingestInboundMessage(input());
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = jest
        .spyOn(c.app().get(MessagePreparationService), 'prepare')
        .mockImplementationOnce(async () => {
          entered();
          await waiting;
        });
      const old = processor().process(result.message.id);
      await ready;
      await db().message.update({
        where: { id: result.message.id },
        data: { processingUntil: new Date(0) },
      });
      const restarted = new MessageProcessorService(
        c.app().get(PrismaService),
        c.app().get(MessagingTransactionService),
        new MessagePreparationService(),
      );
      await expect(restarted.process(result.message.id)).resolves.toBe(
        'processed',
      );
      release();
      try {
        await expect(old).resolves.toBe('busy');
      } finally {
        spy.mockRestore();
      }
      expect(
        await db().message.findUniqueOrThrow({
          where: { id: result.message.id },
        }),
      ).toMatchObject({ status: 'PROCESSED', processingAttempts: 2 });
    });
    it('Redis caído conserva outbox; recuperación/publicación repetida no duplica efectos', async () => {
      const result = await service().ingestInboundMessage(input());
      const outbox = c.app().get(MessagingOutboxService);
      const queue = c.app().get(MessagingQueueService);
      const spy = jest
        .spyOn(queue, 'publish')
        .mockRejectedValue(new Error('PRIVATE_REDIS_SECRET'));
      try {
        await outbox.dispatchOnce();
        const row = await db().messagingOutbox.findUniqueOrThrow({
          where: { messageId: result.message.id },
        });
        expect(row).toMatchObject({
          status: 'PENDING',
          lastErrorCode: 'QUEUE_UNAVAILABLE',
          leaseToken: null,
        });
        await db().messagingOutbox.update({
          where: { id: row.id },
          data: { availableAt: new Date(0) },
        });
        spy.mockImplementation(async (id) => {
          await processor().process(id);
        });
        await outbox.dispatchOnce();
        expect(
          await db().messagingOutbox.findUniqueOrThrow({
            where: { id: row.id },
          }),
        ).toMatchObject({ status: 'COMPLETED' });
        await outbox.dispatchOnce();
        expect(
          await db().message.findUniqueOrThrow({
            where: { id: result.message.id },
          }),
        ).toMatchObject({ processingAttempts: 1 });
      } finally {
        spy.mockRestore();
      }
    });
    it('restricciones SQL conservan relaciones, identidad y dirección', async () => {
      const first = await service().ingestInboundMessage(input());
      const row = await db().message.findUniqueOrThrow({
        where: { id: first.message.id },
      });
      await expect(
        db().message.update({ where: { id: row.id }, data: { sequence: 0 } }),
      ).rejects.toThrow();
      await expect(
        db().message.update({
          where: { id: row.id },
          data: { status: 'SENT', sentAt: new Date() },
        }),
      ).rejects.toThrow();
      await expect(
        db().message.update({
          where: { id: row.id },
          data: { channel: 'EMAIL' },
        }),
      ).rejects.toThrow();
      await expect(
        db().conversation.delete({ where: { id: row.conversationId } }),
      ).rejects.toThrow();
      const convo = await db().conversation.findUniqueOrThrow({
        where: { id: row.conversationId },
      });
      await expect(
        db().customer.delete({ where: { id: convo.customerId } }),
      ).rejects.toThrow();
      await expect(
        db().conversation.create({
          data: { customerId: convo.customerId, channel: convo.channel },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
    it('dispatcher reiniciado recupera PUBLISHED sin ACK y lease de publicación vencido', async () => {
      const result = await service().ingestInboundMessage(input());
      const queue = c.app().get(MessagingQueueService);
      const spy = jest.spyOn(queue, 'publish').mockResolvedValue(undefined);
      const restarted = new MessagingOutboxService(
        c.app().get(PrismaService),
        queue,
        processor(),
        new ConfigService(),
      );
      try {
        await c.app().get(MessagingOutboxService).dispatchOnce();
        expect(
          await db().messagingOutbox.findUniqueOrThrow({
            where: { messageId: result.message.id },
          }),
        ).toMatchObject({ status: 'PUBLISHED' });
        await db().messagingOutbox.update({
          where: { messageId: result.message.id },
          data: {
            availableAt: new Date(0),
            leaseToken: randomUUID(),
            leaseUntil: new Date(0),
          },
        });
        spy.mockClear();
        spy.mockImplementation(async (id) => {
          await processor().process(id);
        });
        await Promise.all([
          restarted.dispatchOnce(),
          c.app().get(MessagingOutboxService).dispatchOnce(),
        ]);
        expect(
          spy.mock.calls.filter(([id]) => id === result.message.id),
        ).toHaveLength(1);
        expect(
          await db().messagingOutbox.findUniqueOrThrow({
            where: { messageId: result.message.id },
          }),
        ).toMatchObject({ status: 'COMPLETED' });
        expect(
          await db().message.findUniqueOrThrow({
            where: { id: result.message.id },
          }),
        ).toMatchObject({ processingAttempts: 1 });
      } finally {
        spy.mockRestore();
      }
    });
    it('responsable inactivo se rechaza y fecha/ID ordenan bandeja con null al final', async () => {
      const result = await service().ingestInboundMessage(input());
      const id = result.message.conversationId;
      const operator = await db().user.findUniqueOrThrow({
        where: { email: 'operator@test.example' },
      });
      await db().user.update({
        where: { id: operator.id },
        data: { isActive: false },
      });
      try {
        await request(c.server())
          .patch(`/conversations/${id}/assignee`)
          .set('Authorization', c.auth())
          .send({ assignedUserId: operator.id })
          .expect(400);
      } finally {
        await db().user.update({
          where: { id: operator.id },
          data: { isActive: true },
        });
      }
      const conversation = await db().conversation.findUniqueOrThrow({
        where: { id },
      });
      const empty = await db().conversation.create({
        data: { customerId: conversation.customerId, channel: 'EMAIL' },
      });
      const list = await request(c.server())
        .get('/conversations')
        .query({ customerId: conversation.customerId })
        .set('Authorization', c.auth())
        .expect(200);
      expect(
        (list.body as { data: { id: string }[] }).data.map((r) => r.id),
      ).toEqual([id, empty.id]);
      const assigned = await request(c.server())
        .patch(`/conversations/${id}/assignee`)
        .set('Authorization', c.auth())
        .send({ assignedUserId: operator.id })
        .expect(200);
      expect(assigned.body).toMatchObject({ assignedUserId: operator.id });
      const filtered = await request(c.server())
        .get('/conversations')
        .query({
          assignedUserId: operator.id,
          customerId: conversation.customerId,
        })
        .set('Authorization', c.auth())
        .expect(200);
      expect(filtered.body).toMatchObject({
        data: [{ id }],
        pagination: { total: 1 },
      });
    });
  });

  const redisTest =
    process.env.MESSAGING_REDIS_INTEGRATION === '1' ? it : it.skip;
  redisTest('Mensajería: Redis/BullMQ reales con prefijo aislado', async () => {
    const url = process.env.TEST_REDIS_URL;
    if (!url) throw new Error('Se requiere TEST_REDIS_URL');
    const prefix = `test-messaging-${randomUUID()}`;
    if (!/^test-messaging-[a-f0-9-]{36}$/.test(prefix))
      throw new Error('Prefijo inválido');
    const config = new ConfigService({
      REDIS_URL: url,
      MESSAGING_QUEUE_PREFIX: prefix,
    });
    const queue = new MessagingQueueService(config);
    const inspect = new Queue(INBOUND_QUEUE, {
      connection: redisConnection(url),
      prefix,
    });
    try {
      queue.start(processor());
      await inspect.waitUntilReady();
      const result = await service().ingestInboundMessage(input());
      await queue.publish(result.message.id);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (
          (
            await db().message.findUniqueOrThrow({
              where: { id: result.message.id },
            })
          ).status === 'PROCESSED'
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(
        await db().message.findUniqueOrThrow({
          where: { id: result.message.id },
        }),
      ).toMatchObject({ status: 'PROCESSED', processingAttempts: 1 });
      const job = await inspect.getJob(`inbound-${result.message.id}`);
      expect(job?.data).toEqual({ messageId: result.message.id });
      await queue.publish(result.message.id);
    } finally {
      await queue.onModuleDestroy();
      // Only the generated, test-owned queue is deleted; never FLUSHALL/shared queues.
      await inspect.obliterate({ force: true });
      await inspect.close();
    }
  });
}
