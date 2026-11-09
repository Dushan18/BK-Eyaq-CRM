import {
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getCountries } from 'libphonenumber-js/max';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { normalizeContact } from '../common/contact-normalization';
import { SAMANTA_USER_ID } from '../common/constants/system-users.constants';
import { CRM_NOTE } from '../common/crm-note';
import { zonedTimeToUtc } from '../common/zoned-time';
import { OutboundMessagesService } from '../messaging/outbound-messages.service';
import { ReservationSupportService } from '../reservations/reservation-support.service';
import { requestCompleteness } from '../reservations/reservation-rules';
import { EmailConfig } from './email.config';
import type {
  WebReservation,
  WebReservationResult,
} from './web-reservation.parser';

export interface EmailMeta {
  mailbox: string;
  uidValidity: bigint;
  uid: bigint;
  messageId: string | null;
  fromAddress: string | null;
  subject: string | null;
  sentAt: Date | null;
  // When the mail server received it (IMAP INTERNALDATE).
  receivedAt: Date | null;
  // Whether the restaurant's mail server got it from the website's hosting account
  // (null when WEB_RESERVATION_HOSTING_ACCOUNT is not set).
  fromHostingAccount: boolean | null;
}
// What the importer could read from the email: a parsed notice or why not.
export type ImportInput =
  | WebReservationResult
  | {
      ok: false;
      errorCode:
        | 'EMAIL_UNREADABLE'
        | 'EMAIL_TOO_LARGE'
        | 'SENDER_NOT_ALLOWED'
        | 'EMAIL_UNSTORABLE';
    };
// The email cannot be imported yet (the restaurant is not configured): the importer
// retries it on every poll, without limit.
export class ImportDeferredError extends Error {
  constructor() {
    super('Configura el restaurante antes de importar reservas');
    this.name = 'ImportDeferredError';
  }
}
interface Restaurant {
  businessName: string;
  timeZone: string;
}
interface Details {
  name: string;
  code: string;
  business: string;
  date: string | null;
  time: string | null;
  people: string | null;
}
type ContactResult = { messageId?: string; error?: string };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A name typed in a public form: words of letters only (no dots, so no domains WhatsApp
// would turn into links), so the form cannot inject links or a message through it. The
// WhatsApp greeting uses up to 4 words; the stored name up to 6.
export function safeName(name: string | null, words = 4, length = 40) {
  const clean = name
    ?.normalize('NFC')
    .replace(/[^\p{L}\p{M}' -]/gu, ' ')
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, words)
    .join(' ')
    .slice(0, length)
    .trim();
  return clean || null;
}
const fold = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
let countryCodes: Map<string, string> | undefined;
// "Perú", "Peru", "Francia", "France" → ISO code, to read a national number
// ("987 654 321") in the country the form gave.
function countryCode(country: string | null) {
  if (!country) return null;
  if (!countryCodes) {
    const names = ['es', 'en'].map(
      (locale) => new Intl.DisplayNames([locale], { type: 'region' }),
    );
    countryCodes = new Map(
      getCountries().flatMap((code) =>
        names.map((name) => [fold(name.of(code) ?? code), code] as const),
      ),
    );
  }
  return countryCodes.get(fold(country)) ?? null;
}
// The CRM's rendering of the template for the history (and the text sent when the
// window is already open). Keep it in line with the template approved in Meta.
const render: Record<'es' | 'en', (d: Details) => string> = {
  es: (d) =>
    `Hola ${d.name}, recibimos tu solicitud de reserva ${d.code} en ${d.business}` +
    (d.date ? ` para el ${d.date}` : '') +
    (d.time ? ` a las ${d.time}` : '') +
    (d.people ? `, ${d.people} personas` : '') +
    '. ¿Continuamos por aquí para confirmarla?',
  en: (d) =>
    `Hi ${d.name}, we received your reservation request ${d.code} at ${d.business}` +
    (d.date ? ` for ${d.date}` : '') +
    (d.time ? ` at ${d.time}` : '') +
    (d.people ? `, ${d.people} people` : '') +
    '. Shall we continue here to confirm it?',
};
// Why the customer got no WhatsApp, for staff: written into the request's comments.
const NOT_CONTACTED: Record<string, string> = {
  NO_WHATSAPP_NUMBER: 'el formulario no trae un WhatsApp válido',
  CONVERSATION_PAUSED: 'su conversación de WhatsApp la atiende una persona',
  CUSTOMER_WAITING:
    'el cliente está escribiendo por WhatsApp; la respuesta ya tiene esta solicitud',
  TEMPLATE_RECENTLY_SENT: 'ya recibió una plantilla en las últimas 24 h',
  INCOMPLETE_FOR_TEMPLATE: 'faltan la fecha, la hora o las personas',
  DAILY_LIMIT: 'se alcanzó el tope diario de plantillas',
  WHATSAPP_DISABLED: 'WhatsApp está desactivado en el servidor',
  NO_WHATSAPP_RECIPIENT: 'WhatsApp no acepta ese número',
};

// Turns a website reservation email into a customer and a reservation request, and
// contacts the customer on WhatsApp. Runs inside the importer's transaction: the email
// record, the request and the queued message are committed together or not at all.
@Injectable()
export class WebReservationService {
  constructor(
    private readonly config: EmailConfig,
    private readonly support: ReservationSupportService,
    private readonly outbound: OutboundMessagesService,
  ) {}

  async import(
    tx: Prisma.TransactionClient,
    meta: EmailMeta,
    result: ImportInput,
  ) {
    const id = randomUUID();
    const record = (
      data: Pick<Prisma.InboundEmailUncheckedCreateInput, 'status'> &
        Partial<Prisma.InboundEmailUncheckedCreateInput>,
    ) =>
      tx.inboundEmail.create({
        data: {
          id,
          mailbox: meta.mailbox,
          uidValidity: meta.uidValidity,
          uid: meta.uid,
          messageId: meta.messageId?.slice(0, 998) ?? null,
          fromAddress: meta.fromAddress?.slice(0, 320) ?? null,
          subject: meta.subject?.slice(0, 998) ?? null,
          sentAt: meta.sentAt,
          receivedAt: meta.receivedAt,
          kind: 'WEB_RESERVATION',
          ...data,
        },
      });
    if (!result.ok)
      return record({
        status:
          result.errorCode === 'SENDER_NOT_ALLOWED' ? 'SKIPPED' : 'FAILED',
        errorCode: result.errorCode,
      });
    // Anyone can send an email with this subject; only the website's sender creates
    // requests, and when configured, only from the website's hosting account.
    if (
      !meta.fromAddress ||
      !this.config.reservationSenders.includes(meta.fromAddress)
    )
      return record({ status: 'SKIPPED', errorCode: 'SENDER_NOT_ALLOWED' });
    if (this.config.hostingAccount && meta.fromHostingAccount !== true)
      return record({ status: 'SKIPPED', errorCode: 'SENDER_NOT_VERIFIED' });
    const reservation = result.reservation;
    const externalReference = reservation.code;
    // The same website code twice (a resent or forwarded email): one request only.
    const duplicate = await tx.reservationRequest.findUnique({
      where: { externalReference },
      select: { id: true, customerId: true },
    });
    if (duplicate)
      return record({
        status: 'SKIPPED',
        errorCode: 'DUPLICATE_REFERENCE',
        externalReference,
        reservationRequestId: duplicate.id,
        customerId: duplicate.customerId,
      });
    const restaurant = await tx.restaurantConfig.findUnique({
      where: { scope: 'GLOBAL' },
      select: { businessName: true, timeZone: true },
    });
    // Not recorded: the importer retries this email once the restaurant is configured.
    if (!restaurant) throw new ImportDeferredError();
    const now = new Date();
    const notes = [...reservation.unparsed];
    let at =
      reservation.date && reservation.time
        ? zonedTimeToUtc(
            { ...reservation.date, ...reservation.time },
            restaurant.timeZone,
          )
        : null;
    // 31/11 or 24:00: no date, and staff see what the form said.
    if (reservation.date && reservation.time && !at) {
      const pad = (value: number) => String(value).padStart(2, '0');
      const { day, month, year } = reservation.date;
      const { hour, minute } = reservation.time;
      notes.push(
        `${CRM_NOTE}fecha y hora no válidas en el formulario: ${pad(day)}/${pad(month)}/${year} ${pad(hour)}:${pad(minute)}`,
      );
      at = null;
    }
    if (at && at <= now)
      return record({
        status: 'SKIPPED',
        errorCode: 'PAST_DATE',
        externalReference,
      });
    // When the customer reached out: the email's arrival, never later than now.
    const contactAt =
      meta.receivedAt && meta.receivedAt < now ? meta.receivedAt : now;
    const found = await this.customer(tx, reservation, contactAt, notes);
    if (!found)
      return record({
        status: 'FAILED',
        errorCode: 'CONTACT_INVALID',
        externalReference,
      });
    const { customer, formPhone } = found;
    // Without a receive date the age is unknown: treated as old, nobody is written to.
    const recent =
      meta.receivedAt !== null &&
      now.getTime() - meta.receivedAt.getTime() <=
        this.config.contactMaxHours * HOUR_MS;
    const contact: ContactResult = !this.config.whatsappContact
      ? { error: 'WHATSAPP_CONTACT_OFF' }
      : !recent
        ? { error: 'EMAIL_TOO_OLD' }
        : await this.contact(
            tx,
            id,
            customer,
            formPhone,
            reservation,
            restaurant,
            at,
          );
    const reason =
      contact.error === 'EMAIL_TOO_OLD'
        ? `el aviso llegó hace más de ${this.config.contactMaxHours} h`
        : contact.error && NOT_CONTACTED[contact.error];
    if (reason)
      notes.push(`${CRM_NOTE}no se le escribió por WhatsApp: ${reason}.`);
    const code = await this.support.code(
      tx,
      'request',
      restaurant.timeZone,
      now,
    );
    const request = await tx.reservationRequest.create({
      data: {
        code,
        externalReference,
        customerId: customer.id,
        sourceChannel: 'WEBSITE',
        reservationAt: at,
        numberOfPeople: reservation.people,
        comments:
          [
            reservation.message,
            reservation.country ? `País: ${reservation.country}` : null,
            ...notes,
          ]
            .filter(Boolean)
            .join('\n') || null,
        specialRequirements: reservation.preference,
        status: requestCompleteness(at, reservation.people),
        createdAt: now,
      },
      select: { id: true },
    });
    return record({
      status: 'IMPORTED',
      externalReference,
      customerId: customer.id,
      reservationRequestId: request.id,
      whatsappMessageId: contact.messageId ?? null,
      contactError: contact.error ?? null,
    });
  }

  // The form's WhatsApp identifies the customer (it is where we answer); without a valid
  // one, the email does. A public form is not proof of identity: it never adds a phone,
  // an email or a name to an existing customer (a number typed next to someone else's
  // email would take over their conversations). What does not fit goes to `notes`.
  private async customer(
    tx: Prisma.TransactionClient,
    reservation: WebReservation,
    contactAt: Date,
    notes: string[],
  ) {
    const phone = this.contactPart(() => {
      const contact = normalizeContact(
        {
          phone: reservation.phone,
          phoneCountry: reservation.phone?.startsWith('+')
            ? null
            : countryCode(reservation.country),
        },
        { allowMissingContact: true },
      );
      return contact.normalizedPhone
        ? {
            phone: contact.phone,
            phoneCountry: contact.phoneCountry,
            normalizedPhone: contact.normalizedPhone,
          }
        : null;
    }, reservation.phone);
    if (reservation.phone && !phone)
      notes.push(`${CRM_NOTE}WhatsApp sin validar: ${reservation.phone}`);
    const email = this.contactPart(() => {
      const contact = normalizeContact({ email: reservation.email });
      return contact.normalizedEmail
        ? { email: contact.email, normalizedEmail: contact.normalizedEmail }
        : null;
    }, reservation.email);
    if (!phone && !email) return null;
    const select = {
      id: true,
      normalizedPhone: true,
      normalizedEmail: true,
      status: true,
      lastContactAt: true,
    } as const;
    const byEmail = email
      ? await tx.customer.findUnique({
          where: { normalizedEmail: email.normalizedEmail },
          select,
        })
      : null;
    const existing = phone
      ? await tx.customer.findUnique({
          where: { normalizedPhone: phone.normalizedPhone },
          select,
        })
      : byEmail;
    // The email the customer record will have; the form's one is noted if it differs.
    const stored = existing
      ? existing.normalizedEmail
      : byEmail
        ? null
        : (email?.normalizedEmail ?? null);
    if (email && stored !== email.normalizedEmail)
      notes.push(
        `${CRM_NOTE}correo del formulario: ${email.normalizedEmail}` +
          (byEmail && byEmail.id !== existing?.id
            ? ' (registrado en otro cliente)'
            : ''),
      );
    const formPhone = phone?.normalizedPhone ?? null;
    if (!existing) {
      const customer = await tx.customer.create({
        data: {
          firstName: safeName(reservation.name, 6, 60),
          ...phone,
          // An email already on another customer stays there (it is unique).
          ...(byEmail ? {} : email),
          sourceChannel: 'WEBSITE',
          status: 'REQUESTED_RESERVATION',
          firstContactAt: contactAt,
          lastContactAt: contactAt,
        },
        select,
      });
      return { customer, formPhone };
    }
    const data: Prisma.CustomerUpdateInput = {};
    if (!existing.lastContactAt || existing.lastContactAt < contactAt)
      data.lastContactAt = contactAt;
    if (['NEW', 'INTERESTED', 'IN_CONVERSATION'].includes(existing.status))
      data.status = 'REQUESTED_RESERVATION';
    const customer = Object.keys(data).length
      ? await tx.customer.update({ where: { id: existing.id }, data, select })
      : existing;
    return { customer, formPhone };
  }
  private contactPart<T>(read: () => T | null, raw: string | null): T | null {
    if (!raw) return null;
    try {
      return read();
    } catch {
      // An invalid phone or email is ignored; the other one may still identify them.
      return null;
    }
  }

  // Window open (the customer wrote in the last 24 hours): a normal message, free of
  // template charges. Window closed: the approved template. Only to the number the form
  // gave, and the conversation is created only when a message is queued.
  private async contact(
    tx: Prisma.TransactionClient,
    inboundEmailId: string,
    customer: { id: string; normalizedPhone: string | null },
    formPhone: string | null,
    reservation: WebReservation,
    restaurant: Restaurant,
    at: Date | null,
  ): Promise<ContactResult> {
    if (!formPhone || customer.normalizedPhone !== formPhone)
      return { error: 'NO_WHATSAPP_NUMBER' };
    const now = Date.now();
    const existing = await tx.conversation.findUnique({
      where: {
        customerId_channel: { customerId: customer.id, channel: 'WHATSAPP' },
      },
      select: {
        id: true,
        isAssistantPaused: true,
        assistantPauseReason: true,
        assistantPausedAt: true,
      },
    });
    // A person took this conversation (a manual pause, or any pause from the last 24 h):
    // they decide how to answer. An old handoff no longer means someone is on it.
    if (
      existing?.isAssistantPaused &&
      (existing.assistantPauseReason === null ||
        existing.assistantPauseReason === 'MANUAL' ||
        (existing.assistantPausedAt !== null &&
          now - existing.assistantPausedAt.getTime() < DAY_MS))
    )
      return { error: 'CONVERSATION_PAUSED' };
    const language = this.language(reservation.language);
    const english = language.startsWith('en');
    const details: Details = {
      name: safeName(reservation.name) ?? (english ? 'there' : 'cliente'),
      code: reservation.code,
      business: restaurant.businessName,
      date: at
        ? new Intl.DateTimeFormat(english ? 'en-US' : 'es-PE', {
            timeZone: restaurant.timeZone,
            day: english ? 'numeric' : '2-digit',
            month: english ? 'long' : '2-digit',
            year: 'numeric',
          }).format(at)
        : null,
      time: reservation.time
        ? `${String(reservation.time.hour).padStart(2, '0')}:${String(reservation.time.minute).padStart(2, '0')}`
        : null,
      people: reservation.people ? String(reservation.people) : null,
    };
    const content = render[english ? 'en' : 'es'](details);
    const key = `webres-${inboundEmailId}`;
    if (existing) {
      try {
        await this.outbound.assertCanReply(tx, existing.id);
        // Window open. If the customer wrote last, Samanta or a person is about to
        // answer with this request in context: a notice now would cut in.
        const latest = await tx.message.findFirst({
          where: { conversationId: existing.id },
          orderBy: { sequence: 'desc' },
          select: { direction: true },
        });
        if (latest?.direction === 'INBOUND')
          return { error: 'CUSTOMER_WAITING' };
        const message = await this.outbound.queueOutboundMessage(
          existing.id,
          SAMANTA_USER_ID,
          key,
          { type: 'TEXT', content },
          tx,
        );
        return { messageId: message.id };
      } catch (error) {
        // Only reads ran before these checks, so the transaction is still usable.
        if (!(error instanceof HttpException)) throw error;
        if (!(error instanceof ConflictException))
          return { error: this.sendError(error) };
      }
      // A second template within 24 h would be spam: the first one is still unanswered.
      if (
        await tx.message.count({
          where: {
            conversationId: existing.id,
            templateName: { not: null },
            createdAt: { gte: new Date(now - DAY_MS) },
          },
        })
      )
        return { error: 'TEMPLATE_RECENTLY_SENT' };
    }
    if (!details.date || !details.time || !details.people)
      return { error: 'INCOMPLETE_FOR_TEMPLATE' };
    if (!this.outbound.canSendTemplates('WHATSAPP'))
      return { error: 'WHATSAPP_DISABLED' };
    // Each template is billed by Meta: cap them per UTC day.
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    if (
      (await tx.message.count({
        where: { templateName: { not: null }, createdAt: { gte: start } },
      })) >= this.config.dailyTemplateLimit
    )
      return { error: 'DAILY_LIMIT' };
    const conversation =
      existing ??
      (await tx.conversation.upsert({
        where: {
          customerId_channel: { customerId: customer.id, channel: 'WHATSAPP' },
        },
        create: { customerId: customer.id, channel: 'WHATSAPP' },
        update: {},
        select: { id: true },
      }));
    try {
      const message = await this.outbound.queueTemplateMessage(
        conversation.id,
        SAMANTA_USER_ID,
        key,
        {
          name: this.config.template,
          language,
          parameters: [
            details.name,
            details.code,
            details.date,
            details.time,
            details.people,
          ],
          content,
        },
        tx,
      );
      return { messageId: message.id };
    } catch (error) {
      // queueTemplateMessage checks before writing, so the transaction is still usable.
      if (!(error instanceof HttpException)) throw error;
      return { error: this.sendError(error) };
    }
  }
  private sendError(error: HttpException) {
    return error instanceof ServiceUnavailableException
      ? 'WHATSAPP_DISABLED'
      : 'NO_WHATSAPP_RECIPIENT';
  }
  // The configured template language that matches the form's ("ES" → "es" or "es_PE"),
  // or the first configured one.
  private language(requested: string | null) {
    const languages = this.config.templateLanguages;
    const prefix = requested?.toLowerCase().split(/[_-]/)[0];
    return (
      languages.find((language) => language.split('_')[0] === prefix) ??
      languages[0]
    );
  }
}
