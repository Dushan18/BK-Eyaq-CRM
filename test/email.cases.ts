import { randomBytes, randomInt } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { simpleParser } from 'mailparser';
import type { PrismaClient } from '../generated/prisma/client';
import { SAMANTA_USER_ID } from '../src/common/constants/system-users.constants';
import { zonedTimeToUtc } from '../src/common/zoned-time';
import { EmailConfig } from '../src/email/email.config';
import {
  EmailImportService,
  MAX_EMAIL_BYTES,
} from '../src/email/email-import.service';
import type {
  MailboxBatch,
  MailboxReadRequest,
} from '../src/email/mailbox-reader';
import { MessagesService } from '../src/messaging/messages.service';
import { OutboundMessagesService } from '../src/messaging/outbound-messages.service';
import { WebReservationService } from '../src/email/web-reservation.service';
import { SamantaContextService } from '../src/samanta/samanta-context.service';
import { WhatsAppAdapter } from '../src/whatsapp/whatsapp.adapter';

// Off: the app must not poll on its own; each test calls runOnce().
const emailTestEnv: Record<string, string> = { EMAIL_ENABLED: 'false' };
export const emailTestConfig = new EmailConfig({
  get: (key: string) => emailTestEnv[key],
} as unknown as ConfigService);

// In-memory mailbox with IMAP semantics: increasing UIDs, UIDVALIDITY, read-only.
const mailbox = {
  uidValidity: 7n,
  nextUid: 1n,
  messages: [] as {
    uid: bigint;
    source: Buffer;
    size: number;
    receivedAt: Date;
  }[],
};
export const emailTestReader = {
  read: jest.fn(async (request: MailboxReadRequest): Promise<MailboxBatch> => {
    const from =
      request.cursor && request.cursor.uidValidity === mailbox.uidValidity
        ? request.cursor.lastUid + 1n
        : 1n;
    const selected = mailbox.messages.filter((message) => message.uid >= from);
    const envelopes: MailboxBatch['envelopes'] = [];
    const sources = new Map<bigint, Buffer>();
    for (const message of selected.slice(0, request.limit)) {
      const parsed = await simpleParser(message.source);
      const envelope = {
        uid: message.uid,
        subject: parsed.subject ?? null,
        fromAddress: parsed.from?.value[0]?.address?.toLowerCase() ?? null,
        size: message.size,
        receivedAt: message.receivedAt,
      };
      envelopes.push(envelope);
      if (request.wanted(envelope)) sources.set(message.uid, message.source);
    }
    return {
      uidValidity: mailbox.uidValidity,
      uidNext: mailbox.nextUid,
      complete: selected.length <= request.limit,
      envelopes,
      sources,
    };
  }),
};

const WEB_SENDER = 'web@restaurante.test';
const encode = (text: string) =>
  `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
function deliver(
  subject: string,
  body: string,
  from = WEB_SENDER,
  extra: {
    receivedAt?: Date;
    size?: number;
    headers?: string[];
    date?: string;
  } = {},
) {
  const uid = mailbox.nextUid++;
  const source = Buffer.from(
    [
      ...(extra.headers ?? []),
      `From: ${encode('Sabor Mágico Grill')} <${from}>`,
      'To: reservas@restaurante.test',
      `Subject: ${encode(subject)}`,
      `Message-ID: <${randomBytes(8).toString('hex')}@restaurante.test>`,
      `Date: ${extra.date ?? new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n'),
  );
  mailbox.messages.push({
    uid,
    source,
    size: extra.size ?? source.length,
    receivedAt: extra.receivedAt ?? new Date(),
  });
  return uid;
}
// A local date `days` ahead in Lima, as the form writes it.
function limaDate(days: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(Date.now() + days * 86400000))
      .map((part) => [part.type, part.value]),
  );
  return {
    text: `${parts.day}/${parts.month}/${parts.year}`,
    local: {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
    },
  };
}
function reservation(
  extra: {
    phone?: string;
    days?: number;
    message?: string;
    country?: string;
  } = {},
) {
  const date = limaDate(extra.days ?? 10);
  const code = `SM-${date.text.split('/').reverse().join('')}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const phone = extra.phone ?? `+519${randomInt(10000000, 99999999)}`;
  const email = `cliente.${randomBytes(4).toString('hex')}@example.com`;
  const body = [
    'NUEVA SOLICITUD DE RESERVA',
    `Código: ${code}`,
    'Estado: PENDIENTE DE CONFIRMACIÓN',
    'Idioma del cliente: ES',
    '',
    'Nombre: Ana Prueba',
    `Email: ${email}`,
    `WhatsApp: ${phone}`,
    `País: ${extra.country ?? 'Francia'}`,
    '',
    `Fecha: ${date.text}`,
    'Hora: 19:30',
    'Personas: 3',
    'Preferencia: Mesa en el balcón',
    `Mensaje: ${extra.message ?? 'Sin mensaje adicional'}`,
    '',
    'Responde directamente a este correo para confirmar o coordina por WhatsApp.',
  ].join('\r\n');
  return {
    code,
    phone,
    email,
    date,
    subject: `Nueva reserva ${code} · ${date.text} 19:30`,
    body,
  };
}

interface Context {
  app: () => INestApplication;
  prisma: () => PrismaClient;
}
export function registerEmailTests(c: Context) {
  describe('Reservas de la web desde el correo (IMAP simulado, PostgreSQL real)', () => {
    const db = () => c.prisma();
    const importer = () => c.app().get(EmailImportService);
    const imported = (code: string) =>
      db().inboundEmail.findMany({
        where: { externalReference: code },
        orderBy: { uid: 'asc' },
      });
    beforeEach(() => {
      jest.replaceProperty(
        emailTestConfig,
        'user',
        'reservas@restaurante.test',
      );
      jest.replaceProperty(emailTestConfig, 'reservationSenders', [WEB_SENDER]);
      jest.replaceProperty(emailTestConfig, 'whatsappContact', true);
      jest.replaceProperty(emailTestConfig, 'templateLanguages', [
        'es',
        'en_US',
      ]);
    });
    afterEach(() => jest.restoreAllMocks());
    const requestOf = (code: string) =>
      db().reservationRequest.findUniqueOrThrow({
        where: { externalReference: code },
      });
    // A WhatsApp message from the customer, as the webhook would ingest it.
    const inbound = (phone: string, content: string) =>
      c
        .app()
        .get(MessagesService)
        .ingestInboundMessage({
          channel: 'WHATSAPP',
          externalMessageId: `wamid.${randomBytes(8).toString('hex')}`,
          providerAccountId: '123',
          contact: { phone },
          type: 'TEXT',
          content,
          occurredAt: new Date().toISOString(),
        });
    // Our reply in that conversation: the customer is no longer waiting.
    const answered = async (phone: string) => {
      const conversation = await db().conversation.findFirstOrThrow({
        where: { channel: 'WHATSAPP', customer: { normalizedPhone: phone } },
      });
      await c
        .app()
        .get(OutboundMessagesService)
        .queueOutboundMessage(
          conversation.id,
          SAMANTA_USER_ID,
          `test-reply-${randomBytes(8).toString('hex')}`,
          { type: 'TEXT', content: '¡Hola! Ya vemos tu reserva.' },
        );
    };

    it('crea cliente y solicitud, y escribe por WhatsApp con la plantilla', async () => {
      const web = reservation();
      const uid = deliver(web.subject, web.body);
      await importer().runOnce();
      const [email] = await imported(web.code);
      expect(email).toMatchObject({
        status: 'IMPORTED',
        kind: 'WEB_RESERVATION',
        errorCode: null,
        contactError: null,
        fromAddress: WEB_SENDER,
        uid,
      });
      const request = await db().reservationRequest.findUniqueOrThrow({
        where: { externalReference: web.code },
        include: { customer: true },
      });
      expect(request).toMatchObject({
        id: email.reservationRequestId,
        sourceChannel: 'WEBSITE',
        status: 'READY_TO_SEND',
        numberOfPeople: 3,
        specialRequirements: 'Mesa en el balcón',
        comments: 'País: Francia',
        reservationAt: zonedTimeToUtc(
          { ...web.date.local, hour: 19, minute: 30 },
          'America/Lima',
        ),
      });
      expect(request.code).toMatch(/^RES-\d{4}-\d{6}$/);
      expect(request.customer).toMatchObject({
        firstName: 'Ana Prueba',
        normalizedPhone: web.phone,
        normalizedEmail: web.email,
        sourceChannel: 'WEBSITE',
        status: 'REQUESTED_RESERVATION',
      });
      const message = await db().message.findUniqueOrThrow({
        where: { id: email.whatsappMessageId! },
        include: { conversation: true, outbox: true },
      });
      expect(message).toMatchObject({
        direction: 'OUTBOUND',
        status: 'QUEUED',
        channel: 'WHATSAPP',
        authorUserId: SAMANTA_USER_ID,
        recipientPhone: web.phone,
        templateName: 'solicitud_reserva_web',
        templateLanguage: 'es',
        templateParameters: [
          'Ana Prueba',
          web.code,
          web.date.text,
          '19:30',
          '3',
        ],
        outbox: { status: 'PENDING' },
      });
      expect(message.conversation.customerId).toBe(request.customerId);
      expect(message.content).toContain(web.code);
      expect(
        (
          await db().mailboxCursor.findUniqueOrThrow({
            where: { mailbox: importer().mailbox },
          })
        ).lastUid,
      ).toBe(uid);
    });
    it('no repite: otra lectura no hace nada y un reenvío del mismo código se omite', async () => {
      const web = reservation();
      deliver(web.subject, web.body);
      await importer().runOnce();
      await importer().runOnce();
      expect(await imported(web.code)).toHaveLength(1);
      deliver(web.subject, web.body);
      await importer().runOnce();
      const [first, again] = await imported(web.code);
      expect(again).toMatchObject({
        status: 'SKIPPED',
        errorCode: 'DUPLICATE_REFERENCE',
        reservationRequestId: first.reservationRequestId,
        whatsappMessageId: null,
      });
      expect(
        await db().reservationRequest.count({
          where: { externalReference: web.code },
        }),
      ).toBe(1);
    });
    it('una reserva con fecha pasada se registra sin crear solicitud', async () => {
      const web = reservation({ days: -2 });
      deliver(web.subject, web.body);
      await importer().runOnce();
      expect(await imported(web.code)).toMatchObject([
        {
          status: 'SKIPPED',
          errorCode: 'PAST_DATE',
          reservationRequestId: null,
        },
      ]);
      expect(
        await db().customer.count({ where: { normalizedPhone: web.phone } }),
      ).toBe(0);
    });
    it('un remitente distinto al de la web no crea nada', async () => {
      const web = reservation();
      deliver(web.subject, web.body, 'falso@otro-dominio.test');
      await importer().runOnce();
      const rows = await db().inboundEmail.findMany({
        where: { fromAddress: 'falso@otro-dominio.test' },
      });
      expect(rows.at(-1)).toMatchObject({
        status: 'SKIPPED',
        errorCode: 'SENDER_NOT_ALLOWED',
        customerId: null,
      });
      expect(
        await db().customer.count({ where: { normalizedPhone: web.phone } }),
      ).toBe(0);
    });
    it('los demás correos ni se descargan ni se guardan, pero el cursor avanza', async () => {
      const before = await db().inboundEmail.count();
      const uid = deliver('Custom Branded Cups', 'Promoción de vasos');
      await importer().runOnce();
      expect(await db().inboundEmail.count()).toBe(before);
      const call = emailTestReader.read.mock.calls.at(-1)![0];
      expect(
        call.wanted({
          uid,
          subject: 'Custom Branded Cups',
          fromAddress: null,
          size: 100,
          receivedAt: new Date(),
        }),
      ).toBe(false);
      expect(
        (
          await db().mailboxCursor.findUniqueOrThrow({
            where: { mailbox: importer().mailbox },
          })
        ).lastUid,
      ).toBe(uid);
    });
    it('un correo sin código queda como fallido y no bloquea los siguientes', async () => {
      const broken = reservation();
      const uid = deliver(
        'Nueva reserva SM-roto',
        broken.body.replace(/Código: .*/, 'Código: -'),
      );
      const web = reservation();
      deliver(web.subject, web.body);
      await importer().runOnce();
      expect(
        await db().inboundEmail.findFirst({
          where: { uid, mailbox: importer().mailbox },
        }),
      ).toMatchObject({
        status: 'FAILED',
        errorCode: 'RESERVATION_CODE_MISSING',
      });
      expect(await imported(web.code)).toMatchObject([{ status: 'IMPORTED' }]);
    });
    it('si el cliente escribió por WhatsApp hace poco, recibe un mensaje normal', async () => {
      const web = reservation();
      await c
        .app()
        .get(MessagesService)
        .ingestInboundMessage({
          channel: 'WHATSAPP',
          externalMessageId: `wamid.${randomBytes(8).toString('hex')}`,
          providerAccountId: '123',
          contact: { phone: web.phone },
          type: 'TEXT',
          content: 'Hola, acabo de reservar en la web',
          occurredAt: new Date().toISOString(),
        });
      await answered(web.phone);
      deliver(web.subject, web.body);
      await importer().runOnce();
      const [email] = await imported(web.code);
      const message = await db().message.findUniqueOrThrow({
        where: { id: email.whatsappMessageId! },
      });
      expect(message).toMatchObject({
        templateName: null,
        templateParameters: [],
        authorUserId: SAMANTA_USER_ID,
        status: 'QUEUED',
      });
      expect(message.content).toContain(web.code);
    });
    it('si el cliente está escribiendo por WhatsApp, no le manda el aviso', async () => {
      const web = reservation();
      await inbound(web.phone, '¿Tienen estacionamiento?');
      deliver(web.subject, web.body);
      await importer().runOnce();
      const [email] = await imported(web.code);
      expect(email).toMatchObject({
        status: 'IMPORTED',
        contactError: 'CUSTOMER_WAITING',
        whatsappMessageId: null,
      });
      expect((await requestOf(web.code)).comments).toContain(
        'CRM: no se le escribió por WhatsApp: el cliente está escribiendo',
      );
    });
    it('reconoce al cliente por su teléfono sin cambiar sus datos', async () => {
      const web = reservation();
      const existing = await db().customer.create({
        data: {
          phone: web.phone,
          normalizedPhone: web.phone,
          sourceChannel: 'WHATSAPP',
        },
      });
      deliver(web.subject, web.body);
      await importer().runOnce();
      expect(
        await db().customer.findUniqueOrThrow({ where: { id: existing.id } }),
      ).toMatchObject({
        normalizedEmail: null,
        firstName: null,
        status: 'REQUESTED_RESERVATION',
      });
      expect((await imported(web.code))[0].customerId).toBe(existing.id);
      expect((await requestOf(web.code)).comments).toContain(
        `CRM: correo del formulario: ${web.email}`,
      );
    });
    it('el correo de otro cliente no le pone otro número: crea un cliente con el WhatsApp del formulario', async () => {
      const web = reservation();
      const otherPhone = `+519${randomInt(10000000, 99999999)}`;
      const other = await db().customer.create({
        data: {
          email: web.email,
          normalizedEmail: web.email,
          phone: otherPhone,
          normalizedPhone: otherPhone,
          sourceChannel: 'WEBSITE',
        },
      });
      deliver(web.subject, web.body);
      await importer().runOnce();
      const [email] = await imported(web.code);
      expect(email.customerId).not.toBe(other.id);
      expect(
        await db().customer.findUniqueOrThrow({
          where: { id: email.customerId! },
        }),
      ).toMatchObject({ normalizedPhone: web.phone, normalizedEmail: null });
      expect(
        await db().customer.findUniqueOrThrow({ where: { id: other.id } }),
      ).toMatchObject({
        normalizedPhone: otherPhone,
        normalizedEmail: web.email,
      });
      expect(
        await db().message.findUniqueOrThrow({
          where: { id: email.whatsappMessageId! },
        }),
      ).toMatchObject({ recipientPhone: web.phone });
      expect((await requestOf(web.code)).comments).toContain(
        '(registrado en otro cliente)',
      );
    });
    it('lee un número nacional con el país del formulario', async () => {
      const national = `9${randomInt(10000000, 99999999)}`;
      const web = reservation({
        phone: `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`,
        country: 'Perú',
      });
      deliver(web.subject, web.body);
      await importer().runOnce();
      const [email] = await imported(web.code);
      expect(
        await db().customer.findUniqueOrThrow({
          where: { id: email.customerId! },
        }),
      ).toMatchObject({ normalizedPhone: `+51${national}` });
    });
    it('una pausa antigua no impide escribir; una reciente sí', async () => {
      for (const [hours, expected] of [
        [48, null],
        [2, 'CONVERSATION_PAUSED'],
      ] as const) {
        const web = reservation();
        const customer = await db().customer.create({
          data: {
            phone: web.phone,
            normalizedPhone: web.phone,
            sourceChannel: 'WHATSAPP',
          },
        });
        await db().conversation.create({
          data: {
            customerId: customer.id,
            channel: 'WHATSAPP',
            isAssistantPaused: true,
            assistantPauseReason: 'OPERATOR_REPLIED',
            assistantPausedAt: new Date(Date.now() - hours * 3600000),
          },
        });
        deliver(web.subject, web.body);
        await importer().runOnce();
        expect(await imported(web.code)).toMatchObject([
          { status: 'IMPORTED', contactError: expected },
        ]);
      }
    });
    it('después de una plantilla, otra solo espera si la ventana sigue cerrada', async () => {
      const first = reservation();
      deliver(first.subject, first.body);
      await importer().runOnce();
      const second = reservation({ phone: first.phone });
      deliver(second.subject, second.body);
      await importer().runOnce();
      expect(await imported(second.code)).toMatchObject([
        { contactError: 'TEMPLATE_RECENTLY_SENT', whatsappMessageId: null },
      ]);
      // The customer answered the template and we replied: the window is open.
      await inbound(first.phone, 'Sí, continuar');
      await answered(first.phone);
      const third = reservation({ phone: first.phone });
      deliver(third.subject, third.body);
      await importer().runOnce();
      const [email] = await imported(third.code);
      expect(email.contactError).toBeNull();
      expect(
        await db().message.findUniqueOrThrow({
          where: { id: email.whatsappMessageId! },
        }),
      ).toMatchObject({ templateName: null });
    });
    it('respeta el tope diario de plantillas', async () => {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      jest.replaceProperty(
        emailTestConfig,
        'dailyTemplateLimit',
        await db().message.count({
          where: { templateName: { not: null }, createdAt: { gte: start } },
        }),
      );
      const web = reservation();
      deliver(web.subject, web.body);
      await importer().runOnce();
      expect(await imported(web.code)).toMatchObject([
        {
          status: 'IMPORTED',
          contactError: 'DAILY_LIMIT',
          whatsappMessageId: null,
        },
      ]);
      // Nothing was sent, so no empty conversation appears in the inbox.
      expect(
        await db().conversation.count({
          where: { customer: { normalizedPhone: web.phone } },
        }),
      ).toBe(0);
    });
    it('sin contacto por WhatsApp solo importa', async () => {
      jest.replaceProperty(emailTestConfig, 'whatsappContact', false);
      const web = reservation();
      deliver(web.subject, web.body);
      await importer().runOnce();
      expect(await imported(web.code)).toMatchObject([
        {
          status: 'IMPORTED',
          contactError: 'WHATSAPP_CONTACT_OFF',
          whatsappMessageId: null,
        },
      ]);
    });
    it('un aviso que llegó hace más de un día se importa sin escribir al cliente', async () => {
      const web = reservation();
      deliver(web.subject, web.body, WEB_SENDER, {
        receivedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      });
      await importer().runOnce();
      const [email] = await imported(web.code);
      expect(email).toMatchObject({
        status: 'IMPORTED',
        contactError: 'EMAIL_TOO_OLD',
        whatsappMessageId: null,
      });
      expect(email.receivedAt).not.toBeNull();
      expect((await requestOf(web.code)).comments).toContain(
        'CRM: no se le escribió por WhatsApp: el aviso llegó hace más de 24 h.',
      );
      expect(
        await db().reservationRequest.count({
          where: { externalReference: web.code },
        }),
      ).toBe(1);
    });
    it('un correo enorme con el asunto de la web no se descarga', async () => {
      const web = reservation();
      const uid = deliver(web.subject, web.body, WEB_SENDER, {
        size: MAX_EMAIL_BYTES + 1,
      });
      await importer().runOnce();
      const call = emailTestReader.read.mock.calls.at(-1)![0];
      expect(
        call.wanted({
          uid,
          subject: web.subject,
          fromAddress: WEB_SENDER,
          size: MAX_EMAIL_BYTES + 1,
          receivedAt: new Date(),
        }),
      ).toBe(false);
      expect(
        await db().inboundEmail.findFirst({
          where: { uid, mailbox: importer().mailbox },
        }),
      ).toMatchObject({
        status: 'FAILED',
        errorCode: 'EMAIL_TOO_LARGE',
        reservationRequestId: null,
      });
    });
    it('un asunto con un carácter nulo o una fecha imposible no bloquean el buzón', async () => {
      const web = reservation();
      const uid = deliver(`${web.subject}\u0000`, web.body, WEB_SENDER, {
        date: '0000-01-01T00:00:00Z',
      });
      await importer().runOnce();
      const row = await db().inboundEmail.findFirstOrThrow({
        where: { uid, mailbox: importer().mailbox },
      });
      expect(row).toMatchObject({ status: 'IMPORTED', sentAt: null });
      expect(row.subject).not.toContain('\u0000');
    });
    it('un correo que no se puede guardar se marca tras varios intentos y no bloquea los siguientes', async () => {
      const service = c.app().get(WebReservationService);
      const original = service.import.bind(service) as typeof service.import;
      const broken = reservation();
      const badUid = deliver(broken.subject, broken.body);
      const next = reservation();
      deliver(next.subject, next.body);
      jest
        .spyOn(service, 'import')
        .mockImplementation((tx, meta, result) =>
          meta.uid === badUid &&
          !(result.ok === false && result.errorCode === 'EMAIL_UNSTORABLE')
            ? Promise.reject(new Error('fallo de prueba'))
            : original(tx, meta, result),
        );
      for (let attempt = 1; attempt < 5; attempt++)
        await expect(importer().runOnce()).rejects.toThrow('fallo de prueba');
      await importer().runOnce();
      expect(
        await db().inboundEmail.findFirstOrThrow({
          where: { uid: badUid, mailbox: importer().mailbox },
        }),
      ).toMatchObject({
        status: 'FAILED',
        errorCode: 'EMAIL_UNSTORABLE',
        subject: null,
      });
      expect(await imported(next.code)).toMatchObject([{ status: 'IMPORTED' }]);
    });
    it('volver a leer un correo ya registrado no falla', async () => {
      const web = reservation();
      const uid = deliver(web.subject, web.body);
      await importer().runOnce();
      await db().mailboxCursor.update({
        where: { mailbox: importer().mailbox },
        data: { lastUid: uid - 1n },
      });
      await importer().runOnce();
      expect(await imported(web.code)).toHaveLength(1);
      expect(
        (
          await db().mailboxCursor.findUniqueOrThrow({
            where: { mailbox: importer().mailbox },
          })
        ).lastUid,
      ).toBeGreaterThanOrEqual(uid);
    });
    it('con la cuenta del hosting configurada, solo acepta avisos que salieron de ella', async () => {
      jest.replaceProperty(emailTestConfig, 'hostingAccount', 'sabormgic');
      const lmtp =
        'Received: from mail.restaurante.test\r\n\tby mail.restaurante.test with LMTP id abc; Fri, 30 Oct 2026 05:00:33 +0530';
      const local =
        'Received: from sabormgic by mail.restaurante.test with local (Exim 4.100.1)\r\n\t(envelope-from <web@restaurante.test>) id 1x; Fri, 30 Oct 2026 05:00:32 +0530';
      const outside =
        'Received: from evil.example ([203.0.113.9]) by mail.restaurante.test with esmtps (TLS1.3) (Exim 4.100.1) id 2y; Fri, 30 Oct 2026 05:00:31 +0530';
      const genuine = reservation();
      deliver(genuine.subject, genuine.body, WEB_SENDER, {
        headers: [lmtp, local],
      });
      const forged = reservation();
      deliver(forged.subject, forged.body, WEB_SENDER, {
        headers: [lmtp, outside, local],
      });
      const bare = reservation();
      deliver(bare.subject, bare.body);
      await importer().runOnce();
      expect(await imported(genuine.code)).toMatchObject([
        { status: 'IMPORTED' },
      ]);
      expect(
        await db().inboundEmail.count({
          where: { errorCode: 'SENDER_NOT_VERIFIED', status: 'SKIPPED' },
        }),
      ).toBeGreaterThanOrEqual(2);
      expect(
        await db().reservationRequest.count({
          where: { externalReference: { in: [forged.code, bare.code] } },
        }),
      ).toBe(0);
    });
    it('una plantilla que esperó más de 6 h en cola ya no se envía', async () => {
      const web = reservation();
      deliver(web.subject, web.body);
      await importer().runOnce();
      const [email] = await imported(web.code);
      await db().message.update({
        where: { id: email.whatsappMessageId! },
        data: { createdAt: new Date(Date.now() - 7 * 3600000) },
      });
      const sendTemplate = jest.spyOn(
        c.app().get(WhatsAppAdapter),
        'sendTemplate',
      );
      await expect(
        c.app().get(OutboundMessagesService).process(email.whatsappMessageId!),
      ).resolves.toBe('terminal');
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(
        await db().message.findUniqueOrThrow({
          where: { id: email.whatsappMessageId! },
        }),
      ).toMatchObject({
        status: 'FAILED',
        errorCode: 'WHATSAPP_TEMPLATE_EXPIRED',
      });
    });
    it('el envío usa la plantilla con la ventana cerrada', async () => {
      const web = reservation();
      deliver(web.subject, web.body);
      await importer().runOnce();
      const [email] = await imported(web.code);
      const sendTemplate = jest
        .spyOn(c.app().get(WhatsAppAdapter), 'sendTemplate')
        .mockResolvedValue('wamid.template-sent');
      const sendMessage = jest.spyOn(
        c.app().get(WhatsAppAdapter),
        'sendMessage',
      );
      await expect(
        c.app().get(OutboundMessagesService).process(email.whatsappMessageId!),
      ).resolves.toBe('processed');
      expect(sendTemplate).toHaveBeenCalledWith(
        { recipientPhone: web.phone, recipientExternalId: null },
        {
          name: 'solicitud_reserva_web',
          language: 'es',
          parameters: ['Ana Prueba', web.code, web.date.text, '19:30', '3'],
        },
      );
      expect(sendMessage).not.toHaveBeenCalled();
      expect(
        await db().message.findUniqueOrThrow({
          where: { id: email.whatsappMessageId! },
        }),
      ).toMatchObject({
        status: 'SENT',
        externalMessageId: 'wamid.template-sent',
      });
    });
    it('Samanta recibe la solicitud pendiente para no volver a pedir los datos', async () => {
      const web = reservation({ message: 'Es un cumpleaños' });
      deliver(web.subject, web.body);
      await importer().runOnce();
      const [email] = await imported(web.code);
      const { conversationId } = await db().message.findUniqueOrThrow({
        where: { id: email.whatsappMessageId! },
      });
      const { context } = await db().$transaction((tx) =>
        c.app().get(SamantaContextService).build(tx, conversationId, 4096),
      );
      const parsed = JSON.parse(context) as {
        customer: {
          name: string;
          pendingReservations: {
            code: string;
            channel: string;
            people: number;
            at: { local: string } | null;
            formNotes: string | null;
          }[];
        };
      };
      expect(parsed.customer.name).toBe('Ana Prueba');
      expect(parsed.customer.pendingReservations).toMatchObject([
        {
          code: web.code,
          channel: 'WEBSITE',
          people: 3,
          formNotes: 'Mesa en el balcón\nEs un cumpleaños\nPaís: Francia',
        },
      ]);
      expect(parsed.customer.pendingReservations[0].at?.local).toBe(
        `${web.date.text.split('/').reverse().join('-')} 19:30`,
      );
      expect(context).not.toContain(web.email);
    });
  });
}
