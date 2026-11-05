import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { PrismaClient } from '../generated/prisma/client';
import { MessengerConfig } from '../src/messenger/messenger.config';
import { MessengerAdapter } from '../src/messenger/messenger.adapter';
import { OutboundMessagesService } from '../src/messaging/outbound-messages.service';
import { MessageStatusService } from '../src/messaging/message-status.service';
import { MessageProcessorService } from '../src/messaging/message-processor.service';
import { WhatsAppConfig } from '../src/whatsapp/whatsapp.config';
import { ChannelSendError } from '../src/messaging/channel-transport';

export const messengerTestConfig = new MessengerConfig(
  new ConfigService({
    MESSENGER_ENABLED: 'true',
    MESSAGING_ENABLED: 'true',
    REDIS_URL: 'redis://localhost:6379',
    MESSENGER_PAGE_ID: '321',
    MESSENGER_PAGE_ACCESS_TOKEN: 'fake-token',
    MESSENGER_VERIFY_TOKEN: 'fake-verify',
    META_APP_SECRET: 'fake-secret',
    MESSENGER_API_VERSION: 'v26.0',
  }),
);
interface Context {
  app: () => INestApplication;
  prisma: () => PrismaClient;
  server: () => App;
  auth: () => string;
}
export function registerMessengerTests(c: Context) {
  const webhook = (items: unknown[], valid = true) => {
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: '321', messaging: items }],
    });
    return request(c.server())
      .post('/webhooks/messenger')
      .set('Content-Type', 'application/json')
      .set(
        'X-Hub-Signature-256',
        'sha256=' +
          createHmac('sha256', valid ? 'fake-secret' : 'wrong')
            .update(raw)
            .digest('hex'),
      )
      .send(raw);
  };
  const inbound = async (age = 0) => {
    const mid = 'mid.' + randomUUID();
    const psid = String(randomInt(10000000, 99999999));
    const item = {
      sender: { id: psid },
      recipient: { id: '321' },
      timestamp: Date.now() - age,
      message: { mid, text: 'Hola Messenger' },
    };
    await webhook([item]).expect(200);
    const row = await c.prisma().message.findUniqueOrThrow({
      where: {
        channel_externalMessageId: {
          channel: 'FACEBOOK',
          externalMessageId: mid,
        },
      },
    });
    return { row, psid, item };
  };
  const enqueue = (
    conversationId: string,
    key = randomUUID(),
    content = 'Respuesta Messenger',
  ) =>
    request(c.server())
      .post(`/conversations/${conversationId}/messages`)
      .set('Authorization', c.auth())
      .set('Idempotency-Key', key)
      .send({ type: 'TEXT', content });
  describe('Messenger: PostgreSQL y HTTP reales, Meta simulado', () => {
    let send: jest.SpyInstance;
    let senderName: jest.SpyInstance;
    beforeEach(() => {
      send = jest
        .spyOn(c.app().get(MessengerAdapter), 'sendMessage')
        .mockResolvedValue('mid.' + randomUUID());
      senderName = jest
        .spyOn(c.app().get(MessengerAdapter), 'fetchSenderName')
        .mockResolvedValue(null);
    });
    afterEach(() => {
      send.mockRestore();
      senderName.mockRestore();
    });
    it('names a new customer from the sender of its first message, never over a CRM name', async () => {
      senderName.mockResolvedValueOnce('Ana Quispe');
      const { row, psid } = await inbound();
      expect(senderName).toHaveBeenCalledWith(row.externalMessageId, psid);
      const conversation = await c.prisma().conversation.findUniqueOrThrow({
        where: { id: row.conversationId },
        include: { customer: true },
      });
      expect(conversation.customer.firstName).toBe('Ana Quispe');
      await request(c.server())
        .patch(`/customers/${conversation.customerId}`)
        .set('Authorization', c.auth())
        .send({ firstName: 'Nombre del CRM' })
        .expect(200);
      senderName.mockClear();
      await webhook([
        {
          sender: { id: psid },
          recipient: { id: '321' },
          timestamp: Date.now(),
          message: { mid: 'mid.' + randomUUID(), text: 'Otra vez' },
        },
      ]).expect(200);
      expect(senderName).not.toHaveBeenCalled();
      expect(
        (
          await c.prisma().customer.findUniqueOrThrow({
            where: { id: conversation.customerId },
          })
        ).firstName,
      ).toBe('Nombre del CRM');
    });
    it('stores real UTC instants, independent of the database time zone', async () => {
      const before = Date.now();
      const { row } = await inbound();
      const [stored] = await c.prisma().$queryRaw<
        { createdAt: number; occurredAt: number }[]
      >`SELECT extract(epoch FROM "createdAt")::float8 AS "createdAt",
               extract(epoch FROM "occurredAt")::float8 AS "occurredAt"
          FROM messages WHERE id = ${row.id}`;
      // Before the UTC sessions, America/Bogota servers stored these 5 h in the future.
      expect(stored.createdAt * 1000).toBeGreaterThanOrEqual(before - 1000);
      expect(stored.createdAt * 1000).toBeLessThanOrEqual(Date.now() + 1000);
      expect(stored.occurredAt * 1000).toBeCloseTo(
        row.occurredAt!.getTime(),
        0,
      );
    });
    it('verifies GET and rejects unsigned/tampered POST without creating contacts', async () => {
      await request(c.server())
        .get('/webhooks/messenger')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'fake-verify',
          'hub.challenge': 'test',
        })
        .expect(200, 'test');
      await request(c.server())
        .post('/webhooks/messenger')
        .send({})
        .expect(403);
      await webhook([], false).expect(403);
    });
    it('persists a provider-only customer, deduplicates concurrent receipts and processes the outbox message', async () => {
      const { row, item, psid } = await inbound();
      await Promise.all([
        webhook([item]).expect(200),
        webhook([item]).expect(200),
      ]);
      expect(
        await c
          .prisma()
          .message.count({ where: { conversationId: row.conversationId } }),
      ).toBe(1);
      const conversation = await c.prisma().conversation.findUniqueOrThrow({
        where: { id: row.conversationId },
        include: { customer: true },
      });
      expect(conversation.customer).toMatchObject({
        phone: null,
        email: null,
        providerAccountId: '321',
        externalContactId: psid,
      });
      expect(conversation.lastSequence).toBe(1);
      await request(c.server())
        .patch(`/customers/${conversation.customerId}`)
        .set('Authorization', c.auth())
        .send({ firstName: 'Cliente Messenger' })
        .expect(200);
      await request(c.server())
        .patch(`/customers/${conversation.customerId}`)
        .set('Authorization', c.auth())
        .send({ sourceChannel: 'WHATSAPP' })
        .expect(400);
      await c.app().get(MessageProcessorService).process(row.id);
      expect(
        (await c.prisma().message.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe('PROCESSED');
      await request(c.server())
        .get(`/conversations/${row.conversationId}/messages`)
        .set('Authorization', c.auth())
        .expect(200);
    });
    it('queues idempotently, sends to the PSID and reconciles an early delivery without resending', async () => {
      const { row, psid } = await inbound();
      const key = randomUUID();
      const response = await enqueue(row.conversationId, key).expect(202);
      const outbound = response.body as { id: string };
      const duplicate = await enqueue(row.conversationId, key).expect(202);
      expect((duplicate.body as { id: string }).id).toBe(outbound.id);
      await enqueue(row.conversationId, key, 'Different').expect(409);
      const mid = 'mid.' + randomUUID();
      send.mockResolvedValueOnce(mid);
      await webhook([
        {
          sender: { id: psid },
          recipient: { id: '321' },
          timestamp: Date.now(),
          delivery: { mids: [mid], watermark: Date.now() },
        },
      ]).expect(200);
      await c.app().get(MessageStatusService).reconcileOnce();
      await c.app().get(OutboundMessagesService).process(outbound.id);
      expect(send).toHaveBeenCalledWith(
        { recipientPhone: null, recipientExternalId: psid },
        'Respuesta Messenger',
      );
      await c.prisma().messageStatusEvent.updateMany({
        where: { externalMessageId: mid },
        data: { availableAt: new Date(0) },
      });
      await c.app().get(MessageStatusService).reconcileOnce();
      expect(
        (
          await c
            .prisma()
            .message.findUniqueOrThrow({ where: { id: outbound.id } })
        ).status,
      ).toBe('DELIVERED');
      await c.app().get(OutboundMessagesService).process(outbound.id);
      expect(send).toHaveBeenCalledTimes(1);
    });
    it('confirms replies through delivery watermarks, only those sent up to the watermark', async () => {
      const customer = await inbound();
      const other = await inbound();
      const reply = async (conversationId: string) => {
        const response = await enqueue(conversationId).expect(202);
        const id = (response.body as { id: string }).id;
        const mid = 'mid.' + randomUUID();
        send.mockResolvedValueOnce(mid);
        await c.app().get(OutboundMessagesService).process(id);
        return { id, mid };
      };
      const listed = await reply(customer.row.conversationId);
      const skewed = await reply(customer.row.conversationId);
      const later = await reply(customer.row.conversationId);
      const otherCustomer = await reply(other.row.conversationId);
      const stored = (id: string) =>
        c.prisma().message.findUniqueOrThrow({ where: { id } });
      // Meta accepted before its response reached us (sentAt is recorded after the POST).
      const watermark = (await stored(listed.id)).sentAt!.getTime() - 300;
      const setSentAt = (id: string, at: number) =>
        c.prisma().message.update({
          where: { id },
          data: { sentAt: new Date(at) },
        });
      await setSentAt(skewed.id, watermark + 1000); // slow response or clock skew: covered
      await setSentAt(later.id, watermark + 3000); // beyond the margin: not covered
      const deliveredAt = watermark + 5000;
      await webhook([
        {
          sender: { id: customer.psid },
          recipient: { id: '321' },
          timestamp: deliveredAt,
          delivery: { mids: [listed.mid], watermark },
        },
      ]).expect(200);
      await c.app().get(MessageStatusService).reconcileOnce();
      for (const id of [listed.id, skewed.id]) {
        const message = await stored(id);
        expect(message.status).toBe('DELIVERED');
        expect(message.deliveredAt).toEqual(new Date(deliveredAt));
      }
      expect((await stored(later.id)).status).toBe('SENT');
      expect((await stored(otherCustomer.id)).status).toBe('SENT');
      expect(
        await c.prisma().messageStatusEvent.count({
          where: { externalMessageId: listed.mid },
        }),
      ).toBe(1);
    });
    it('rejects closed windows, excessive text and recipients from another page', async () => {
      const old = await inbound(25 * 3600000);
      await enqueue(old.row.conversationId).expect(409);
      const { row } = await inbound();
      await enqueue(row.conversationId, randomUUID(), 'x'.repeat(2001)).expect(
        400,
      );
      const conversation = await c
        .prisma()
        .conversation.findUniqueOrThrow({ where: { id: row.conversationId } });
      await c.prisma().customer.update({
        where: { id: conversation.customerId },
        data: { providerAccountId: '999' },
      });
      await enqueue(row.conversationId).expect(400);
      expect(send).not.toHaveBeenCalled();
    });
    it('a repeated message ID with a different sender is quarantined, not merged', async () => {
      const { row, item } = await inbound();
      await webhook([{ ...item, sender: { id: '999999' } }]).expect(200);
      expect(
        await c
          .prisma()
          .message.count({ where: { conversationId: row.conversationId } }),
      ).toBe(1);
      expect(
        await c.prisma().messagingWebhookRejection.count({
          where: { code: 'MESSENGER_EVENT_INVALID' },
        }),
      ).toBeGreaterThan(0);
    });
    it('can send Messenger even when WhatsApp is disabled', async () => {
      const { row } = await inbound();
      const response = await enqueue(row.conversationId).expect(202);
      const wa = c.app().get(WhatsAppConfig);
      const previous = wa.enabled;
      Object.defineProperty(wa, 'enabled', {
        value: false,
        configurable: true,
      });
      try {
        await c
          .app()
          .get(OutboundMessagesService)
          .process((response.body as { id: string }).id);
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(wa, 'enabled', {
          value: previous,
          configurable: true,
        });
      }
    });
    it.each(['failed', 'unknown'] as const)(
      'persists %s outcomes and never blindly resends them',
      async (outcome) => {
        const { row } = await inbound();
        const response = await enqueue(row.conversationId).expect(202);
        const id = (response.body as { id: string }).id;
        send.mockRejectedValueOnce(new ChannelSendError(outcome));
        await c.app().get(OutboundMessagesService).process(id);
        expect(
          (await c.prisma().message.findUniqueOrThrow({ where: { id } }))
            .status,
        ).toBe(outcome.toUpperCase());
        await c.app().get(OutboundMessagesService).process(id);
        expect(send).toHaveBeenCalledTimes(1);
      },
    );
    it('only retries explicit rate limits, respecting the durable delay', async () => {
      const { row } = await inbound();
      const response = await enqueue(row.conversationId).expect(202);
      const id = (response.body as { id: string }).id;
      send.mockRejectedValueOnce(new ChannelSendError('retry', 60000));
      await c.app().get(OutboundMessagesService).process(id);
      const stored = await c.prisma().message.findUniqueOrThrow({
        where: { id },
        include: { outbox: true },
      });
      expect(stored.status).toBe('QUEUED');
      expect(stored.errorCode).toBe('MESSENGER_RATE_LIMITED');
      expect(stored.outbox!.availableAt.getTime()).toBeGreaterThan(Date.now());
      await c.app().get(OutboundMessagesService).process(id);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
}
