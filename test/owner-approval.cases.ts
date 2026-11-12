import { randomInt, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { PrismaClient } from '../generated/prisma/client';
import { DayOfWeek, RoleCode } from '../generated/prisma/enums';
import { SAMANTA_USER_ID } from '../src/common/constants/system-users.constants';
import { InstagramAdapter } from '../src/instagram/instagram.adapter';
import {
  ChannelSendError,
  type ChannelAddress,
} from '../src/messaging/channel-transport';
import { MessageProcessorService } from '../src/messaging/message-processor.service';
import { MessagesService } from '../src/messaging/messages.service';
import { OutboundMessagesService } from '../src/messaging/outbound-messages.service';
import { MessengerAdapter } from '../src/messenger/messenger.adapter';
import { OwnerApprovalConfig } from '../src/owner-approval/owner-approval.config';
import { OwnerApprovalService } from '../src/owner-approval/owner-approval.service';
import { SamantaReservationService } from '../src/samanta/samanta-reservations';
import { WhatsAppAdapter } from '../src/whatsapp/whatsapp.adapter';
import { eventually } from './isolated-redis';
import { samantaTestConfig } from './samanta.cases';

interface Context {
  app: () => INestApplication;
  prisma: () => PrismaClient;
  server: () => App;
  auth: (role?: RoleCode) => string;
}
const OWNER_NUMBER = '+51987000111';

// M9.1 with PostgreSQL, the real outbox and WhatsApp simulated (sendTemplate is spied).
// The service's own timer is off in tests: dispatch() and reconcile() are called here.
export function registerOwnerApprovalTests(c: Context) {
  describe('M9.1: solicitudes al WhatsApp del propietario', () => {
    const db = () => c.prisma();
    const service = () => c.app().get(OwnerApprovalService);
    const adapter = () => c.app().get(WhatsAppAdapter);
    let previous: {
      ownerWhatsappNumber: string | null;
      approvalResponsibleId: string | null;
    };
    let customerId: string;
    beforeAll(async () => {
      previous = await db().restaurantConfig.findUniqueOrThrow({
        where: { scope: 'GLOBAL' },
        select: { ownerWhatsappNumber: true, approvalResponsibleId: true },
      });
      const owner = await db().user.findUniqueOrThrow({
        where: { email: 'owner@test.example' },
        select: { id: true },
      });
      await db().restaurantConfig.update({
        where: { scope: 'GLOBAL' },
        data: {
          ownerWhatsappNumber: OWNER_NUMBER,
          approvalResponsibleId: owner.id,
        },
      });
      const phone = `+5198${randomInt(1000000, 9999999)}`;
      customerId = (
        await db().customer.create({
          data: {
            firstName: 'Lucía',
            lastName: 'Rojas',
            phone,
            normalizedPhone: phone,
            sourceChannel: 'WEBSITE',
          },
        })
      ).id;
      // Earlier suites (email, Samanta) leave website and Samanta requests behind: they
      // are notified now, in batches, so that each test below only sees its own requests.
      jest.replaceProperty(
        c.app().get(OwnerApprovalConfig),
        'textFallback',
        false,
      );
      jest
        .spyOn(adapter(), 'sendTemplate')
        .mockRejectedValue(new ChannelSendError('retry', 60000));
      for (let round = 0; round < 20; round++)
        if (!(await service().dispatch())) break;
      await settle();
      jest.restoreAllMocks();
    });
    // The developer's .env may have the temporary text mode on: these tests use the
    // template unless a test turns the text mode on itself.
    beforeEach(() => {
      jest.replaceProperty(
        c.app().get(OwnerApprovalConfig),
        'textFallback',
        false,
      );
    });
    // Owner messages (and M9.3 customer notices) still queued are closed, so that the background outbox worker
    // never sends them through the real adapter once the spy is restored.
    afterEach(async () => {
      jest.restoreAllMocks();
      await settle();
    });
    const settle = async () => {
      const pending = await db().message.findMany({
        where: {
          OR: [
            { idempotencyKey: { startsWith: 'owner-approval-' } },
            { idempotencyKey: { startsWith: 'owner-reply-' } },
            { idempotencyKey: { startsWith: 'decision-' } },
          ],
          status: { in: ['QUEUED', 'SENDING'] },
        },
        select: { id: true },
      });
      for (const { id } of pending) {
        await db().message.update({
          where: { id },
          data: {
            status: 'FAILED',
            errorCode: 'TEST_CLEANUP',
            failedAt: new Date(),
            processingToken: null,
            processingUntil: null,
          },
        });
        await db().messagingOutbox.updateMany({
          where: { messageId: id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            leaseToken: null,
            leaseUntil: null,
          },
        });
      }
    };
    afterAll(async () => {
      await db().restaurantConfig.update({
        where: { scope: 'GLOBAL' },
        data: previous,
      });
    });

    const future = (days = 6) => new Date(Date.now() + days * 86400000);
    // A request as the website's email importer leaves it (READY_TO_SEND + its email).
    const webRequest = async (extra: { createdAt?: Date } = {}) => {
      const created = await request(c.server())
        .post('/reservation-requests')
        .set('Authorization', c.auth())
        .send({
          customerId,
          sourceChannel: 'WEBSITE',
          reservationAt: future().toISOString(),
          numberOfPeople: 4,
          specialRequirements: 'Mesa junto a la ventana',
          comments: 'Es un cumpleaños\nCRM: nota interna que el dueño no ve',
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await db().inboundEmail.create({
        data: {
          mailbox: 'test:INBOX',
          uidValidity: 1n,
          uid: BigInt(randomInt(1, 2 ** 31)),
          kind: 'WEB_RESERVATION',
          status: 'IMPORTED',
          reservationRequestId: id,
          customerId,
        },
      });
      if (extra.createdAt)
        await db().reservationRequest.update({
          where: { id },
          data: { createdAt: extra.createdAt },
        });
      return id;
    };
    const stored = (id: string) =>
      db().reservationRequest.findUniqueOrThrow({
        where: { id },
        include: {
          ownerMessage: true,
          statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
      });
    // Drives the owner's message until it leaves the queue (the background outbox worker
    // may also take it; both go through the same spied adapter).
    const deliver = async (messageId: string) => {
      await eventually(async () => {
        await db().messagingOutbox.updateMany({
          where: { messageId, status: 'PENDING' },
          data: { availableAt: new Date(0) },
        });
        await c.app().get(OutboundMessagesService).process(messageId);
        const message = await db().message.findUniqueOrThrow({
          where: { id: messageId },
        });
        return !['QUEUED', 'SENDING'].includes(message.status);
      });
    };

    it('envía la plantilla al propietario y pasa a SENT_TO_OWNER, sin evidencia todavía', async () => {
      // WhatsApp keeps answering 'retry later': the message stays QUEUED.
      jest
        .spyOn(adapter(), 'sendTemplate')
        .mockRejectedValue(new ChannelSendError('retry', 60000));
      const id = await webRequest();
      await service().dispatch();
      const row = await stored(id);
      expect(row.status).toBe('SENT_TO_OWNER');
      expect(row.ownerMessage).toMatchObject({
        direction: 'OUTBOUND',
        templateName: 'aprobacion_reserva_propietario',
        templateLanguage: 'es',
        recipientPhone: OWNER_NUMBER,
        idempotencyKey: `owner-approval-${id}`,
      });
      const parameters = row.ownerMessage!.templateParameters;
      expect(parameters).toHaveLength(8);
      expect(parameters[0]).toBe(row.code);
      expect(parameters[1]).toMatch(/^Lucía Rojas \(\+5198\d+\)$/);
      expect(parameters[4]).toBe('4');
      expect(parameters[6]).toBe('Mesa junto a la ventana · Es un cumpleaños');
      expect(parameters[7]).toBe('Página web');
      expect(row.ownerMessage!.content).toContain(
        `Nueva solicitud de reserva ${row.code}`,
      );
      expect(row.statusHistory).toEqual([
        expect.objectContaining({
          previousStatus: 'READY_TO_SEND',
          newStatus: 'SENT_TO_OWNER',
          actorType: 'SYSTEM',
          actorId: null,
        }),
      ]);
      // The owner's conversation: a contact for the number, with Samanta paused.
      const conversation = await db().conversation.findUniqueOrThrow({
        where: { id: row.ownerMessage!.conversationId },
        include: { customer: true },
      });
      expect(conversation).toMatchObject({
        channel: 'WHATSAPP',
        isAssistantPaused: true,
        assistantPauseReason: 'MANUAL',
      });
      expect(conversation.customer).toMatchObject({
        normalizedPhone: OWNER_NUMBER,
        firstName: 'Propietario',
      });
      // Without evidence that WhatsApp took it, it does not wait for the owner yet.
      await service().reconcile();
      expect((await stored(id)).status).toBe('SENT_TO_OWNER');
      const detail = await request(c.server())
        .get(`/reservation-requests/${id}`)
        .set('Authorization', c.auth(RoleCode.OWNER))
        .expect(200);
      expect(
        (detail.body as { ownerMessage: { id: string } }).ownerMessage,
      ).toMatchObject({ id: row.ownerMessageId });
    });

    it('cuando WhatsApp acepta la plantilla (SENT) pasa a WAITING_RESPONSE', async () => {
      const send = jest
        .spyOn(adapter(), 'sendTemplate')
        .mockResolvedValue('wamid.owner-ok');
      const id = await webRequest();
      await service().dispatch();
      const { ownerMessageId } = await stored(id);
      await deliver(ownerMessageId!);
      expect(send).toHaveBeenCalledWith(
        { recipientPhone: OWNER_NUMBER, recipientExternalId: null },
        expect.objectContaining({ name: 'aprobacion_reserva_propietario' }),
      );
      await service().reconcile();
      const row = await stored(id);
      expect(row.ownerMessage).toMatchObject({
        status: 'SENT',
        externalMessageId: 'wamid.owner-ok',
      });
      expect(row.status).toBe('WAITING_RESPONSE');
      expect(row.statusHistory.map((entry) => entry.newStatus)).toEqual([
        'SENT_TO_OWNER',
        'WAITING_RESPONSE',
      ]);
      // A person can still decide meanwhile (M8.3).
      await request(c.server())
        .post(`/reservation-requests/${id}/approve`)
        .set('Authorization', c.auth(RoleCode.OWNER))
        .expect(200);
      expect((await stored(id)).status).toBe('ACCEPTED');
    });

    it('un error transitorio se reintenta: sigue en SENT_TO_OWNER hasta que WhatsApp lo acepta', async () => {
      const send = jest
        .spyOn(adapter(), 'sendTemplate')
        .mockRejectedValueOnce(new ChannelSendError('retry', 60000))
        .mockResolvedValue('wamid.owner-retry');
      const id = await webRequest();
      await service().dispatch();
      const { ownerMessageId } = await stored(id);
      await c.app().get(OutboundMessagesService).process(ownerMessageId!);
      await eventually(async () => {
        const message = await db().message.findUniqueOrThrow({
          where: { id: ownerMessageId! },
        });
        return (
          message.status === 'QUEUED' &&
          message.errorCode === 'WHATSAPP_RATE_LIMITED'
        );
      });
      await service().reconcile();
      expect((await stored(id)).status).toBe('SENT_TO_OWNER');
      await deliver(ownerMessageId!);
      await service().reconcile();
      expect(send).toHaveBeenCalledTimes(2);
      expect((await stored(id)).status).toBe('WAITING_RESPONSE');
    });

    it('un fallo definitivo devuelve la solicitud a READY_TO_SEND y no se reenvía', async () => {
      const send = jest
        .spyOn(adapter(), 'sendTemplate')
        .mockRejectedValue(new ChannelSendError('failed'));
      const id = await webRequest();
      await service().dispatch();
      const { ownerMessageId } = await stored(id);
      await deliver(ownerMessageId!);
      await service().reconcile();
      const row = await stored(id);
      expect(row.ownerMessage!.status).toBe('FAILED');
      expect(row.status).toBe('READY_TO_SEND');
      expect(row.statusHistory.at(-1)).toMatchObject({
        previousStatus: 'SENT_TO_OWNER',
        newStatus: 'READY_TO_SEND',
        actorType: 'SYSTEM',
      });
      expect(row.statusHistory.at(-1)!.reason).toContain('No se reenvía');
      await service().dispatch();
      expect(
        await db().message.count({
          where: { idempotencyKey: `owner-approval-${id}` },
        }),
      ).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect((await stored(id)).ownerMessageId).toBe(ownerMessageId);
    });

    it('envíos repetidos y concurrentes producen una sola notificación', async () => {
      jest
        .spyOn(adapter(), 'sendTemplate')
        .mockRejectedValue(new ChannelSendError('retry', 60000));
      const id = await webRequest();
      await Promise.all([
        service().dispatch(),
        service().dispatch(),
        service().dispatch(),
      ]);
      await service().dispatch();
      expect(
        await db().message.count({
          where: { idempotencyKey: `owner-approval-${id}` },
        }),
      ).toBe(1);
      const row = await stored(id);
      expect(row.status).toBe('SENT_TO_OWNER');
      expect(
        row.statusHistory.filter(
          (entry) => entry.newStatus === 'SENT_TO_OWNER',
        ),
      ).toHaveLength(1);
    });

    it('no envía solicitudes creadas a mano, antiguas ni sin propietario configurado', async () => {
      jest
        .spyOn(adapter(), 'sendTemplate')
        .mockRejectedValue(new ChannelSendError('retry', 60000));
      const manual = await request(c.server())
        .post('/reservation-requests')
        .set('Authorization', c.auth())
        .send({
          customerId,
          sourceChannel: 'PHONE',
          reservationAt: future().toISOString(),
          numberOfPeople: 2,
        })
        .expect(201);
      const old = await webRequest({
        createdAt: new Date(Date.now() - 3 * 86400000),
      });
      await service().dispatch();
      expect((await stored((manual.body as { id: string }).id)).status).toBe(
        'READY_TO_SEND',
      );
      expect((await stored(old)).status).toBe('READY_TO_SEND');
      await db().restaurantConfig.update({
        where: { scope: 'GLOBAL' },
        data: { ownerWhatsappNumber: null },
      });
      const unconfigured = await webRequest();
      await service().dispatch();
      expect((await stored(unconfigured)).status).toBe('READY_TO_SEND');
      await db().restaurantConfig.update({
        where: { scope: 'GLOBAL' },
        data: { ownerWhatsappNumber: OWNER_NUMBER },
      });
    });

    it('la base exige notificación en SENT_TO_OWNER y un número E.164 distinto del negocio', async () => {
      const id = await webRequest();
      await expect(
        db().reservationRequest.update({
          where: { id },
          data: { status: 'WAITING_RESPONSE' },
        }),
      ).rejects.toThrow();
      const config = await db().restaurantConfig.findUniqueOrThrow({
        where: { scope: 'GLOBAL' },
      });
      for (const ownerWhatsappNumber of ['987000111', config.whatsappNumber])
        await expect(
          db().restaurantConfig.update({
            where: { scope: 'GLOBAL' },
            data: { ownerWhatsappNumber },
          }),
        ).rejects.toThrow();
    });

    it('PUT /restaurant-config guarda el número del propietario; omitirlo lo conserva', async () => {
      const current = (
        await request(c.server())
          .get('/restaurant-config')
          .set('Authorization', c.auth())
          .expect(200)
      ).body as Record<string, unknown> & {
        schedules: Record<string, unknown>[];
      };
      const body = {
        businessName: current.businessName,
        address: current.address,
        whatsappNumber: current.whatsappNumber,
        email: current.email,
        currency: current.currency,
        timeZone: current.timeZone,
        reservationPolicy: current.reservationPolicy,
        cancellationPolicy: current.cancellationPolicy,
        responseTimeoutMinutes: current.responseTimeoutMinutes,
        approvalResponsibleId: current.approvalResponsibleId,
        languages: ['ES'],
        schedules: Object.values(DayOfWeek).map((dayOfWeek) => ({
          dayOfWeek,
          isOpen: false,
        })),
      };
      const put = (extra: object) =>
        request(c.server())
          .put('/restaurant-config')
          .set('Authorization', c.auth())
          .send({ ...body, ...extra });
      expect(
        (await put({ ownerWhatsappNumber: ' +51987000222 ' }).expect(200)).body,
      ).toMatchObject({ ownerWhatsappNumber: '+51987000222' });
      expect((await put({}).expect(200)).body).toMatchObject({
        ownerWhatsappNumber: '+51987000222',
      });
      await put({ ownerWhatsappNumber: '987000222' }).expect(400);
      await put({ ownerWhatsappNumber: body.whatsappNumber }).expect(400);
      expect(
        (await put({ ownerWhatsappNumber: null }).expect(200)).body,
      ).toMatchObject({ ownerWhatsappNumber: null });
      await put({ ownerWhatsappNumber: OWNER_NUMBER }).expect(200);
    });

    describe('M9.2: respuestas del propietario por WhatsApp', () => {
      let ownerUserId: string;
      beforeAll(async () => {
        ownerUserId = (
          await db().user.findUniqueOrThrow({
            where: { email: 'owner@test.example' },
            select: { id: true },
          })
        ).id;
      });
      beforeEach(() => {
        // The answers to the owner are queued, never really sent.
        jest
          .spyOn(adapter(), 'sendMessage')
          .mockRejectedValue(new ChannelSendError('retry', 60000));
      });
      // A request already waiting for the owner, and the wamid of its template.
      const waiting = async () => {
        jest
          .spyOn(adapter(), 'sendTemplate')
          .mockImplementation(() =>
            Promise.resolve(`wamid.owner-${randomUUID()}`),
          );
        const id = await webRequest();
        await service().dispatch();
        const { ownerMessageId } = await stored(id);
        await deliver(ownerMessageId!);
        await service().reconcile();
        const row = await stored(id);
        expect(row.status).toBe('WAITING_RESPONSE');
        return {
          id,
          code: row.code,
          wamid: row.ownerMessage!.externalMessageId!,
        };
      };
      interface Said {
        replyTo?: string;
        button?: boolean;
        phone?: string;
        externalMessageId?: string;
      }
      const ingest = (content: string, extra: Said = {}) =>
        c
          .app()
          .get(MessagesService)
          .ingestInboundMessage({
            channel: 'WHATSAPP',
            externalMessageId:
              extra.externalMessageId ?? `wamid.in-${randomUUID()}`,
            providerAccountId: '123',
            contact: { phone: extra.phone ?? OWNER_NUMBER },
            type: 'TEXT',
            content,
            occurredAt: new Date().toISOString(),
            ...(extra.replyTo
              ? { replyToExternalMessageId: extra.replyTo }
              : {}),
            ...(extra.button ? { buttonReply: true } : {}),
          });
      const processed = async (messageId: string) => {
        await eventually(async () => {
          await c.app().get(MessageProcessorService).process(messageId);
          return (
            (
              await db().message.findUniqueOrThrow({
                where: { id: messageId },
              })
            ).status === 'PROCESSED'
          );
        });
        return db().message.findUniqueOrThrow({ where: { id: messageId } });
      };
      const ownerSays = async (content: string, extra: Said = {}) =>
        processed((await ingest(content, extra)).message.id);
      const answerTo = (messageId: string) =>
        db().message.findFirst({
          where: { idempotencyKey: `owner-reply-${messageId}` },
        });
      const reservationsOf = (id: string) =>
        db().reservation.findMany({ where: { reservationRequestId: id } });

      it('botón Aceptar: ACCEPTED, una reserva CONFIRMED, historial OWNER y aviso al propietario', async () => {
        const { id, code, wamid } = await waiting();
        const reply = await ownerSays('Aceptar', {
          replyTo: wamid,
          button: true,
        });
        expect(reply.ownerReplyOutcome).toBe('ACCEPTED');
        const row = await stored(id);
        expect(row.status).toBe('ACCEPTED');
        const reservations = await reservationsOf(id);
        expect(reservations).toHaveLength(1);
        expect(reservations[0]).toMatchObject({
          status: 'CONFIRMED',
          reservationAt: row.reservationAt,
          numberOfPeople: row.numberOfPeople,
        });
        expect(row.statusHistory.at(-1)).toMatchObject({
          previousStatus: 'WAITING_RESPONSE',
          newStatus: 'ACCEPTED',
          actorType: 'OWNER',
          actorId: ownerUserId,
        });
        const answer = await answerTo(reply.id);
        expect(answer?.content).toContain(code);
        expect(answer?.content).toContain(reservations[0].code);
      });

      it('Samanta nunca responde al propietario, aunque alguien quite la pausa', async () => {
        const { id, wamid } = await waiting();
        const { ownerMessage } = await stored(id);
        await db().conversation.update({
          where: { id: ownerMessage!.conversationId },
          data: { isAssistantPaused: false, assistantPauseReason: null },
        });
        jest.replaceProperty(samantaTestConfig, 'autoEnabled', true);
        const reply = await ownerSays('Rechazar', {
          replyTo: wamid,
          button: true,
        });
        expect(reply.ownerReplyOutcome).toBe('REJECTED');
        expect(
          await db().samantaDraft.count({
            where: { sourceMessageId: reply.id },
          }),
        ).toBe(0);
        expect(
          await db().conversation.findUniqueOrThrow({
            where: { id: reply.conversationId },
          }),
        ).toMatchObject({
          isAssistantPaused: true,
          assistantPauseReason: 'MANUAL',
        });
        const row = await stored(id);
        expect(row.status).toBe('REJECTED');
        expect(row.statusHistory.at(-1)).toMatchObject({
          newStatus: 'REJECTED',
          actorType: 'OWNER',
          actorId: ownerUserId,
        });
        expect(await reservationsOf(id)).toHaveLength(0);
      });

      it('Proponer cambio y luego los detalles: MODIFICATION_REQUESTED y nota para el equipo, sin cambiar la solicitud', async () => {
        const { id, wamid } = await waiting();
        const before = await stored(id);
        const propose = await ownerSays('Proponer cambio', {
          replyTo: wamid,
          button: true,
        });
        expect(propose.ownerReplyOutcome).toBe('MODIFICATION_REQUESTED');
        expect((await stored(id)).statusHistory.at(-1)).toMatchObject({
          previousStatus: 'WAITING_RESPONSE',
          newStatus: 'MODIFICATION_REQUESTED',
          actorType: 'OWNER',
        });
        const details = await ownerSays('Mejor a las 21:00 y para 6 personas');
        expect(details.ownerReplyOutcome).toBe('DETAILS_ADDED');
        const after = await stored(id);
        expect(after.status).toBe('MODIFICATION_REQUESTED');
        expect(after.comments).toContain('CRM: propuesta del propietario (');
        expect(after.comments).toContain('Mejor a las 21:00 y para 6 personas');
        expect(after.reservationAt).toEqual(before.reservationAt);
        expect(after.numberOfPeople).toBe(before.numberOfPeople);
        expect(after.commercialItemId).toBe(before.commercialItemId);
        expect(await reservationsOf(id)).toHaveLength(0);
        expect((await answerTo(details.id))?.content).toContain(after.code);
        // Leave no recent proposal behind for the next tests.
        await db().reservationRequest.update({
          where: { id },
          data: { updatedAt: new Date(Date.now() - 2 * 86400000) },
        });
      });

      it('un remitente que no es el propietario no decide nada, aunque cite la plantilla', async () => {
        const { id, wamid } = await waiting();
        const reply = await ownerSays('Aceptar', {
          replyTo: wamid,
          button: true,
          phone: `+5198${randomInt(1000000, 9999999)}`,
        });
        expect(reply.ownerReplyOutcome).toBeNull();
        expect((await stored(id)).status).toBe('WAITING_RESPONSE');
        expect(await reservationsOf(id)).toHaveLength(0);
      });

      it('texto sin código, código desconocido o decisiones mezcladas: no decide y aclara', async () => {
        const { id, code } = await waiting();
        for (const [content, outcome] of [
          ['Aceptar', 'AMBIGUOUS'],
          ['ACEPTAR RES-2026-999999', 'UNKNOWN_REQUEST'],
          [`ACEPTAR o RECHAZAR ${code}`, 'AMBIGUOUS'],
        ] as const) {
          const reply = await ownerSays(content);
          expect(reply.ownerReplyOutcome).toBe(outcome);
          expect((await answerTo(reply.id))?.content).toBeTruthy();
        }
        expect((await stored(id)).status).toBe('WAITING_RESPONSE');
        // Typed text with its code is unambiguous.
        expect((await ownerSays(`Ok, ACEPTAR ${code}`)).ownerReplyOutcome).toBe(
          'ACCEPTED',
        );
        expect(await reservationsOf(id)).toHaveLength(1);
      });

      it('webhook repetido y segundo toque: una sola decisión y una sola reserva', async () => {
        const { id, wamid } = await waiting();
        const externalMessageId = `wamid.in-${randomUUID()}`;
        const first = await ownerSays('Aceptar', {
          replyTo: wamid,
          button: true,
          externalMessageId,
        });
        const again = await ingest('Aceptar', {
          replyTo: wamid,
          button: true,
          externalMessageId,
        });
        expect(again.duplicate).toBe(true);
        const second = await ownerSays('Aceptar', {
          replyTo: wamid,
          button: true,
        });
        expect(first.ownerReplyOutcome).toBe('ACCEPTED');
        expect(second.ownerReplyOutcome).toBe('ALREADY_RESOLVED');
        expect(await reservationsOf(id)).toHaveLength(1);
        expect(
          (await stored(id)).statusHistory.filter(
            (entry) => entry.newStatus === 'ACCEPTED',
          ),
        ).toHaveLength(1);
      });

      it('Aceptar y Rechazar procesados a la vez: se aplica una sola decisión', async () => {
        const { id, wamid } = await waiting();
        const [accept, reject] = await Promise.all([
          ingest('Aceptar', { replyTo: wamid, button: true }),
          ingest('Rechazar', { replyTo: wamid, button: true }),
        ]);
        const results = await Promise.all([
          processed(accept.message.id),
          processed(reject.message.id),
        ]);
        const outcomes = results.map((m) => m.ownerReplyOutcome).sort();
        const final = (await stored(id)).status;
        expect(['ACCEPTED', 'REJECTED']).toContain(final);
        expect(outcomes).toEqual(
          final === 'ACCEPTED'
            ? ['ACCEPTED', 'ALREADY_RESOLVED']
            : ['ALREADY_RESOLVED', 'REJECTED'],
        );
        expect(await reservationsOf(id)).toHaveLength(
          final === 'ACCEPTED' ? 1 : 0,
        );
      });

      describe('M9.1 temporal: solicitud por texto mientras Meta revisa la plantilla', () => {
        const config = () => c.app().get(OwnerApprovalConfig);
        const key = (id: string) => `owner-approval-${id}`;
        // The owner's last message is older than 24 h: the window is closed.
        const closeOwnerWindow = () =>
          db().message.updateMany({
            where: { direction: 'INBOUND', recipientPhone: OWNER_NUMBER },
            data: { occurredAt: new Date(Date.now() - 25 * 3600 * 1000) },
          });
        // Any message from the owner opens it ("Hola" decides nothing).
        const openOwnerWindow = async () =>
          expect((await ownerSays('Hola')).ownerReplyOutcome).toBe('NO_ACTION');
        // WhatsApp takes every text (the owner's request and the answers to the owner).
        const whatsappTakesTexts = () =>
          jest
            .spyOn(adapter(), 'sendMessage')
            .mockImplementation(() =>
              Promise.resolve(`wamid.text-${randomUUID()}`),
            );
        // A request sent as text, already WAITING_RESPONSE.
        const waitingText = async () => {
          whatsappTakesTexts();
          await openOwnerWindow();
          const id = await webRequest();
          await service().dispatch();
          const { ownerMessageId } = await stored(id);
          await deliver(ownerMessageId!);
          await service().reconcile();
          const row = await stored(id);
          expect(row.status).toBe('WAITING_RESPONSE');
          expect(row.ownerMessage!.templateName).toBeNull();
          return { id, code: row.code };
        };
        beforeEach(() => {
          jest.replaceProperty(config(), 'textFallback', true);
        });

        it('ventana cerrada: no envía texto ni plantilla y no marca nada; al escribir el propietario sale el texto', async () => {
          const template = jest.spyOn(adapter(), 'sendTemplate');
          await closeOwnerWindow();
          const id = await webRequest();
          await service().dispatch();
          await service().dispatch();
          let row = await stored(id);
          expect(row).toMatchObject({
            status: 'READY_TO_SEND',
            ownerMessageId: null,
          });
          expect(row.statusHistory).toHaveLength(0);
          expect(
            await db().message.count({ where: { idempotencyKey: key(id) } }),
          ).toBe(0);
          expect(template).not.toHaveBeenCalled();
          // The owner writes: the window opens and the request goes out as text.
          await openOwnerWindow();
          await service().dispatch();
          row = await stored(id);
          expect(row.status).toBe('SENT_TO_OWNER');
          expect(row.ownerMessage).toMatchObject({
            type: 'TEXT',
            templateName: null,
            idempotencyKey: key(id),
            authorUserId: SAMANTA_USER_ID,
            recipientPhone: OWNER_NUMBER,
          });
          const content = row.ownerMessage!.content!;
          for (const line of [
            `Nueva solicitud de reserva ${row.code}`,
            'Cliente: Lucía Rojas',
            'Personas: 4',
            `ACEPTAR ${row.code}`,
            `RECHAZAR ${row.code}`,
            `CAMBIO ${row.code}`,
          ])
            expect(content).toContain(line);
          expect(content).not.toContain('nota interna');
          expect(row.statusHistory.at(-1)).toMatchObject({
            newStatus: 'SENT_TO_OWNER',
            actorType: 'SYSTEM',
          });
          expect(row.statusHistory.at(-1)!.reason).toContain('texto temporal');
          expect(template).not.toHaveBeenCalled();
        });

        it('ACEPTAR RES-… escrito: decide sin botón, crea una reserva y avisa al cliente (M9.3)', async () => {
          const { id, code } = await waitingText();
          const reply = await ownerSays(`ACEPTAR ${code}`);
          expect(reply.ownerReplyOutcome).toBe('ACCEPTED');
          const row = await stored(id);
          expect(row.status).toBe('ACCEPTED');
          expect(await reservationsOf(id)).toHaveLength(1);
          expect(row.statusHistory.at(-1)).toMatchObject({
            newStatus: 'ACCEPTED',
            actorType: 'OWNER',
            actorId: ownerUserId,
          });
          // M9.3 ran: the customer was told, or the reason why not is on the request.
          expect(
            row.customerNoticeMessageId !== null ||
              row.customerNoticeError !== null,
          ).toBe(true);
          const answer = (await answerTo(reply.id))!.content!;
          expect(answer).toContain(code);
          expect(answer).toMatch(/cliente/);
        });

        it('CAMBIO RES-… y luego los detalles: cambio propuesto y nota para el equipo', async () => {
          const { id, code } = await waitingText();
          expect((await ownerSays(`CAMBIO ${code}`)).ownerReplyOutcome).toBe(
            'MODIFICATION_REQUESTED',
          );
          const details = await ownerSays('Cambio a las 21:00 para 6 personas');
          expect(details.ownerReplyOutcome).toBe('DETAILS_ADDED');
          const row = await stored(id);
          expect(row.status).toBe('MODIFICATION_REQUESTED');
          expect(row.comments).toContain('Cambio a las 21:00 para 6 personas');
          expect(await reservationsOf(id)).toHaveLength(0);
          await db().reservationRequest.update({
            where: { id },
            data: { updatedAt: new Date(Date.now() - 2 * 86400000) },
          });
        });

        it('RECHAZAR repetido (webhook duplicado y segundo mensaje): una sola decisión', async () => {
          const { id, code } = await waitingText();
          const externalMessageId = `wamid.in-${randomUUID()}`;
          const first = await ownerSays(`RECHAZAR ${code}`, {
            externalMessageId,
          });
          const again = await ingest(`RECHAZAR ${code}`, { externalMessageId });
          expect(again.duplicate).toBe(true);
          const second = await ownerSays(`RECHAZAR ${code}`);
          const late = await ownerSays(`ACEPTAR ${code}`);
          expect(first.ownerReplyOutcome).toBe('REJECTED');
          expect(second.ownerReplyOutcome).toBe('ALREADY_RESOLVED');
          expect(late.ownerReplyOutcome).toBe('ALREADY_RESOLVED');
          expect(await reservationsOf(id)).toHaveLength(0);
          expect(
            (await stored(id)).statusHistory.filter(
              (entry) => entry.newStatus === 'REJECTED',
            ),
          ).toHaveLength(1);
        });

        it('envíos y respuestas concurrentes: un solo texto por solicitud y una sola decisión', async () => {
          whatsappTakesTexts();
          await openOwnerWindow();
          const id = await webRequest();
          await Promise.all([
            service().dispatch(),
            service().dispatch(),
            service().dispatch(),
          ]);
          expect(
            await db().message.count({ where: { idempotencyKey: key(id) } }),
          ).toBe(1);
          const { ownerMessageId, code } = await stored(id);
          await deliver(ownerMessageId!);
          await service().reconcile();
          const [accept, reject] = await Promise.all([
            ingest(`ACEPTAR ${code}`),
            ingest(`RECHAZAR ${code}`),
          ]);
          const outcomes = (
            await Promise.all([
              processed(accept.message.id),
              processed(reject.message.id),
            ])
          )
            .map((m) => m.ownerReplyOutcome)
            .sort();
          const final = (await stored(id)).status;
          expect(outcomes).toEqual(
            final === 'ACCEPTED'
              ? ['ACCEPTED', 'ALREADY_RESOLVED']
              : ['ALREADY_RESOLVED', 'REJECTED'],
          );
          expect(await reservationsOf(id)).toHaveLength(
            final === 'ACCEPTED' ? 1 : 0,
          );
        });

        it('fallo de WhatsApp: el transitorio se reintenta; el definitivo vuelve a READY_TO_SEND sin reenviar', async () => {
          await openOwnerWindow();
          const send = jest
            .spyOn(adapter(), 'sendMessage')
            .mockRejectedValueOnce(new ChannelSendError('retry', 60000))
            .mockRejectedValue(
              new ChannelSendError('failed', 1000, {
                httpStatus: 400,
                metaCode: 131047,
              }),
            );
          const id = await webRequest();
          await service().dispatch();
          const { ownerMessageId } = await stored(id);
          // First attempt: transient, still queued and SENT_TO_OWNER.
          await c.app().get(OutboundMessagesService).process(ownerMessageId!);
          expect((await stored(id)).status).toBe('SENT_TO_OWNER');
          await deliver(ownerMessageId!);
          await service().reconcile();
          const row = await stored(id);
          expect(row.ownerMessage!.status).toBe('FAILED');
          expect(row.status).toBe('READY_TO_SEND');
          expect(row.statusHistory.at(-1)!.reason).toContain('No se reenvía');
          const calls = send.mock.calls.length;
          await service().dispatch();
          expect(send.mock.calls.length).toBe(calls);
          expect(
            await db().message.count({ where: { idempotencyKey: key(id) } }),
          ).toBe(1);
        });

        it('si la ventana se cierra con el texto en cola, el worker no lo envía', async () => {
          await openOwnerWindow();
          const send = jest
            .spyOn(adapter(), 'sendMessage')
            .mockRejectedValue(new ChannelSendError('retry', 60000));
          const id = await webRequest();
          await service().dispatch();
          const { ownerMessageId } = await stored(id);
          send.mockClear();
          await closeOwnerWindow();
          await deliver(ownerMessageId!);
          expect(send).not.toHaveBeenCalled();
          await service().reconcile();
          const row = await stored(id);
          expect(row.ownerMessage).toMatchObject({
            status: 'FAILED',
            errorCode: 'WHATSAPP_WINDOW_CLOSED',
          });
          expect(row.status).toBe('READY_TO_SEND');
        });

        it('con el texto temporal apagado vuelve la plantilla oficial, aunque la ventana esté cerrada', async () => {
          jest.replaceProperty(config(), 'textFallback', false);
          const template = jest
            .spyOn(adapter(), 'sendTemplate')
            .mockRejectedValue(new ChannelSendError('retry', 60000));
          await closeOwnerWindow();
          const id = await webRequest();
          await service().dispatch();
          const row = await stored(id);
          expect(row.status).toBe('SENT_TO_OWNER');
          expect(row.ownerMessage!.templateName).toBe(
            'aprobacion_reserva_propietario',
          );
          await c
            .app()
            .get(OutboundMessagesService)
            .process(row.ownerMessageId!);
          expect(template).toHaveBeenCalledTimes(1);
        });

        describe('respuestas cortas con «Responder» (ACEPTO, RECHAZO, CAMBIO)', () => {
          // The text request, its code and the wamid the owner quotes with «Responder».
          const quotable = async () => {
            const { id, code } = await waitingText();
            const wamid = (await stored(id)).ownerMessage!.externalMessageId!;
            expect(wamid).toMatch(/^wamid\.text-/);
            return { id, code, wamid };
          };

          it('ACEPTO citando el mensaje de la solicitud: decide sin código, una reserva, historial OWNER y M9.3', async () => {
            const { id, code, wamid } = await quotable();
            const reply = await ownerSays('Acepto', { replyTo: wamid });
            expect(reply.ownerReplyOutcome).toBe('ACCEPTED');
            const row = await stored(id);
            expect(row.status).toBe('ACCEPTED');
            expect(await reservationsOf(id)).toHaveLength(1);
            expect(row.statusHistory.at(-1)).toMatchObject({
              newStatus: 'ACCEPTED',
              actorType: 'OWNER',
              actorId: ownerUserId,
            });
            expect(
              row.customerNoticeMessageId !== null ||
                row.customerNoticeError !== null,
            ).toBe(true);
            expect((await answerTo(reply.id))!.content).toContain(code);
          });

          it('RECHAZO y CAMBIO citados; los detalles posteriores quedan para el equipo', async () => {
            const rejected = await quotable();
            expect(
              (await ownerSays('¡Rechazo!', { replyTo: rejected.wamid }))
                .ownerReplyOutcome,
            ).toBe('REJECTED');
            expect((await stored(rejected.id)).status).toBe('REJECTED');
            expect(await reservationsOf(rejected.id)).toHaveLength(0);

            const changed = await quotable();
            expect(
              (await ownerSays('cambio', { replyTo: changed.wamid }))
                .ownerReplyOutcome,
            ).toBe('MODIFICATION_REQUESTED');
            const details = await ownerSays('Mejor el sábado a las 20:00');
            expect(details.ownerReplyOutcome).toBe('DETAILS_ADDED');
            const row = await stored(changed.id);
            expect(row.status).toBe('MODIFICATION_REQUESTED');
            expect(row.comments).toContain('Mejor el sábado a las 20:00');
            expect(row.statusHistory.at(-1)).toMatchObject({
              newStatus: 'MODIFICATION_REQUESTED',
              actorType: 'OWNER',
            });
            await db().reservationRequest.update({
              where: { id: changed.id },
              data: { updatedAt: new Date(Date.now() - 2 * 86400000) },
            });
          });

          it('ACEPTO sin «Responder» no decide y explica cómo responder', async () => {
            const { id } = await quotable();
            const reply = await ownerSays('Acepto');
            expect(reply.ownerReplyOutcome).toBe('AMBIGUOUS');
            expect((await answerTo(reply.id))!.content).toContain(
              '«Responder»',
            );
            expect((await stored(id)).status).toBe('WAITING_RESPONSE');
            expect(await reservationsOf(id)).toHaveLength(0);
          });

          it('referencias inválidas: otro mensaje, un wamid desconocido, otro remitente o un código distinto no deciden', async () => {
            const { id, code, wamid } = await quotable();
            const other = await quotable();
            // The owner's own message ("Hola") is not a request.
            const hello = await ownerSays('Hola');
            const quotedHello = await ownerSays('Acepto', {
              replyTo: hello.externalMessageId!,
            });
            expect(quotedHello.ownerReplyOutcome).toBe('UNKNOWN_REQUEST');
            expect((await answerTo(quotedHello.id))!.content).toContain(
              'no es una solicitud',
            );
            expect(
              (await ownerSays('Acepto', { replyTo: 'wamid.desconocido' }))
                .ownerReplyOutcome,
            ).toBe('UNKNOWN_REQUEST');
            // Quoting one request with the code of another is ambiguous.
            expect(
              (await ownerSays(`ACEPTO ${other.code}`, { replyTo: wamid }))
                .ownerReplyOutcome,
            ).toBe('AMBIGUOUS');
            // Someone else quoting the request (a forwarded message) is not the owner.
            expect(
              (
                await ownerSays('Acepto', {
                  replyTo: wamid,
                  phone: `+5198${randomInt(1000000, 9999999)}`,
                })
              ).ownerReplyOutcome,
            ).toBeNull();
            for (const request of [id, other.id]) {
              expect((await stored(request)).status).toBe('WAITING_RESPONSE');
              expect(await reservationsOf(request)).toHaveLength(0);
            }
            // The same code and quote agree: that one decides.
            expect(
              (await ownerSays(`ACEPTAR ${code}`, { replyTo: wamid }))
                .ownerReplyOutcome,
            ).toBe('ACCEPTED');
          });

          it('un mensaje antiguo de una solicitud ya resuelta no decide otra vez', async () => {
            const { id, wamid } = await quotable();
            expect(
              (await ownerSays('Rechazo', { replyTo: wamid }))
                .ownerReplyOutcome,
            ).toBe('REJECTED');
            const late = await ownerSays('Acepto', { replyTo: wamid });
            expect(late.ownerReplyOutcome).toBe('ALREADY_RESOLVED');
            expect((await stored(id)).status).toBe('REJECTED');
            expect(await reservationsOf(id)).toHaveLength(0);
          });

          it('webhook duplicado y respuestas citadas simultáneas: una sola decisión', async () => {
            const first = await quotable();
            const externalMessageId = `wamid.in-${randomUUID()}`;
            expect(
              (
                await ownerSays('Acepto', {
                  replyTo: first.wamid,
                  externalMessageId,
                })
              ).ownerReplyOutcome,
            ).toBe('ACCEPTED');
            expect(
              (
                await ingest('Acepto', {
                  replyTo: first.wamid,
                  externalMessageId,
                })
              ).duplicate,
            ).toBe(true);
            expect(await reservationsOf(first.id)).toHaveLength(1);

            const second = await quotable();
            const [accept, reject] = await Promise.all([
              ingest('Acepto', { replyTo: second.wamid }),
              ingest('Rechazo', { replyTo: second.wamid }),
            ]);
            const outcomes = (
              await Promise.all([
                processed(accept.message.id),
                processed(reject.message.id),
              ])
            )
              .map((m) => m.ownerReplyOutcome)
              .sort();
            const final = (await stored(second.id)).status;
            expect(outcomes).toEqual(
              final === 'ACCEPTED'
                ? ['ACCEPTED', 'ALREADY_RESOLVED']
                : ['ALREADY_RESOLVED', 'REJECTED'],
            );
            expect(await reservationsOf(second.id)).toHaveLength(
              final === 'ACCEPTED' ? 1 : 0,
            );
            expect(
              (await stored(second.id)).statusHistory.filter(
                (entry) => entry.actorType === 'OWNER',
              ),
            ).toHaveLength(1);
          });
        });
      });

      describe('M9.3: aviso al cliente de la decisión del propietario', () => {
        type Channel = 'WHATSAPP' | 'FACEBOOK' | 'INSTAGRAM';
        const ACCOUNT: Record<Channel, string> = {
          WHATSAPP: '123',
          FACEBOOK: '321',
          INSTAGRAM: '789',
        };
        const config = () => c.app().get(OwnerApprovalConfig);
        let send: Record<Channel, jest.SpyInstance>;
        let template: jest.SpyInstance;
        let timeZone: string;
        let business: string;
        beforeAll(async () => {
          ({ timeZone, businessName: business } =
            await db().restaurantConfig.findUniqueOrThrow({
              where: { scope: 'GLOBAL' },
              select: { timeZone: true, businessName: true },
            }));
        });
        // Every channel is simulated: whatever leaves the outbox reaches only these spies.
        beforeEach(() => {
          const ok = (prefix: string) => () =>
            Promise.resolve(`${prefix}.${randomUUID()}`);
          send = {
            WHATSAPP: jest
              .spyOn(adapter(), 'sendMessage')
              .mockImplementation(ok('wamid.out')),
            FACEBOOK: jest
              .spyOn(c.app().get(MessengerAdapter), 'sendMessage')
              .mockImplementation(ok('mid.out')),
            INSTAGRAM: jest
              .spyOn(c.app().get(InstagramAdapter), 'sendMessage')
              .mockImplementation(ok('ig.out')),
          };
          template = jest
            .spyOn(adapter(), 'sendTemplate')
            .mockImplementation(ok('wamid.tpl'));
          jest
            .spyOn(c.app().get(MessengerAdapter), 'fetchSenderName')
            .mockResolvedValue(null);
          jest
            .spyOn(c.app().get(InstagramAdapter), 'fetchSenderName')
            .mockResolvedValue(null);
        });
        const local = (at: Date) => ({
          date: new Intl.DateTimeFormat('es-PE', {
            timeZone,
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          }).format(at),
          time: new Intl.DateTimeFormat('es-PE', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(at),
        });
        // A customer who wrote on a channel `hoursAgo` hours ago, as the webhook leaves it.
        const customerWrote = async (channel: Channel, hoursAgo = 0) => {
          const contact =
            channel === 'WHATSAPP'
              ? { phone: `+5197${randomInt(1000000, 9999999)}` }
              : { externalId: `${Date.now()}${randomInt(100000, 999999)}` };
          const { message } = await c
            .app()
            .get(MessagesService)
            .ingestInboundMessage({
              channel,
              externalMessageId: `in-${randomUUID()}`,
              providerAccountId: ACCOUNT[channel],
              contact,
              type: 'TEXT',
              content: 'Quiero reservar',
              occurredAt: new Date().toISOString(),
            });
          if (hoursAgo)
            await db().message.update({
              where: { id: message.id },
              data: { occurredAt: new Date(Date.now() - hoursAgo * 3600000) },
            });
          const conversation = await db().conversation.findUniqueOrThrow({
            where: { id: message.conversationId },
          });
          await db().customer.update({
            where: { id: conversation.customerId },
            data: { firstName: 'Carla' },
          });
          return {
            channel,
            contact: contact as { phone?: string; externalId?: string },
            messageId: message.id,
            conversationId: conversation.id,
            customerId: conversation.customerId,
          };
        };
        type Customer = Awaited<ReturnType<typeof customerWrote>>;
        // A request Samanta registered in that conversation (M8.2), ready for the owner.
        const samantaRequest = async (who: Customer, language = 'es') => {
          const created = await request(c.server())
            .post('/reservation-requests')
            .set('Authorization', c.auth())
            .send({
              customerId: who.customerId,
              conversationId: who.conversationId,
              sourceChannel: who.channel,
              reservationAt: future().toISOString(),
              numberOfPeople: 3,
            })
            .expect(201);
          const id = (created.body as { id: string }).id;
          await db().samantaDraft.create({
            data: {
              conversationId: who.conversationId,
              sourceMessageId: who.messageId,
              baselineSequence: 1,
              idempotencyKey: `test-${randomUUID()}`,
              createdById: SAMANTA_USER_ID,
              // Its summary is not the last message any more (no APPROVED constraints).
              status: 'STALE',
              content: 'Resumen de la solicitud',
              mode: 'AUTO',
              model: 'test',
              promptVersion: 'test',
              knowledgeHash: '0'.repeat(64),
              requiresHuman: false,
              expiresAt: future(1),
              reservationProposal: {
                date: '2026-12-01',
                time: '20:00',
                people: 3,
                commercialItemId: null,
                service: null,
                specialRequirements: null,
                language,
              },
              reservationRequestId: id,
              reservationOutcome: 'CREATED',
            },
          });
          return id;
        };
        // A website request whose import ended with `contactError` (web-reservation).
        const webRequestFor = async (
          customerId: string,
          contactError: string | null,
        ) => {
          const created = await request(c.server())
            .post('/reservation-requests')
            .set('Authorization', c.auth())
            .send({
              customerId,
              sourceChannel: 'WEBSITE',
              reservationAt: future().toISOString(),
              numberOfPeople: 4,
            })
            .expect(201);
          const id = (created.body as { id: string }).id;
          await db().inboundEmail.create({
            data: {
              mailbox: 'test:INBOX',
              uidValidity: 1n,
              uid: BigInt(randomInt(1, 2 ** 31)),
              kind: 'WEB_RESERVATION',
              status: 'IMPORTED',
              reservationRequestId: id,
              customerId,
              contactError,
            },
          });
          return id;
        };
        const webCustomer = async () => {
          const phone = `+5196${randomInt(1000000, 9999999)}`;
          const { id } = await db().customer.create({
            data: {
              firstName: 'Rosa',
              phone,
              normalizedPhone: phone,
              sourceChannel: 'WEBSITE',
            },
          });
          return { id, phone };
        };
        const toOwner = async (id: string) => {
          await service().dispatch();
          const { ownerMessageId } = await stored(id);
          await deliver(ownerMessageId!);
          await service().reconcile();
          const row = await stored(id);
          expect(row.status).toBe('WAITING_RESPONSE');
          return {
            code: row.code,
            wamid: row.ownerMessage!.externalMessageId!,
          };
        };
        const noticed = (id: string) =>
          db().reservationRequest.findUniqueOrThrow({
            where: { id },
            include: { customerNoticeMessage: true, reservation: true },
          });
        const decisionMessages = (id: string) =>
          db().message.findMany({
            where: { idempotencyKey: { startsWith: `decision-${id}-` } },
          });
        const detail = async (id: string) =>
          (
            await request(c.server())
              .get(`/reservation-requests/${id}`)
              .set('Authorization', c.auth())
              .expect(200)
          ).body as {
            customerNoticeError: string | null;
            customerNoticeMessage: Record<string, unknown> | null;
          };

        it('WhatsApp de Samanta, Aceptar: confirma con código, fecha, hora y personas, con la reserva ya creada', async () => {
          const who = await customerWrote('WHATSAPP');
          const id = await samantaRequest(who);
          const { code, wamid } = await toOwner(id);
          const reply = await ownerSays('Aceptar', {
            replyTo: wamid,
            button: true,
          });
          expect(reply.ownerReplyOutcome).toBe('ACCEPTED');
          const row = await noticed(id);
          const notice = row.customerNoticeMessage!;
          // Queued in the transaction that created the CONFIRMED reservation.
          expect(row.reservation).toMatchObject({ status: 'CONFIRMED' });
          expect(row.customerNoticeError).toBeNull();
          expect(notice).toMatchObject({
            conversationId: who.conversationId,
            channel: 'WHATSAPP',
            direction: 'OUTBOUND',
            templateName: null,
            authorUserId: SAMANTA_USER_ID,
            recipientPhone: who.contact.phone,
            idempotencyKey: `decision-${id}-ACCEPTED`,
          });
          // The owner's conversation and the customer's are different ones.
          expect(notice.conversationId).not.toBe(reply.conversationId);
          const { date, time } = local(row.reservation!.reservationAt);
          for (const part of [
            code,
            row.reservation!.code,
            date,
            time,
            '3 personas',
            'confirmada',
          ])
            expect(notice.content).toContain(part);
          expect((await answerTo(reply.id))?.content).toContain(
            'Le avisamos al cliente por WhatsApp.',
          );
          await deliver(notice.id);
          expect(send.WHATSAPP).toHaveBeenCalledWith(
            expect.objectContaining({ recipientPhone: who.contact.phone }),
            notice.content,
          );
          expect(await detail(id)).toMatchObject({
            customerNoticeError: null,
            customerNoticeMessage: {
              id: notice.id,
              conversationId: who.conversationId,
              channel: 'WHATSAPP',
              templateName: null,
              status: 'SENT',
            },
          });
          // A late "sí" never makes Samanta say "pending approval" again.
          const late = await db().$transaction((tx) =>
            c
              .app()
              .get(SamantaReservationService)
              .confirm(tx, who.conversationId, 10_000, 'es', new Date()),
          );
          expect(late.code).toBe('ALREADY_DECIDED');
          expect(late.content).toContain(row.reservation!.code);
          expect(late.content).not.toContain('pendiente');
        });

        it('Messenger, Rechazar con su código: avisa que no se aprobó, sin reserva y sin decir «confirmada»', async () => {
          const who = await customerWrote('FACEBOOK');
          const id = await samantaRequest(who);
          const { code } = await toOwner(id);
          const reply = await ownerSays(`RECHAZAR ${code}`);
          expect(reply.ownerReplyOutcome).toBe('REJECTED');
          expect(await reservationsOf(id)).toHaveLength(0);
          const notice = (await noticed(id)).customerNoticeMessage!;
          expect(notice).toMatchObject({
            conversationId: who.conversationId,
            channel: 'FACEBOOK',
            templateName: null,
            recipientExternalId: who.contact.externalId,
            idempotencyKey: `decision-${id}-REJECTED`,
          });
          expect(notice.content).toContain(code);
          expect(notice.content).toContain('no pudo aprobar');
          expect(notice.content).not.toMatch(/confirmad/i);
          await deliver(notice.id);
          expect(send.FACEBOOK).toHaveBeenCalledWith(
            expect.objectContaining({
              recipientExternalId: who.contact.externalId,
            }),
            notice.content,
          );
          expect((await detail(id)).customerNoticeMessage).toMatchObject({
            channel: 'FACEBOOK',
            status: 'SENT',
          });
        });

        it('Instagram (en inglés), Proponer cambio: avisa la propuesta, no cambia nada y deja el caso a una persona', async () => {
          const who = await customerWrote('INSTAGRAM');
          const id = await samantaRequest(who, 'en');
          const before = await stored(id);
          const { wamid } = await toOwner(id);
          const reply = await ownerSays('Proponer cambio', {
            replyTo: wamid,
            button: true,
          });
          expect(reply.ownerReplyOutcome).toBe('MODIFICATION_REQUESTED');
          const row = await noticed(id);
          expect(row).toMatchObject({
            status: 'MODIFICATION_REQUESTED',
            reservationAt: before.reservationAt,
            numberOfPeople: before.numberOfPeople,
            reservation: null,
          });
          const notice = row.customerNoticeMessage!;
          expect(notice).toMatchObject({
            channel: 'INSTAGRAM',
            conversationId: who.conversationId,
            idempotencyKey: `decision-${id}-MODIFICATION_REQUESTED`,
          });
          expect(notice.content).toContain('proposes a change');
          expect(notice.content).toContain('not confirmed yet');
          // A person coordinates the change: Samanta steps aside.
          expect(
            await db().conversation.findUniqueOrThrow({
              where: { id: who.conversationId },
            }),
          ).toMatchObject({
            isAssistantPaused: true,
            assistantPauseReason: 'SAMANTA_HANDOFF',
          });
          await deliver(notice.id);
          expect(send.INSTAGRAM).toHaveBeenCalledWith(
            expect.objectContaining({
              recipientExternalId: who.contact.externalId,
            }),
            notice.content,
          );
          // Leave no recent proposal behind for the owner's next answers.
          await db().reservationRequest.update({
            where: { id },
            data: { updatedAt: new Date(Date.now() - 2 * 86400000) },
          });
        });

        it.each(['FACEBOOK', 'INSTAGRAM'] as const)(
          '%s con la ventana de 24 h cerrada: no escribe y deja el motivo al equipo',
          async (channel) => {
            const who = await customerWrote(channel, 25);
            const id = await samantaRequest(who);
            const { wamid } = await toOwner(id);
            const reply = await ownerSays('Aceptar', {
              replyTo: wamid,
              button: true,
            });
            expect(reply.ownerReplyOutcome).toBe('ACCEPTED');
            const row = await noticed(id);
            expect(row.reservation).toMatchObject({ status: 'CONFIRMED' });
            expect(row.customerNoticeMessage).toBeNull();
            expect(row.customerNoticeError).toBe('WINDOW_CLOSED');
            expect(row.comments).toContain(
              'CRM: no se avisó al cliente la decisión del propietario (aceptada)',
            );
            expect(await decisionMessages(id)).toHaveLength(0);
            expect((await answerTo(reply.id))?.content).toContain(
              'No se pudo avisar al cliente',
            );
            expect((await detail(id)).customerNoticeError).toBe(
              'WINDOW_CLOSED',
            );
            expect(send[channel]).not.toHaveBeenCalled();
          },
        );

        it('WhatsApp de Samanta con la ventana cerrada: la plantilla aprobada, con plantillas activas', async () => {
          jest.replaceProperty(config(), 'decisionTemplatesEnabled', true);
          const who = await customerWrote('WHATSAPP', 25);
          const id = await samantaRequest(who);
          const { code, wamid } = await toOwner(id);
          await ownerSays('Rechazar', { replyTo: wamid, button: true });
          const row = await noticed(id);
          const notice = row.customerNoticeMessage!;
          const { date, time } = local(row.reservationAt!);
          expect(notice).toMatchObject({
            conversationId: who.conversationId,
            templateName: 'reserva_no_aprobada',
            templateLanguage: 'es',
            templateParameters: ['Carla', business, code, date, time],
            recipientPhone: who.contact.phone,
          });
          expect(notice.content).not.toMatch(/confirmad/i);
          await deliver(notice.id);
          expect(template).toHaveBeenCalledWith(
            expect.objectContaining({ recipientPhone: who.contact.phone }),
            expect.objectContaining({
              name: 'reserva_no_aprobada',
              parameters: ['Carla', business, code, date, time],
            }),
          );
          expect((await detail(id)).customerNoticeMessage).toMatchObject({
            templateName: 'reserva_no_aprobada',
            status: 'SENT',
          });
        });

        it('WEBSITE con la conversación de WhatsApp del cliente abierta: texto libre en esa conversación', async () => {
          const who = await customerWrote('WHATSAPP');
          const id = await webRequestFor(who.customerId, 'CUSTOMER_WAITING');
          const { wamid } = await toOwner(id);
          await ownerSays('Aceptar', { replyTo: wamid, button: true });
          const row = await noticed(id);
          expect(row.customerNoticeMessage).toMatchObject({
            conversationId: who.conversationId,
            channel: 'WHATSAPP',
            templateName: null,
          });
          expect(row.customerNoticeMessage!.content).toContain(
            row.reservation!.code,
          );
          expect(row.customerNoticeMessage!.content).toContain('4 personas');
        });

        it('WEBSITE con la ventana cerrada y el WhatsApp del formulario: plantilla reserva_aprobada', async () => {
          jest.replaceProperty(config(), 'decisionTemplatesEnabled', true);
          const customer = await webCustomer();
          const id = await webRequestFor(customer.id, 'DAILY_LIMIT');
          const { code, wamid } = await toOwner(id);
          await ownerSays('Aceptar', { replyTo: wamid, button: true });
          const row = await noticed(id);
          const { date, time } = local(row.reservation!.reservationAt);
          const parameters = [
            'Rosa',
            business,
            code,
            row.reservation!.code,
            date,
            time,
            '4 personas',
          ];
          expect(row.customerNoticeMessage).toMatchObject({
            channel: 'WHATSAPP',
            templateName: 'reserva_aprobada',
            templateParameters: parameters,
            recipientPhone: customer.phone,
          });
          // The conversation is created only to hold the notice.
          expect(
            await db().conversation.findUniqueOrThrow({
              where: { id: row.customerNoticeMessage!.conversationId },
            }),
          ).toMatchObject({ customerId: customer.id, channel: 'WHATSAPP' });
          await deliver(row.customerNoticeMessage!.id);
          expect(template).toHaveBeenCalledWith(
            expect.objectContaining({ recipientPhone: customer.phone }),
            expect.objectContaining({ name: 'reserva_aprobada', parameters }),
          );
        });

        it('WEBSITE con la ventana cerrada y las plantillas de aviso desactivadas: no escribe y deja el motivo', async () => {
          const customer = await webCustomer();
          const id = await webRequestFor(customer.id, 'DAILY_LIMIT');
          const { wamid } = await toOwner(id);
          await ownerSays('Rechazar', { replyTo: wamid, button: true });
          const row = await noticed(id);
          expect(row.customerNoticeError).toBe('TEMPLATES_OFF');
          expect(row.comments).toContain('(rechazada)');
          expect(await decisionMessages(id)).toHaveLength(0);
          expect(
            await db().conversation.count({
              where: { customerId: customer.id },
            }),
          ).toBe(0);
        });

        it('WEBSITE sin consentimiento (el formulario no trajo su WhatsApp): no escribe, aunque haya plantillas', async () => {
          jest.replaceProperty(config(), 'decisionTemplatesEnabled', true);
          const customer = await webCustomer();
          const id = await webRequestFor(customer.id, 'NO_WHATSAPP_NUMBER');
          const { wamid } = await toOwner(id);
          await ownerSays('Aceptar', { replyTo: wamid, button: true });
          const row = await noticed(id);
          expect(row.reservation).toMatchObject({ status: 'CONFIRMED' });
          expect(row.customerNoticeError).toBe('NO_CONSENT');
          expect(row.comments).toContain(
            'no nos escribió por WhatsApp ni dio su WhatsApp en el formulario',
          );
          expect(await decisionMessages(id)).toHaveLength(0);
          expect(
            await db().conversation.count({
              where: { customerId: customer.id },
            }),
          ).toBe(0);
          expect(template).not.toHaveBeenCalledWith(
            expect.objectContaining({ recipientPhone: customer.phone }),
            expect.anything(),
          );
        });

        it('conversación atendida por una persona (pausa manual): no escribe y avisa al equipo', async () => {
          const who = await customerWrote('WHATSAPP');
          const id = await samantaRequest(who);
          await db().conversation.update({
            where: { id: who.conversationId },
            data: {
              isAssistantPaused: true,
              assistantPauseReason: 'MANUAL',
              assistantPausedAt: new Date(),
            },
          });
          const { wamid } = await toOwner(id);
          await ownerSays('Aceptar', { replyTo: wamid, button: true });
          const row = await noticed(id);
          expect(row.customerNoticeError).toBe('PERSON_ATTENDING');
          expect(await decisionMessages(id)).toHaveLength(0);
        });

        it('fallo de transporte: reintenta hasta SENT; un fallo definitivo queda FAILED y visible', async () => {
          const retried = await customerWrote('WHATSAPP');
          const failed = await customerWrote('WHATSAPP');
          let retries = 1;
          send.WHATSAPP.mockImplementation((address: ChannelAddress) => {
            if (
              address.recipientPhone === retried.contact.phone &&
              retries-- > 0
            )
              return Promise.reject(new ChannelSendError('retry', 0));
            if (address.recipientPhone === failed.contact.phone)
              return Promise.reject(new ChannelSendError('failed'));
            return Promise.resolve(`wamid.out.${randomUUID()}`);
          });
          const sentTo = (phone?: string) =>
            send.WHATSAPP.mock.calls.filter(
              ([address]) =>
                (address as ChannelAddress).recipientPhone === phone,
            ).length;
          for (const who of [retried, failed]) {
            const id = await samantaRequest(who);
            const { wamid } = await toOwner(id);
            await ownerSays('Aceptar', { replyTo: wamid, button: true });
            const notice = (await noticed(id)).customerNoticeMessage!;
            await deliver(notice.id);
            const message = await db().message.findUniqueOrThrow({
              where: { id: notice.id },
            });
            if (who === retried) {
              expect(message.status).toBe('SENT');
              expect(sentTo(who.contact.phone)).toBe(2);
            } else {
              expect(message.status).toBe('FAILED');
              expect(message.errorCode).toBeTruthy();
              expect((await detail(id)).customerNoticeMessage).toMatchObject({
                status: 'FAILED',
              });
              // The decision stands: the reservation is not undone by a failed notice.
              expect(await reservationsOf(id)).toHaveLength(1);
            }
          }
        });

        it('webhook repetido, segundo toque y decisiones concurrentes: un solo aviso por solicitud', async () => {
          const who = await customerWrote('WHATSAPP');
          const id = await samantaRequest(who);
          const { wamid } = await toOwner(id);
          const externalMessageId = `wamid.in-${randomUUID()}`;
          await ownerSays('Aceptar', {
            replyTo: wamid,
            button: true,
            externalMessageId,
          });
          expect(
            (
              await ingest('Aceptar', {
                replyTo: wamid,
                button: true,
                externalMessageId,
              })
            ).duplicate,
          ).toBe(true);
          await ownerSays('Rechazar', { replyTo: wamid, button: true });
          const notices = await decisionMessages(id);
          expect(notices).toHaveLength(1);
          expect(notices[0].idempotencyKey).toBe(`decision-${id}-ACCEPTED`);

          const other = await customerWrote('WHATSAPP');
          const second = await samantaRequest(other);
          const target = await toOwner(second);
          const [accept, reject] = await Promise.all([
            ingest('Aceptar', { replyTo: target.wamid, button: true }),
            ingest('Rechazar', { replyTo: target.wamid, button: true }),
          ]);
          await Promise.all([
            processed(accept.message.id),
            processed(reject.message.id),
          ]);
          const final = (await stored(second)).status;
          const only = await decisionMessages(second);
          expect(only).toHaveLength(1);
          expect(only[0].idempotencyKey).toBe(`decision-${second}-${final}`);
          expect((await noticed(second)).customerNoticeMessageId).toBe(
            only[0].id,
          );
        });
      });
    });
  });
}
