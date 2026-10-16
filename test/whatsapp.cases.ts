import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { PrismaClient } from '../generated/prisma/client';
import { RoleCode } from '../generated/prisma/enums';
import { WhatsAppConfig } from '../src/whatsapp/whatsapp.config';
import {
  WhatsAppAdapter,
  WhatsAppSendError,
} from '../src/whatsapp/whatsapp.adapter';
import { OutboundMessagesService } from '../src/messaging/outbound-messages.service';
import { MessageStatusService } from '../src/messaging/message-status.service';
import { MessagingOutboxService } from '../src/messaging/messaging-outbox.service';
import { MessagingQueueService } from '../src/messaging/messaging-queue.service';
import {
  INBOUND_QUEUE,
  OUTBOUND_QUEUE,
  redisConnection,
} from '../src/messaging/messaging-queue.service';
import { MessageProcessorService } from '../src/messaging/message-processor.service';
import { MessagingTransactionService } from '../src/messaging/messaging-transaction.service';
import { Queue } from 'bullmq';
import { PrismaService } from '../src/database/prisma.service';
import { eventually, IsolatedRedis } from './isolated-redis';

// Only fake test credentials. Background queues stay disabled in this fixture.
export const whatsappTestConfig = new WhatsAppConfig(
  new ConfigService({
    WHATSAPP_ENABLED: 'true',
    MESSAGING_ENABLED: 'true',
    REDIS_URL: 'redis://localhost:6379',
    WHATSAPP_ACCESS_TOKEN: 'fake-access',
    WHATSAPP_VERIFY_TOKEN: 'fake-verify',
    META_APP_SECRET: 'fake-secret',
    WHATSAPP_PHONE_NUMBER_ID: '123',
    WHATSAPP_BUSINESS_ACCOUNT_ID: '456',
    WHATSAPP_API_VERSION: 'v25.0',
  }),
);
interface Context {
  app: () => INestApplication;
  prisma: () => PrismaClient;
  server: () => App;
  auth: (role?: RoleCode) => string;
}
interface MessageResponse {
  id: string;
  conversationId: string;
  status: string;
  authorUserId: string;
}
export function registerWhatsAppTests(c: Context) {
  const db = () => c.prisma();
  const processor = () => c.app().get(OutboundMessagesService);
  const statuses = () => c.app().get(MessageStatusService);
  const payload = (messages: unknown[] = [], statusEvents: unknown[] = []) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '456',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '123' },
              messages,
              statuses: statusEvents,
            },
          },
        ],
      },
    ],
  });
  const webhook = (body: unknown) => {
    const raw = JSON.stringify(body, null, 2);
    return request(c.server())
      .post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set(
        'X-Hub-Signature-256',
        'sha256=' +
          createHmac('sha256', whatsappTestConfig.appSecret)
            .update(raw)
            .digest('hex'),
      )
      .send(raw);
  };
  const inbound = async (age = 0) => {
    const id = `wamid.${randomUUID()}`;
    const phone = `519${randomInt(10000000, 99999999)}`;
    const message = {
      id,
      from: phone,
      timestamp: String(Math.floor((Date.now() - age) / 1000)),
      type: 'text',
      text: { body: 'Hola WhatsApp' },
    };
    await webhook(payload([message])).expect(200);
    const row = await db().message.findUniqueOrThrow({
      where: {
        channel_externalMessageId: {
          channel: 'WHATSAPP',
          externalMessageId: id,
        },
      },
    });
    return { row, phone, message };
  };
  const enqueue = async (
    conversationId: string,
    key = randomUUID(),
    role = RoleCode.ADMIN,
  ) => {
    const response = await request(c.server())
      .post(`/conversations/${conversationId}/messages`)
      .set('Authorization', c.auth(role))
      .set('Idempotency-Key', key)
      .send({ type: 'TEXT', content: 'Hola, somos Sabor Mágico Grill.' })
      .expect(202);
    return response.body as MessageResponse;
  };
  describe('WhatsApp: PostgreSQL, HTTP, firma y JWT reales; Meta simulado', () => {
    let send: jest.SpyInstance;
    beforeEach(() => {
      send = jest
        .spyOn(c.app().get(WhatsAppAdapter), 'sendMessage')
        .mockImplementation(() => Promise.resolve(`wamid.${randomUUID()}`));
    });
    afterEach(() => send.mockRestore());
    it('caída DB después de aceptación no repite el POST al recuperar', async () => {
      const { row } = await inbound();
      const outbound = await enqueue(row.conversationId);
      const transactions = c.app().get(MessagingTransactionService);
      let failure: jest.SpyInstance | undefined;
      send.mockImplementationOnce(() => {
        failure = jest
          .spyOn(transactions, 'run')
          .mockRejectedValueOnce(new Error('DB unavailable'));
        return Promise.resolve(`wamid.${randomUUID()}`);
      });
      try {
        await expect(processor().process(outbound.id)).rejects.toThrow(
          'DB unavailable',
        );
      } finally {
        failure?.mockRestore();
      }
      await db().message.update({
        where: { id: outbound.id },
        data: { processingUntil: new Date(0) },
      });
      await processor().process(outbound.id);
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        await db().message.findUniqueOrThrow({ where: { id: outbound.id } }),
      ).toMatchObject({ status: 'UNKNOWN' });
    });
    const redisTest =
      process.env.MESSAGING_REDIS_INTEGRATION === '1' ? it : it.skip;
    redisTest(
      'cola OUTBOUND real con prefijo aislado y Meta simulado',
      async () => {
        const url = process.env.TEST_REDIS_URL;
        if (!url) throw new Error('Se requiere TEST_REDIS_URL');
        const prefix = `test-whatsapp-${randomUUID()}`;
        if (!/^test-whatsapp-[a-f0-9-]{36}$/.test(prefix))
          throw new Error('Prefijo inválido');
        const queue = new MessagingQueueService(
          new ConfigService({ REDIS_URL: url, MESSAGING_QUEUE_PREFIX: prefix }),
        );
        const inspectors = [INBOUND_QUEUE, OUTBOUND_QUEUE].map(
          (name) =>
            new Queue(name, { connection: redisConnection(url), prefix }),
        );
        try {
          queue.start(c.app().get(MessageProcessorService), processor());
          await Promise.all(inspectors.map((q) => q.waitUntilReady()));
          const { row } = await inbound();
          const outbound = await enqueue(row.conversationId);
          await queue.publish(outbound.id, 'OUTBOUND');
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            if (
              (
                await db().message.findUniqueOrThrow({
                  where: { id: outbound.id },
                })
              ).status === 'SENT'
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(
            await db().message.findUniqueOrThrow({
              where: { id: outbound.id },
            }),
          ).toMatchObject({ status: 'SENT', processingAttempts: 1 });
          expect(
            (await inspectors[1].getJob(`outbound-${outbound.id}`))?.data,
          ).toEqual({ messageId: outbound.id });
          expect(send).toHaveBeenCalledTimes(1);
        } finally {
          await queue.onModuleDestroy();
          for (const inspector of inspectors) {
            // Only generated test-owned prefixes; never shared queues or FLUSHALL.
            await inspector.obliterate({ force: true });
            await inspector.close();
          }
        }
      },
    );
    it('10 webhooks concurrentes conservan una identidad/mensaje/outbox', async () => {
      const { row, message, phone } = await inbound();
      const before = await db().customer.findUniqueOrThrow({
        where: { normalizedPhone: `+${phone}` },
      });
      await Promise.all(
        Array.from({ length: 10 }, () =>
          webhook(payload([message])).expect(200),
        ),
      );
      expect(
        await db().message.count({ where: { externalMessageId: message.id } }),
      ).toBe(1);
      expect(
        await db().messagingOutbox.count({ where: { messageId: row.id } }),
      ).toBe(1);
      const after = await db().customer.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.lastContactAt).toEqual(before.lastContactAt);
      const conversation = await db().conversation.findUniqueOrThrow({
        where: { id: row.conversationId },
      });
      expect(conversation.lastSequence).toBe(1);
    });
    it('metadatos media y mensajes no compatibles llegan al core', async () => {
      const { message } = await inbound();
      const imageId = `wamid.${randomUUID()}`;
      const docId = `wamid.${randomUUID()}`;
      const audioId = `wamid.${randomUUID()}`;
      await webhook(
        payload([
          {
            ...message,
            id: imageId,
            type: 'image',
            image: {
              id: 'media-img',
              mime_type: 'image/jpeg',
              caption: 'Carta',
            },
          },
          {
            ...message,
            id: docId,
            type: 'document',
            document: {
              id: 'media-doc',
              mime_type: 'application/pdf',
              filename: 'carta.pdf',
            },
          },
          { ...message, id: audioId, type: 'audio' },
        ]),
      ).expect(200);
      const rows = await db().message.findMany({
        where: { externalMessageId: { in: [imageId, docId, audioId] } },
        include: { attachments: true },
      });
      expect(rows).toHaveLength(3);
      expect(
        rows.find((r) => r.type === 'IMAGE')?.attachments[0].externalMediaId,
      ).toBe('media-img');
      expect(rows.find((r) => r.type === 'FILE')?.attachments[0].fileName).toBe(
        'carta.pdf',
      );
      expect(rows.find((r) => r.type === 'OTHER')?.content).toBeTruthy();
    });
    it.each([RoleCode.ADMIN, RoleCode.OPERATOR])(
      '%s encola sin enviar dentro del request',
      async (role) => {
        const { row, phone } = await inbound();
        const result = await enqueue(row.conversationId, randomUUID(), role);
        expect(result.status).toBe('QUEUED');
        expect(send).not.toHaveBeenCalled();
        const stored = await db().message.findUniqueOrThrow({
          where: { id: result.id },
          include: { outbox: true },
        });
        expect(stored).toMatchObject({
          direction: 'OUTBOUND',
          recipientPhone: `+${phone}`,
          providerAccountId: '123',
          outbox: { status: 'PENDING' },
        });
        expect(result).not.toHaveProperty('recipientPhone');
      },
    );
    it.each([RoleCode.OWNER, RoleCode.SUPPORT])(
      '%s no puede responder',
      async (role) => {
        const { row } = await inbound();
        await request(c.server())
          .post(`/conversations/${row.conversationId}/messages`)
          .set('Authorization', c.auth(role))
          .set('Idempotency-Key', randomUUID())
          .send({ type: 'TEXT', content: 'Hola' })
          .expect(403);
      },
    );
    it('sin token 401; header ausente/body arbitrario 400', async () => {
      const { row } = await inbound();
      const url = `/conversations/${row.conversationId}/messages`;
      await request(c.server())
        .post(url)
        .send({ type: 'TEXT', content: 'Hola' })
        .expect(401);
      await request(c.server())
        .post(url)
        .set('Authorization', c.auth())
        .send({ type: 'TEXT', content: 'Hola' })
        .expect(400);
      await request(c.server())
        .post(url)
        .set('Authorization', c.auth())
        .set('Idempotency-Key', randomUUID())
        .send({
          type: 'TEXT',
          content: 'Hola',
          to: 'other',
          authorUserId: randomUUID(),
        })
        .expect(400);
    });
    it('idempotencia HTTP concurrente; misma clave distinto contenido 409', async () => {
      const { row } = await inbound();
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => enqueue(row.conversationId, key)),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(
        await db().message.count({
          where: { conversationId: row.conversationId, direction: 'OUTBOUND' },
        }),
      ).toBe(1);
      await request(c.server())
        .post(`/conversations/${row.conversationId}/messages`)
        .set('Authorization', c.auth())
        .set('Idempotency-Key', key)
        .send({ type: 'TEXT', content: 'Otro contenido' })
        .expect(409);
    });
    it('worker repetido/concurrente produce un envío y guarda wamid', async () => {
      const { row, phone } = await inbound();
      const outbound = await enqueue(row.conversationId);
      await Promise.all(
        Array.from({ length: 5 }, () => processor().process(outbound.id)),
      );
      await processor().process(outbound.id);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        `+${phone}`,
        'Hola, somos Sabor Mágico Grill.',
      );
      const stored = await db().message.findUniqueOrThrow({
        where: { id: outbound.id },
      });
      expect(stored.status).toBe('SENT');
      expect(stored.externalMessageId).toMatch(/^wamid\./);
      expect(stored.processingAttempts).toBe(1);
    });
    it('timeout ambiguo queda UNKNOWN y no vuelve a enviar', async () => {
      const { row } = await inbound();
      const outbound = await enqueue(row.conversationId);
      send.mockRejectedValue(new WhatsAppSendError('unknown'));
      await processor().process(outbound.id);
      await processor().process(outbound.id);
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        await db().message.findUniqueOrThrow({ where: { id: outbound.id } }),
      ).toMatchObject({
        status: 'UNKNOWN',
        errorCode: 'WHATSAPP_SEND_UNKNOWN',
      });
    });
    it('SENDING abandonado se recupera como UNKNOWN sin enviar', async () => {
      const { row } = await inbound();
      const outbound = await enqueue(row.conversationId);
      await db().message.update({
        where: { id: outbound.id },
        data: {
          status: 'SENDING',
          processingToken: randomUUID(),
          processingUntil: new Date(0),
          processingAttempts: 1,
        },
      });
      await processor().process(outbound.id);
      expect(send).not.toHaveBeenCalled();
      expect(
        await db().message.findUniqueOrThrow({ where: { id: outbound.id } }),
      ).toMatchObject({ status: 'UNKNOWN' });
    });
    it('429 respeta backoff persistente y reintenta; 4xx falla definitivamente', async () => {
      const { row } = await inbound();
      const outbound = await enqueue(row.conversationId);
      send.mockRejectedValueOnce(new WhatsAppSendError('retry', 30000));
      expect(await processor().process(outbound.id)).toBe('busy');
      await processor().process(outbound.id);
      expect(send).toHaveBeenCalledTimes(1);
      const outbox = await db().messagingOutbox.findUniqueOrThrow({
        where: { messageId: outbound.id },
      });
      expect(outbox.availableAt.getTime()).toBeGreaterThan(Date.now() + 25000);
      await db().messagingOutbox.update({
        where: { messageId: outbound.id },
        data: { availableAt: new Date(0) },
      });
      send.mockRejectedValueOnce(new WhatsAppSendError('failed'));
      await processor().process(outbound.id);
      await processor().process(outbound.id);
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        await db().message.findUniqueOrThrow({ where: { id: outbound.id } }),
      ).toMatchObject({ status: 'FAILED', processingAttempts: 2 });
    });
    it('reintentos limitados a cinco POST, incluso con nuevos jobs', async () => {
      const { row } = await inbound();
      const outbound = await enqueue(row.conversationId);
      send.mockRejectedValue(new WhatsAppSendError('retry'));
      for (let attempt = 0; attempt < 7; attempt++) {
        await db().messagingOutbox.update({
          where: { messageId: outbound.id },
          data: { availableAt: new Date(0) },
        });
        await processor().process(outbound.id);
      }
      expect(send).toHaveBeenCalledTimes(5);
      expect(
        await db().message.findUniqueOrThrow({ where: { id: outbound.id } }),
      ).toMatchObject({ status: 'FAILED', processingAttempts: 5 });
    });
    it('estado temprano queda pendiente y luego concilia sin degradación', async () => {
      const { row } = await inbound();
      const outbound = await enqueue(row.conversationId);
      const wamid = `wamid.${randomUUID()}`;
      const receipt = {
        id: wamid,
        status: 'read',
        timestamp: String(Math.floor(Date.now() / 1000)),
      };
      await webhook(payload([], [receipt, receipt])).expect(200);
      await statuses().reconcileOnce();
      expect(
        await db().messageStatusEvent.count({
          where: { externalMessageId: wamid },
        }),
      ).toBe(1);
      expect(
        await db().messageStatusEvent.findFirst({
          where: { externalMessageId: wamid },
        }),
      ).toMatchObject({ processedAt: null });
      send.mockResolvedValueOnce(wamid);
      await processor().process(outbound.id);
      await db().messageStatusEvent.updateMany({
        where: { externalMessageId: wamid },
        data: { availableAt: new Date(0) },
      });
      await statuses().reconcileOnce();
      await webhook(
        payload(
          [],
          [
            { ...receipt, status: 'sent' },
            { ...receipt, status: 'delivered' },
            { ...receipt, status: 'failed' },
          ],
        ),
      ).expect(200);
      await statuses().reconcileOnce();
      const stored = await db().message.findUniqueOrThrow({
        where: { id: outbound.id },
      });
      expect(stored).toMatchObject({
        status: 'READ',
        readAt: null,
        failedAt: null,
      });
      expect(stored.providerReadAt).not.toBeNull();
      expect(stored.deliveredAt).not.toBeNull();
    });
    it('FAILED del proveedor no se convierte en SENT por evento retrasado', async () => {
      const { row } = await inbound();
      const outbound = await enqueue(row.conversationId);
      await processor().process(outbound.id);
      const stored = await db().message.findUniqueOrThrow({
        where: { id: outbound.id },
      });
      const receipt = {
        id: stored.externalMessageId,
        timestamp: String(Math.floor(Date.now() / 1000)),
      };
      await webhook(payload([], [{ ...receipt, status: 'failed' }])).expect(
        200,
      );
      await statuses().reconcileOnce();
      await webhook(payload([], [{ ...receipt, status: 'sent' }])).expect(200);
      await statuses().reconcileOnce();
      expect(
        await db().message.findUniqueOrThrow({ where: { id: outbound.id } }),
      ).toMatchObject({ status: 'FAILED' });
    });
    it('ventana cerrada bloquea HTTP y caducidad durante cola bloquea el worker', async () => {
      const { row } = await inbound(25 * 3600000);
      await request(c.server())
        .post(`/conversations/${row.conversationId}/messages`)
        .set('Authorization', c.auth())
        .set('Idempotency-Key', randomUUID())
        .send({ type: 'TEXT', content: 'Hola' })
        .expect(409);
      const fresh = await inbound();
      const outbound = await enqueue(fresh.row.conversationId);
      await db().message.update({
        where: { id: fresh.row.id },
        data: { occurredAt: new Date(Date.now() - 25 * 3600000) },
      });
      await processor().process(outbound.id);
      expect(send).not.toHaveBeenCalled();
      expect(
        await db().message.findUniqueOrThrow({ where: { id: outbound.id } }),
      ).toMatchObject({
        status: 'FAILED',
        errorCode: 'WHATSAPP_WINDOW_CLOSED',
      });
    });
    it('editar teléfono no modifica destino encolado ni abre ventana para otro contacto', async () => {
      const { row, phone } = await inbound();
      const outbound = await enqueue(row.conversationId);
      const conversation = await db().conversation.findUniqueOrThrow({
        where: { id: row.conversationId },
      });
      await db().customer.update({
        where: { id: conversation.customerId },
        data: { normalizedPhone: `+519${randomInt(10000000, 99999999)}` },
      });
      await processor().process(outbound.id);
      expect(send).toHaveBeenCalledWith(`+${phone}`, expect.any(String));
      await request(c.server())
        .post(`/conversations/${row.conversationId}/messages`)
        .set('Authorization', c.auth())
        .set('Idempotency-Key', randomUUID())
        .send({ type: 'TEXT', content: 'Otro' })
        .expect(409);
    });
    it('Redis caído deja envío durable y dispatcher recupera dirección OUTBOUND', async () => {
      const { row } = await inbound();
      const outbound = await enqueue(row.conversationId);
      const publish = jest
        .spyOn(c.app().get(MessagingQueueService), 'publish')
        .mockRejectedValue(new Error('private'));
      try {
        await c.app().get(MessagingOutboxService).dispatchOnce();
        expect(
          await db().messagingOutbox.findUniqueOrThrow({
            where: { messageId: outbound.id },
          }),
        ).toMatchObject({
          status: 'PENDING',
          lastErrorCode: 'QUEUE_UNAVAILABLE',
        });
        expect(send).not.toHaveBeenCalled();
        await db().messagingOutbox.update({
          where: { messageId: outbound.id },
          data: { availableAt: new Date(0) },
        });
        publish.mockImplementation(async (id, direction) => {
          if (direction === 'OUTBOUND') await processor().process(id);
        });
        await c.app().get(MessagingOutboxService).dispatchOnce();
        expect(publish).toHaveBeenCalledWith(outbound.id, 'OUTBOUND');
        expect(
          await db().message.findUniqueOrThrow({ where: { id: outbound.id } }),
        ).toMatchObject({ status: 'SENT' });
      } finally {
        publish.mockRestore();
      }
    });

    const restartTest =
      process.env.MESSAGING_REDIS_RESTART_INTEGRATION === '1' ? it : it.skip;
    restartTest(
      'Redis aislado: caída abrupta, AOF, outbox y reconexión sin duplicar',
      async () => {
        const broker = new IsolatedRedis();
        let queue: MessagingQueueService | undefined;
        const inspectors: Queue[] = [];
        try {
          await broker.create();
          const prefix = `test-recovery-${randomUUID()}`;
          const config = new ConfigService({
            REDIS_URL: broker.url,
            MESSAGING_QUEUE_PREFIX: prefix,
          });
          queue = new MessagingQueueService(config);
          for (const name of [INBOUND_QUEUE, OUTBOUND_QUEUE]) {
            const inspector = new Queue(name, {
              connection: redisConnection(broker.url),
              prefix,
            });
            // Connection errors are expected while the dedicated broker is down.
            inspector.on('error', () => undefined);
            inspectors.push(inspector);
            await inspector.waitUntilReady();
            await inspector.pause();
          }
          const core = c.app().get(MessageProcessorService);
          queue.start(core, processor());
          const dispatcher = new MessagingOutboxService(
            c.app().get(PrismaService),
            queue,
            core,
            config,
          );
          const first = await inbound();
          const firstOutbound = await enqueue(first.row.conversationId);
          await dispatcher.dispatchOnce();
          const firstIds = [first.row.id, firstOutbound.id];
          for (const id of firstIds) {
            expect(
              await db().messagingOutbox.findUniqueOrThrow({
                where: { messageId: id },
              }),
            ).toMatchObject({ status: 'PUBLISHED' });
          }
          // Jobs were persisted while both queues were paused; crash the real broker.
          await broker.crash();
          await broker.start();
          for (let index = 0; index < inspectors.length; index++) {
            await eventually(async () => {
              try {
                return await inspectors[index].isPaused();
              } catch {
                return false;
              }
            });
            expect(
              await inspectors[index].getJob(
                `${index === 0 ? 'inbound' : 'outbound'}-${firstIds[index]}`,
              ),
            ).not.toBeUndefined();
            await inspectors[index].resume();
          }
          const waitProcessed = async (ids: string[]) => {
            await eventually(async () => {
              const rows = await db().message.findMany({
                where: { id: { in: ids } },
              });
              return (
                rows.length === 2 &&
                rows.every(
                  (row) =>
                    row.status ===
                    (row.direction === 'INBOUND' ? 'PROCESSED' : 'SENT'),
                )
              );
            }, 45000).catch(async () => {
              const states = await db().message.findMany({
                where: { id: { in: ids } },
                select: {
                  direction: true,
                  status: true,
                  errorCode: true,
                  processingAttempts: true,
                },
              });
              throw new Error(`Recovery states: ${JSON.stringify(states)}`);
            });
            for (const id of ids) {
              expect(
                await db().messagingOutbox.findUniqueOrThrow({
                  where: { messageId: id },
                }),
              ).toMatchObject({ status: 'COMPLETED' });
              expect(
                await db().message.findUniqueOrThrow({ where: { id } }),
              ).toMatchObject({ processingAttempts: 1 });
            }
          };
          await waitProcessed(firstIds);

          // Persist new HTTP input/output while Redis is really offline.
          await broker.crash();
          const second = await inbound();
          const secondOutbound = await enqueue(second.row.conversationId);
          const secondIds = [second.row.id, secondOutbound.id];
          await dispatcher.dispatchOnce();
          for (const id of secondIds) {
            expect(
              await db().messagingOutbox.findUniqueOrThrow({
                where: { messageId: id },
              }),
            ).toMatchObject({
              status: 'PENDING',
              lastErrorCode: 'QUEUE_UNAVAILABLE',
            });
            expect(
              await db().message.findUniqueOrThrow({ where: { id } }),
            ).toMatchObject({ processingAttempts: 0 });
          }
          await broker.start();
          await eventually(async () => {
            await dispatcher.dispatchOnce();
            return (
              (
                await db().message.findUniqueOrThrow({
                  where: { id: secondOutbound.id },
                })
              ).status === 'SENT'
            );
          });
          await waitProcessed(secondIds);

          // Real queue retry of a completed job must not repeat the provider call.
          await eventually(
            async () =>
              (await inspectors[1].getJob(`outbound-${secondOutbound.id}`))
                ?.getState()
                .then((state) => state === 'completed') ?? false,
          );
          await queue.publish(secondOutbound.id, 'OUTBOUND');
          await eventually(
            async () =>
              (await inspectors[1].getJob(`outbound-${secondOutbound.id}`))
                ?.getState()
                .then((state) => state === 'completed') ?? false,
          );
          for (const phone of [first.phone, second.phone]) {
            expect(
              send.mock.calls.filter(
                (call: unknown[]) => call[0] === `+${phone}`,
              ),
            ).toHaveLength(1);
          }
        } finally {
          try {
            // Restore this broker before closing reconnecting BullMQ clients.
            if (queue) await broker.start();
            await queue?.onModuleDestroy();
            await Promise.all(inspectors.map((inspector) => inspector.close()));
          } finally {
            await broker.remove();
          }
        }
      },
      180000,
    );
  });
}
