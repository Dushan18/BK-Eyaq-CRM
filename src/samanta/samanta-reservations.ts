import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { CRM_NOTE } from '../common/crm-note';
import { zonedTimeToUtc } from '../common/zoned-time';
import { requestCompleteness } from '../reservations/reservation-rules';
import { ReservationSupportService } from '../reservations/reservation-support.service';
import type { ReservationAction } from './samanta.provider';

// How long a summary sent to the customer can still be confirmed with a plain "yes".
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const OPEN_REQUEST = [
  'INCOMPLETE_DATA',
  'READY_TO_SEND',
  'SENT_TO_OWNER',
  'WAITING_RESPONSE',
  'MODIFICATION_REQUESTED',
  'RENEGOTIATING',
] as const;
// Only a summary the channel accepted can have been read and confirmed.
const SENT = ['SENT', 'DELIVERED', 'READ'] as const;
const MAX_PEOPLE = 2147483647;
type Language = ReservationAction['language'];

// What a summary sent to the customer said, validated by the backend. A request is
// created from this, never from what the model writes when the customer confirms.
export interface ReservationProposal {
  date: string;
  time: string;
  people: number;
  commercialItemId: string | null;
  service: string | null;
  specialRequirements: string | null;
  language: Language;
}
export type ReservationOutcomeCode =
  | 'PROPOSED'
  | 'CREATED'
  | 'ALREADY_REGISTERED'
  | 'ALREADY_DECIDED'
  | 'MISSING_DATA'
  | 'INVALID_DATE'
  | 'PAST_DATE'
  | 'INVALID_PEOPLE'
  | 'UNKNOWN_SERVICE'
  | 'NO_PROPOSAL';
// The reply the customer gets instead of the model's text, and what else happened.
export interface ReservationOutcome {
  code: ReservationOutcomeCode;
  content: string;
  handOff: boolean;
  proposal?: ReservationProposal;
  requestId?: string;
}

const clip = (text: string, max: number) =>
  text.replace(/\s+/g, ' ').trim().slice(0, max);
export function readProposal(value: unknown): ReservationProposal | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const p = value as Record<string, unknown>;
  const text = (v: unknown) => v === null || typeof v === 'string';
  return typeof p.date === 'string' &&
    typeof p.time === 'string' &&
    typeof p.people === 'number' &&
    text(p.commercialItemId) &&
    text(p.service) &&
    text(p.specialRequirements) &&
    (p.language === 'es' || p.language === 'en')
    ? (p as unknown as ReservationProposal)
    : null;
}

// The summary this conversation is waiting on: the newest message sent to the customer
// (before `beforeSequence`, when given) must be a summary that the channel delivered.
export async function awaitingProposal(
  tx: Prisma.TransactionClient,
  conversationId: string,
  now: Date,
  beforeSequence?: number,
) {
  const last = await tx.message.findFirst({
    where: {
      conversationId,
      direction: 'OUTBOUND',
      ...(beforeSequence === undefined
        ? {}
        : { sequence: { lt: beforeSequence } }),
    },
    orderBy: { sequence: 'desc' },
    select: { id: true, status: true },
  });
  if (!last || !(SENT as readonly string[]).includes(last.status)) return null;
  const draft = await tx.samantaDraft.findFirst({
    where: { conversationId, outboundMessageId: last.id },
    select: {
      id: true,
      createdAt: true,
      reservationProposal: true,
      reservationRequestId: true,
    },
  });
  const proposal = readProposal(draft?.reservationProposal);
  if (!draft || !proposal) return null;
  return {
    draftId: draft.id,
    proposal,
    requestId: draft.reservationRequestId,
    expired: draft.createdAt.getTime() < now.getTime() - PROPOSAL_TTL_MS,
  };
}

function localDate(at: Date, timeZone: string, language: Language) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat(language === 'es' ? 'es-PE' : 'en-US', {
      timeZone,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return language === 'es'
    ? `${parts.weekday} ${parts.day}/${parts.month}/${parts.year}`
    : `${parts.weekday} ${parts.month}/${parts.day}/${parts.year}`;
}
interface Summary {
  date: string;
  time: string;
  people: number;
  service: string | null;
  specialRequirements: string | null;
}
const listEs = (items: string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`
    : items[0];
const listEn = (items: string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
    : items[0];
// Fixed texts: what the customer reads never depends on the model, and none of them
// says the reservation is confirmed.
export const replies = {
  es: {
    proposal: (s: Summary) =>
      [
        'Estos son los datos de tu solicitud de reserva:',
        `• Fecha: ${s.date}`,
        `• Hora: ${s.time}`,
        `• Personas: ${s.people}`,
        ...(s.service ? [`• Servicio: ${s.service}`] : []),
        ...(s.specialRequirements
          ? [`• Requerimientos: ${s.specialRequirements}`]
          : []),
        '¿Registro la solicitud con estos datos? Responde «sí» para confirmarlos o dime qué quieres cambiar. Después el restaurante revisará la solicitud.',
      ].join('\n'),
    created: (code: string, s: Summary) =>
      `Listo, registré tu solicitud de reserva ${code} para el ${s.date} a las ${s.time} (${s.people} ${s.people === 1 ? 'persona' : 'personas'}). Está pendiente de aprobación del restaurante: te avisaremos por aquí cuando la revisen.`,
    already: (code: string) =>
      `Tu solicitud ${code} ya está registrada y pendiente de aprobación del restaurante. Te avisaremos por aquí cuando la revisen.`,
    // M9.3: the restaurant already decided; never "pending" again after that.
    approved: (code: string, reservation: string) =>
      `Tu solicitud ${code} ya fue aprobada por el restaurante: tu reserva ${reservation} está confirmada. No necesitas confirmarla otra vez.`,
    notApproved: (code: string) =>
      `Tu solicitud ${code} no fue aprobada por el restaurante, así que no hay una reserva registrada con ella. Si quieres otra fecha u hora, dímela.`,
    changeProposed: (code: string) =>
      `El restaurante propuso un cambio para tu solicitud ${code}. Una persona del equipo te escribirá para coordinarlo; por ahora la reserva no está confirmada.`,
    missing: (fields: ('date' | 'time' | 'people')[]) =>
      `Para registrar tu solicitud necesito ${listEs(
        fields.map(
          (field) =>
            ({
              date: 'la fecha',
              time: 'la hora',
              people: 'el número de personas',
            })[field],
        ),
      )}.`,
    invalidDate:
      'No pude entender la fecha o la hora. ¿Para qué día y a qué hora deseas reservar?',
    pastDate:
      'Esa fecha y hora ya pasaron. ¿Para qué otro día y a qué hora deseas reservar?',
    invalidPeople: '¿Para cuántas personas sería la reserva?',
    unknownService: (service: string) =>
      `No encontré «${service}» en nuestra carta. ¿Quieres reservar sin ese servicio o prefieres elegir otro?`,
    noProposal:
      'Una persona del equipo revisará tu solicitud y continuará la atención en breve.',
    // Used only when the model left content empty (draftFields).
    emptyHandOff:
      'Gracias por escribirnos. Una persona del equipo continuará la atención en breve.',
    emptyReply:
      'Gracias. Estoy revisando los datos de tu solicitud de reserva y te escribo en breve.',
  },
  en: {
    proposal: (s: Summary) =>
      [
        'Here are the details of your reservation request:',
        `• Date: ${s.date}`,
        `• Time: ${s.time}`,
        `• People: ${s.people}`,
        ...(s.service ? [`• Service: ${s.service}`] : []),
        ...(s.specialRequirements
          ? [`• Requests: ${s.specialRequirements}`]
          : []),
        'Shall I register the request with these details? Reply "yes" to confirm them or tell me what to change. The restaurant will then review the request.',
      ].join('\n'),
    created: (code: string, s: Summary) =>
      `Done, I registered your reservation request ${code} for ${s.date} at ${s.time} (${s.people} ${s.people === 1 ? 'person' : 'people'}). It is pending the restaurant's approval: we will let you know here once it is reviewed.`,
    already: (code: string) =>
      `Your request ${code} is already registered and pending the restaurant's approval. We will let you know here once it is reviewed.`,
    approved: (code: string, reservation: string) =>
      `Your request ${code} was already approved by the restaurant: your reservation ${reservation} is confirmed. There is no need to confirm it again.`,
    notApproved: (code: string) =>
      `Your request ${code} was not approved by the restaurant, so there is no reservation under it. If you would like another date or time, let me know.`,
    changeProposed: (code: string) =>
      `The restaurant proposed a change to your request ${code}. A member of our team will write to you to arrange it; the reservation is not confirmed yet.`,
    missing: (fields: ('date' | 'time' | 'people')[]) =>
      `To register your request I need ${listEn(
        fields.map(
          (field) =>
            ({
              date: 'the date',
              time: 'the time',
              people: 'the number of people',
            })[field],
        ),
      )}.`,
    invalidDate:
      'I could not understand the date or the time. For which day and time would you like to book?',
    pastDate:
      'That date and time have already passed. For which other day and time would you like to book?',
    invalidPeople: 'For how many people would the reservation be?',
    unknownService: (service: string) =>
      `I could not find "${service}" on our menu. Would you like to book without it or choose another option?`,
    noProposal:
      'A member of our team will review your request and continue shortly.',
    emptyHandOff:
      'Thank you for writing to us. A member of our team will continue shortly.',
    emptyReply:
      'Thank you. I am reviewing the details of your reservation request and will write to you shortly.',
  },
} as const;

interface Candidate {
  date: string | null;
  time: string | null;
  people: number | null;
  service: string | null;
  specialRequirements: string | null;
}
type Checked =
  | {
      proposal: ReservationProposal;
      at: Date;
      summary: Summary;
    }
  | { outcome: ReservationOutcome };

// Samanta's side of M8.2. Runs inside the transaction that answers the customer, with
// the conversation row locked: the request, the reply and the draft commit together.
@Injectable()
export class SamantaReservationService {
  constructor(private readonly support: ReservationSupportService) {}

  // The customer gave all the data: validate it and answer with a fixed summary that
  // asks for an explicit confirmation. Nothing is created yet.
  async propose(
    tx: Prisma.TransactionClient,
    conversationId: string,
    action: ReservationAction,
    now: Date,
  ): Promise<ReservationOutcome> {
    const { customerId, timeZone } = await this.scope(tx, conversationId);
    const checked = await this.check(
      tx,
      customerId,
      action,
      action.language,
      timeZone,
      now,
    );
    if ('outcome' in checked) return checked.outcome;
    return {
      code: 'PROPOSED',
      content: replies[action.language].proposal(checked.summary),
      handOff: false,
      proposal: checked.proposal,
    };
  }

  // The customer accepted a summary: create the request from the stored summary (never
  // from the model's text), once, and tell the customer it awaits approval.
  async confirm(
    tx: Prisma.TransactionClient,
    conversationId: string,
    sourceSequence: number,
    language: Language,
    now: Date,
  ): Promise<ReservationOutcome> {
    const { customerId, channel, timeZone } = await this.scope(
      tx,
      conversationId,
    );
    const awaiting = await awaitingProposal(
      tx,
      conversationId,
      now,
      sourceSequence,
    );
    if (!awaiting) {
      // A second "yes" after the request was registered.
      const done = await tx.samantaDraft.findFirst({
        where: {
          conversationId,
          reservationRequestId: { not: null },
          createdAt: { gte: new Date(now.getTime() - PROPOSAL_TTL_MS) },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { reservationRequestId: true },
      });
      if (done?.reservationRequestId)
        return this.registered(tx, done.reservationRequestId, language);
      // Nothing was summarised and confirmed: a person takes over.
      return {
        code: 'NO_PROPOSAL',
        content: replies[language].noProposal,
        handOff: true,
      };
    }
    const reply = awaiting.proposal.language;
    if (awaiting.requestId)
      return this.registered(tx, awaiting.requestId, reply);
    // The data is checked again: the date may have passed or the item been withdrawn.
    const checked = await this.check(
      tx,
      customerId,
      {
        ...awaiting.proposal,
        service: awaiting.proposal.commercialItemId
          ? awaiting.proposal.service
          : null,
      },
      reply,
      timeZone,
      now,
      awaiting.proposal.commercialItemId,
    );
    if ('outcome' in checked) return checked.outcome;
    // An old summary is sent again instead of being taken as confirmed.
    if (awaiting.expired)
      return {
        code: 'PROPOSED',
        content: replies[reply].proposal(checked.summary),
        handOff: false,
        proposal: checked.proposal,
      };
    const { proposal, at } = checked;
    const code = await this.support.code(tx, 'request', timeZone, now);
    const request = await tx.reservationRequest.create({
      data: {
        code,
        customerId,
        conversationId,
        commercialItemId: proposal.commercialItemId,
        sourceChannel: channel,
        reservationAt: at,
        numberOfPeople: proposal.people,
        specialRequirements: proposal.specialRequirements,
        comments: `${CRM_NOTE}registrada por Samanta con la confirmación del cliente en la conversación.`,
        status: requestCompleteness(at, proposal.people),
        createdAt: now,
      },
      select: { id: true, code: true },
    });
    // One request per summary, also against a concurrent confirmation.
    const linked = await tx.samantaDraft.updateMany({
      where: { id: awaiting.draftId, reservationRequestId: null },
      data: { reservationRequestId: request.id },
    });
    if (linked.count !== 1) throw new Error('SAMANTA_PROPOSAL_ALREADY_USED');
    // Same rule as the website's requests.
    await tx.customer.updateMany({
      where: {
        id: customerId,
        status: { in: ['NEW', 'INTERESTED', 'IN_CONVERSATION'] },
      },
      data: { status: 'REQUESTED_RESERVATION' },
    });
    return {
      code: 'CREATED',
      content: replies[reply].created(request.code, checked.summary),
      handOff: false,
      requestId: request.id,
    };
  }

  // A request this conversation already registered, as it stands now (M9.3): once the
  // restaurant decided, Samanta repeats the decision instead of "pending approval".
  private async registered(
    tx: Prisma.TransactionClient,
    requestId: string,
    language: Language,
  ): Promise<ReservationOutcome> {
    const request = await tx.reservationRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: {
        code: true,
        status: true,
        reservation: { select: { code: true } },
      },
    });
    const text = replies[language];
    const decided = (content: string, handOff = false): ReservationOutcome => ({
      code: 'ALREADY_DECIDED',
      content,
      handOff,
    });
    if (request.reservation)
      return decided(text.approved(request.code, request.reservation.code));
    if (request.status === 'REJECTED' || request.status === 'CANCELLED')
      return decided(text.notApproved(request.code));
    // A person coordinates the change: Samanta steps aside.
    if (request.status === 'MODIFICATION_REQUESTED')
      return decided(text.changeProposed(request.code), true);
    return this.already(request.code, language);
  }
  private already(code: string, language: Language): ReservationOutcome {
    return {
      code: 'ALREADY_REGISTERED',
      content: replies[language].already(code),
      handOff: false,
    };
  }
  private async scope(tx: Prisma.TransactionClient, conversationId: string) {
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { customerId: true, channel: true },
    });
    const { timeZone } = await this.support.configuration(tx);
    return { ...conversation, timeZone };
  }

  // The backend's own rules on what the model extracted: complete data, a real and
  // future local date and time, a party size, an item of the current catalogue, and no
  // open request of the customer for the same moment.
  private async check(
    tx: Prisma.TransactionClient,
    customerId: string,
    input: Candidate,
    language: Language,
    timeZone: string,
    now: Date,
    commercialItemId?: string | null,
  ): Promise<Checked> {
    const text = replies[language];
    const fail = (
      code: ReservationOutcomeCode,
      content: string,
    ): { outcome: ReservationOutcome } => ({
      outcome: { code, content, handOff: false },
    });
    const missing = (
      [
        ['date', input.date],
        ['time', input.time],
        ['people', input.people],
      ] as const
    )
      .filter(([, value]) => value === null || value === '')
      .map(([field]) => field);
    if (missing.length) return fail('MISSING_DATA', text.missing(missing));
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date!);
    const time = /^(\d{2}):(\d{2})$/.exec(input.time!);
    const at =
      date && time
        ? zonedTimeToUtc(
            {
              year: +date[1],
              month: +date[2],
              day: +date[3],
              hour: +time[1],
              minute: +time[2],
            },
            timeZone,
          )
        : null;
    if (!at) return fail('INVALID_DATE', text.invalidDate);
    if (at <= now) return fail('PAST_DATE', text.pastDate);
    const people = input.people!;
    if (!Number.isSafeInteger(people) || people < 1 || people > MAX_PEOPLE)
      return fail('INVALID_PEOPLE', text.invalidPeople);
    let item: {
      id: string;
      nameEs: string | null;
      nameEn: string | null;
    } | null = null;
    if (commercialItemId || input.service?.trim()) {
      const name = input.service?.trim() ?? '';
      // Same catalogue Samanta sees: active, approved, in an active category.
      item = await tx.commercialItem.findFirst({
        where: {
          isActive: true,
          approvalStatus: 'APPROVED',
          category: { isActive: true },
          ...(commercialItemId
            ? { id: commercialItemId }
            : {
                OR: [
                  { nameEs: { equals: name, mode: 'insensitive' } },
                  { nameEn: { equals: name, mode: 'insensitive' } },
                ],
              }),
        },
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        select: { id: true, nameEs: true, nameEn: true },
      });
      if (!item)
        return fail(
          'UNKNOWN_SERVICE',
          text.unknownService(
            clip(
              name || (language === 'es' ? 'ese servicio' : 'that service'),
              80,
            ).replace(/[«»"]/g, ''),
          ),
        );
    }
    const open = await tx.reservationRequest.findFirst({
      where: {
        customerId,
        reservationAt: at,
        status: { in: [...OPEN_REQUEST] },
        reservation: { is: null },
      },
      select: { id: true },
    });
    if (open) return { outcome: await this.registered(tx, open.id, language) };
    const service = item
      ? ((language === 'en' ? item.nameEn : item.nameEs) ??
        item.nameEs ??
        item.nameEn)
      : null;
    const specialRequirements = input.specialRequirements?.trim()
      ? clip(input.specialRequirements, 1000)
      : null;
    return {
      at,
      proposal: {
        date: input.date!,
        time: input.time!,
        people,
        commercialItemId: item?.id ?? null,
        service,
        specialRequirements,
        language,
      },
      summary: {
        date: localDate(at, timeZone, language),
        time: input.time!,
        people,
        service,
        specialRequirements,
      },
    };
  }
}
