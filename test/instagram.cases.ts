import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { PrismaClient } from '../generated/prisma/client';
import { InstagramConfig } from '../src/instagram/instagram.config';
import { MessageProcessorService } from '../src/messaging/message-processor.service';
import { InstagramAdapter } from '../src/instagram/instagram.adapter';
import { OutboundMessagesService } from '../src/messaging/outbound-messages.service';

export const instagramTestConfig = new InstagramConfig(
  new ConfigService({
    INSTAGRAM_ENABLED: 'true',
    MESSAGING_ENABLED: 'true',
    REDIS_URL: 'redis://localhost:6379',
    INSTAGRAM_ACCOUNT_ID: '789',
    INSTAGRAM_VERIFY_TOKEN: 'fake-verify',
    META_APP_SECRET: 'fake-secret',
    INSTAGRAM_ACCESS_TOKEN: 'fake-instagram-token',
    INSTAGRAM_API_VERSION: 'v26.0',
  }),
);

export function registerInstagramTests(c: {
  app: () => INestApplication;
  prisma: () => PrismaClient;
  server: () => App;
  auth: () => string;
}) {
  describe('Instagram: PostgreSQL y HTTP reales, Meta simulado', () => {
    it('persists a DM without phone/email, deduplicates retries and protects provider identity', async () => {
      const mid = 'mid.' + randomUUID();
      const raw = JSON.stringify({
        object: 'instagram',
        entry: [
          {
            id: '789',
            messaging: [
              {
                sender: { id: '456789' },
                recipient: { id: '789' },
                timestamp: Date.now(),
                message: { mid, text: 'Hola Instagram' },
              },
            ],
          },
        ],
      });
      const post = () =>
        request(c.server())
          .post('/webhooks/instagram')
          .set('Content-Type', 'application/json')
          .set(
            'X-Hub-Signature-256',
            'sha256=' +
              createHmac('sha256', 'fake-secret').update(raw).digest('hex'),
          )
          .send(raw)
          .expect(200);
      await post();
      await Promise.all([post(), post()]);
      const row = await c.prisma().message.findUniqueOrThrow({
        where: {
          channel_externalMessageId: {
            channel: 'INSTAGRAM',
            externalMessageId: mid,
          },
        },
      });
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
        sourceChannel: 'INSTAGRAM',
        phone: null,
        email: null,
        providerAccountId: '789',
        externalContactId: '456789',
      });
      expect(conversation.lastSequence).toBe(1);
      await request(c.server())
        .patch(`/customers/${conversation.customerId}`)
        .set('Authorization', c.auth())
        .send({ firstName: 'Cliente Instagram' })
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
    it('responde al IGSID dentro de la ventana; límite en bytes y ventana cerrada', async () => {
      const igsid = String(randomInt(100000000, 999999999));
      const mid = 'mid.' + randomUUID();
      const raw = JSON.stringify({
        object: 'instagram',
        entry: [
          {
            id: '789',
            messaging: [
              {
                sender: { id: igsid },
                recipient: { id: '789' },
                timestamp: Date.now(),
                message: { mid, text: 'Hola, ¿tienen mesa?' },
              },
            ],
          },
        ],
      });
      await request(c.server())
        .post('/webhooks/instagram')
        .set('Content-Type', 'application/json')
        .set(
          'X-Hub-Signature-256',
          'sha256=' +
            createHmac('sha256', 'fake-secret').update(raw).digest('hex'),
        )
        .send(raw)
        .expect(200);
      const inbound = await c.prisma().message.findUniqueOrThrow({
        where: {
          channel_externalMessageId: {
            channel: 'INSTAGRAM',
            externalMessageId: mid,
          },
        },
      });
      const send = jest
        .spyOn(c.app().get(InstagramAdapter), 'sendMessage')
        .mockResolvedValue('mid.out.' + randomUUID());
      try {
        const reply = (content: string) =>
          request(c.server())
            .post(`/conversations/${inbound.conversationId}/messages`)
            .set('Authorization', c.auth())
            .set('Idempotency-Key', randomUUID())
            .send({ type: 'TEXT', content });
        const accepted = await reply('Sí, los esperamos.').expect(202);
        const outboundId = (accepted.body as { id: string }).id;
        await c.app().get(OutboundMessagesService).process(outboundId);
        expect(send).toHaveBeenCalledWith(
          { recipientPhone: null, recipientExternalId: igsid },
          'Sí, los esperamos.',
        );
        expect(
          await c.prisma().message.findUniqueOrThrow({
            where: { id: outboundId },
          }),
        ).toMatchObject({
          status: 'SENT',
          recipientExternalId: igsid,
          providerAccountId: '789',
        });
        // 600 characters, 1200 bytes: under the character limit, over Instagram's bytes.
        const tooLong = await reply('á'.repeat(600)).expect(400);
        expect(JSON.stringify(tooLong.body)).toContain('bytes');
        await c.prisma().message.update({
          where: { id: inbound.id },
          data: { occurredAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
        });
        await reply('¿Siguen ahí?').expect(409);
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        send.mockRestore();
      }
    });
  });
}
