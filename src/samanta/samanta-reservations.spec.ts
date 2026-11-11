import type { Prisma } from '../../generated/prisma/client';
import type { ReservationSupportService } from '../reservations/reservation-support.service';
import type { ReservationAction } from './samanta.provider';
import {
  PROPOSAL_TTL_MS,
  replies,
  SamantaReservationService,
  type ReservationProposal,
} from './samanta-reservations';

const NOW = new Date('2026-11-10T17:00:00.000Z'); // 12:00 in Lima
const CONVERSATION = 'c0000000-0000-4000-8000-000000000001';
const CUSTOMER = 'c0000000-0000-4000-8000-000000000002';
const ITEM = 'c0000000-0000-4000-8000-000000000003';
const PROPOSAL_DRAFT = 'c0000000-0000-4000-8000-000000000004';
const SUMMARY_MESSAGE = 'c0000000-0000-4000-8000-000000000005';
// 20/11/2026 19:00 in Lima (UTC-5).
const AT = new Date('2026-11-21T00:00:00.000Z');

const action = (extra: Partial<ReservationAction> = {}): ReservationAction => ({
  action: 'PROPOSE',
  language: 'es',
  date: '2026-11-20',
  time: '19:00',
  people: 4,
  service: null,
  specialRequirements: null,
  ...extra,
});
const proposal = (
  extra: Partial<ReservationProposal> = {},
): ReservationProposal => ({
  date: '2026-11-20',
  time: '19:00',
  people: 4,
  commercialItemId: null,
  service: null,
  specialRequirements: 'Mesa en terraza',
  language: 'es',
  ...extra,
});

function setup() {
  const tx = {
    conversation: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ customerId: CUSTOMER, channel: 'WHATSAPP' }),
    },
    commercialItem: { findFirst: jest.fn().mockResolvedValue(null) },
    reservationRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      create: jest
        .fn()
        .mockResolvedValue({ id: 'request-1', code: 'RES-2026-000010' }),
    },
    message: { findFirst: jest.fn().mockResolvedValue(null) },
    samantaDraft: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    customer: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const support = {
    configuration: jest
      .fn()
      .mockResolvedValue({ currency: 'PEN', timeZone: 'America/Lima' }),
    code: jest.fn().mockResolvedValue('RES-2026-000010'),
  };
  const service = new SamantaReservationService(
    support as unknown as ReservationSupportService,
  );
  const client = tx as unknown as Prisma.TransactionClient;
  // The newest outbound message before the customer's reply is a delivered summary.
  const summarySent = (
    stored: ReservationProposal = proposal(),
    extra: { status?: string; createdAt?: Date; requestId?: string } = {},
  ) => {
    tx.message.findFirst.mockResolvedValueOnce({
      id: SUMMARY_MESSAGE,
      status: extra.status ?? 'DELIVERED',
    });
    tx.samantaDraft.findFirst.mockResolvedValueOnce({
      id: PROPOSAL_DRAFT,
      createdAt: extra.createdAt ?? new Date(NOW.getTime() - 60000),
      reservationProposal: stored,
      reservationRequestId: extra.requestId ?? null,
    });
  };
  return { tx, client, support, service, summarySent };
}

describe('SamantaReservationService.propose (validación con reglas del backend)', () => {
  it('datos completos: resumen fijo que pide confirmación, sin crear nada', async () => {
    const { tx, client, service } = setup();
    const outcome = await service.propose(
      client,
      CONVERSATION,
      action({ specialRequirements: '  Mesa  en terraza ' }),
      NOW,
    );
    expect(outcome).toMatchObject({
      code: 'PROPOSED',
      handOff: false,
      proposal: {
        date: '2026-11-20',
        time: '19:00',
        people: 4,
        commercialItemId: null,
        service: null,
        specialRequirements: 'Mesa en terraza',
        language: 'es',
      },
    });
    expect(outcome.content).toContain('• Fecha: viernes 20/11/2026');
    expect(outcome.content).toContain('• Hora: 19:00');
    expect(outcome.content).toContain('¿Registro la solicitud');
    expect(outcome.content).not.toMatch(/confirmada/i);
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
    // 19:00 in Lima is midnight UTC: the duplicate check looks for that instant.
    expect(tx.reservationRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: CUSTOMER,
          reservationAt: AT,
        }) as unknown,
      }),
    );
  });
  it.each([
    [{ date: null }, 'MISSING_DATA', 'necesito la fecha'],
    [
      { time: null, people: null },
      'MISSING_DATA',
      'la hora y el número de personas',
    ],
    [{ date: '2026-11-31' }, 'INVALID_DATE', 'No pude entender'],
    [{ time: '7pm' }, 'INVALID_DATE', 'No pude entender'],
    [{ date: '2026-11-10', time: '11:00' }, 'PAST_DATE', 'ya pasaron'],
    [{ people: 0 }, 'INVALID_PEOPLE', 'cuántas personas'],
  ] as const)(
    'datos incompletos o inválidos %j → %s, sin propuesta ni solicitud',
    async (extra, code, text) => {
      const { tx, client, service } = setup();
      const outcome = await service.propose(
        client,
        CONVERSATION,
        action(extra),
        NOW,
      );
      expect(outcome).toMatchObject({ code, handOff: false });
      expect(outcome.proposal).toBeUndefined();
      expect(outcome.content).toContain(text);
      expect(tx.reservationRequest.create).not.toHaveBeenCalled();
    },
  );
  it('servicio inexistente: no propone y pregunta', async () => {
    const { tx, client, service } = setup();
    const outcome = await service.propose(
      client,
      CONVERSATION,
      action({ service: 'Menú «secreto»' }),
      NOW,
    );
    expect(outcome).toMatchObject({ code: 'UNKNOWN_SERVICE', handOff: false });
    expect(outcome.content).toContain('No encontré «Menú secreto»');
    expect(tx.commercialItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          approvalStatus: 'APPROVED',
          category: { isActive: true },
        }) as unknown,
      }),
    );
  });
  it('servicio del catálogo: guarda su id y su nombre en el idioma del cliente', async () => {
    const { tx, client, service } = setup();
    tx.commercialItem.findFirst.mockResolvedValue({
      id: ITEM,
      nameEs: 'Menú degustación',
      nameEn: 'Tasting menu',
    });
    const outcome = await service.propose(
      client,
      CONVERSATION,
      action({ service: 'tasting MENU', language: 'en' }),
      NOW,
    );
    expect(outcome.proposal).toMatchObject({
      commercialItemId: ITEM,
      service: 'Tasting menu',
      language: 'en',
    });
    expect(outcome.content).toContain('• Date: Friday 11/20/2026');
    expect(outcome.content).toContain('• Service: Tasting menu');
  });
  it('cliente con una solicitud abierta para el mismo momento: no duplica', async () => {
    const { tx, client, service } = setup();
    tx.reservationRequest.findFirst.mockResolvedValue({ id: 'request-9' });
    tx.reservationRequest.findUniqueOrThrow.mockResolvedValue({
      code: 'SM-20261110-9E49B1',
      status: 'WAITING_RESPONSE',
      reservation: null,
    });
    const outcome = await service.propose(client, CONVERSATION, action(), NOW);
    expect(outcome).toMatchObject({ code: 'ALREADY_REGISTERED' });
    expect(outcome.content).toContain('SM-20261110-9E49B1');
    expect(outcome.proposal).toBeUndefined();
  });
});

describe('SamantaReservationService.confirm (creación de la solicitud)', () => {
  it('confirmación explícita de un resumen entregado: crea la solicitud vinculada', async () => {
    const { tx, client, service, summarySent } = setup();
    summarySent();
    const outcome = await service.confirm(client, CONVERSATION, 42, 'es', NOW);
    expect(outcome).toMatchObject({
      code: 'CREATED',
      handOff: false,
      requestId: 'request-1',
    });
    // Only the summary before the customer's reply counts.
    expect(tx.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId: CONVERSATION,
          direction: 'OUTBOUND',
          sequence: { lt: 42 },
        },
      }),
    );
    expect(tx.reservationRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        code: 'RES-2026-000010',
        customerId: CUSTOMER,
        conversationId: CONVERSATION,
        sourceChannel: 'WHATSAPP',
        reservationAt: AT,
        numberOfPeople: 4,
        commercialItemId: null,
        specialRequirements: 'Mesa en terraza',
        status: 'READY_TO_SEND',
      }) as unknown,
      select: { id: true, code: true },
    });
    expect(tx.samantaDraft.updateMany).toHaveBeenCalledWith({
      where: { id: PROPOSAL_DRAFT, reservationRequestId: null },
      data: { reservationRequestId: 'request-1' },
    });
    expect(tx.customer.updateMany).toHaveBeenCalledWith({
      where: {
        id: CUSTOMER,
        status: { in: ['NEW', 'INTERESTED', 'IN_CONVERSATION'] },
      },
      data: { status: 'REQUESTED_RESERVATION' },
    });
    expect(outcome.content).toContain('RES-2026-000010');
    expect(outcome.content).toContain('pendiente de aprobación');
    expect(outcome.content).not.toMatch(/confirmada|confirmed/i);
  });
  it('sin un resumen previo, un «sí» no crea nada y pasa a una persona', async () => {
    const { tx, client, service } = setup();
    const outcome = await service.confirm(client, CONVERSATION, 42, 'es', NOW);
    expect(outcome).toMatchObject({ code: 'NO_PROPOSAL', handOff: true });
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
  });
  it('un resumen que el canal no entregó no se puede confirmar', async () => {
    const { tx, client, service } = setup();
    tx.message.findFirst.mockResolvedValueOnce({
      id: SUMMARY_MESSAGE,
      status: 'FAILED',
    });
    const outcome = await service.confirm(client, CONVERSATION, 42, 'es', NOW);
    expect(outcome.code).toBe('NO_PROPOSAL');
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
  });
  it('un segundo «sí» (mensaje repetido) no duplica: responde con la solicitud registrada', async () => {
    const { tx, client, service, summarySent } = setup();
    summarySent(proposal(), { requestId: 'request-1' });
    tx.reservationRequest.findUniqueOrThrow.mockResolvedValue({
      code: 'RES-2026-000010',
      status: 'READY_TO_SEND',
      reservation: null,
    });
    const outcome = await service.confirm(client, CONVERSATION, 43, 'es', NOW);
    expect(outcome).toMatchObject({
      code: 'ALREADY_REGISTERED',
      handOff: false,
    });
    expect(outcome.content).toContain('RES-2026-000010');
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
  });
  it('un «sí» tras el mensaje de registro tampoco duplica', async () => {
    const { tx, client, service } = setup();
    tx.samantaDraft.findFirst.mockResolvedValueOnce({
      reservationRequestId: 'request-1',
    });
    tx.reservationRequest.findUniqueOrThrow.mockResolvedValue({
      code: 'RES-2026-000010',
      status: 'SENT_TO_OWNER',
      reservation: null,
    });
    const outcome = await service.confirm(client, CONVERSATION, 44, 'es', NOW);
    expect(outcome.code).toBe('ALREADY_REGISTERED');
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
  });
  // M9.3: once the owner decided, a late "yes" never says "pending approval" again.
  it.each([
    [
      'ACCEPTED',
      { code: 'RES-2026-000020' },
      false,
      /ya fue aprobada.*RES-2026-000020/,
    ],
    ['REJECTED', null, false, /no fue aprobada/],
    ['MODIFICATION_REQUESTED', null, true, /propuso un cambio/],
  ])(
    'un «sí» tardío tras la decisión %s responde con la decisión, sin «pendiente»',
    async (status, reservation, handOff, text) => {
      const { tx, client, service } = setup();
      tx.samantaDraft.findFirst.mockResolvedValueOnce({
        reservationRequestId: 'request-1',
      });
      tx.reservationRequest.findUniqueOrThrow.mockResolvedValue({
        code: 'RES-2026-000010',
        status,
        reservation,
      });
      const outcome = await service.confirm(
        client,
        CONVERSATION,
        45,
        'es',
        NOW,
      );
      expect(outcome).toMatchObject({ code: 'ALREADY_DECIDED', handOff });
      expect(outcome.content).toMatch(text);
      expect(outcome.content).not.toContain('pendiente de aprobación');
      expect(tx.reservationRequest.create).not.toHaveBeenCalled();
    },
  );
  it('confirmación concurrente: si el resumen ya se usó, la transacción se revierte', async () => {
    const { tx, client, service, summarySent } = setup();
    summarySent();
    tx.samantaDraft.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.confirm(client, CONVERSATION, 42, 'es', NOW),
    ).rejects.toThrow('SAMANTA_PROPOSAL_ALREADY_USED');
  });
  it('si la fecha del resumen ya pasó, no crea la solicitud', async () => {
    const { tx, client, service, summarySent } = setup();
    summarySent(proposal({ date: '2026-11-10', time: '11:00' }));
    const outcome = await service.confirm(client, CONVERSATION, 42, 'es', NOW);
    expect(outcome.code).toBe('PAST_DATE');
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
  });
  it('si el servicio del resumen se retiró del catálogo, no crea la solicitud', async () => {
    const { tx, client, service, summarySent } = setup();
    summarySent(
      proposal({ commercialItemId: ITEM, service: 'Menú degustación' }),
    );
    const outcome = await service.confirm(client, CONVERSATION, 42, 'es', NOW);
    expect(outcome.code).toBe('UNKNOWN_SERVICE');
    expect(tx.commercialItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ITEM }) as unknown,
      }),
    );
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
  });
  it('un resumen de hace más de 24 h se vuelve a enviar en vez de darse por confirmado', async () => {
    const { tx, client, service, summarySent } = setup();
    summarySent(proposal(), {
      createdAt: new Date(NOW.getTime() - PROPOSAL_TTL_MS - 1000),
    });
    const outcome = await service.confirm(client, CONVERSATION, 42, 'es', NOW);
    expect(outcome).toMatchObject({ code: 'PROPOSED', handOff: false });
    expect(outcome.proposal).toBeDefined();
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
  });
});

describe('Textos fijos de Samanta para reservas', () => {
  const summary = {
    date: 'viernes 20/11/2026',
    time: '19:00',
    people: 1,
    service: null,
    specialRequirements: null,
  };
  it.each(['es', 'en'] as const)(
    'en %s nunca dicen que la reserva está confirmada',
    (language) => {
      const text = replies[language];
      for (const message of [
        text.created('RES-2026-000001', summary),
        text.already('RES-2026-000001'),
        text.noProposal,
        text.pastDate,
      ])
        expect(message).not.toMatch(/confirmada|confirmed/i);
      expect(text.created('RES-2026-000001', summary)).toMatch(
        language === 'es' ? /1 persona\)/ : /1 person\)/,
      );
    },
  );
});
