import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../database/prisma.service';
import type { ReservationSupportService } from '../reservations/reservation-support.service';
import { recordRequestStatusChange } from '../reservations/reservation-request-history';
import { reservationRequestDetailSelect } from '../reservations/reservation.select';
import { ReservationRequestsService } from './reservation-requests.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

const REQUEST_ID = '6f1c3b7e-2d4a-4f5b-9c8d-1e2f3a4b5c6d';
const CUSTOMER_ID = '052cfe2a-ff46-47c1-aa84-283113d92e68';
const OTHER_CUSTOMER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CONVERSATION_ID = '48c02bdd-66c1-4147-882d-c6cd54f035ec';
const USER = { id: 'b7e3c1d2-9a8f-4e6d-8c5b-4a3f2e1d0c9b' };
const future = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

function setup() {
  const tx = {
    reservationRequest: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    reservationRequestStatusHistory: {
      create: jest.fn().mockResolvedValue({ id: 'h1' }),
    },
    conversation: { findUnique: jest.fn() },
    reservation: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'reservation-1',
          assignedUserId: null,
          assignedUser: null,
          ...data,
        }),
      ),
    },
  };
  // Every write in the test must go through this one transaction client.
  const transaction = jest.fn(
    (fn: (client: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(tx as unknown as Prisma.TransactionClient),
  );
  const support = {
    transaction,
    configuration: jest
      .fn()
      .mockResolvedValue({ currency: 'PEN', timeZone: 'America/Lima' }),
    customer: jest.fn().mockResolvedValue(undefined),
    commercialItem: jest.fn().mockResolvedValue(undefined),
    code: jest.fn().mockResolvedValue('RES-2026-000010'),
  };
  const prisma = { reservationRequest: { findUnique: jest.fn() } };
  const service = new ReservationRequestsService(
    prisma as unknown as PrismaService,
    support as unknown as ReservationSupportService,
  );
  // update() echoes what was written, like Prisma's update with a select.
  tx.reservationRequest.update.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: REQUEST_ID,
        customerId: CUSTOMER_ID,
        conversationId: null,
        quotedPrice: null,
        ...data,
      }),
  );
  tx.reservationRequest.create.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: REQUEST_ID, quotedPrice: null, ...data }),
  );
  return { tx, transaction, support, prisma, service };
}

const stored = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  customerId: CUSTOMER_ID,
  commercialItemId: null,
  conversationId: null,
  reservationAt: null,
  numberOfPeople: null,
  quotedPrice: null,
  currency: null,
  status: 'INCOMPLETE_DATA',
  ...overrides,
});

describe('recordRequestStatusChange', () => {
  const create = jest.fn();
  const tx = {
    reservationRequestStatusHistory: { create },
  } as unknown as Prisma.TransactionClient;
  beforeEach(() => create.mockReset());

  it('no escribe nada si el estado no cambia', async () => {
    expect(
      await recordRequestStatusChange(tx, {
        requestId: REQUEST_ID,
        previousStatus: 'READY_TO_SEND',
        newStatus: 'READY_TO_SEND',
        actor: { type: 'USER', id: USER.id },
      }),
    ).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('registra estado anterior, nuevo, actor y motivo', async () => {
    expect(
      await recordRequestStatusChange(tx, {
        requestId: REQUEST_ID,
        previousStatus: 'READY_TO_SEND',
        newStatus: 'CANCELLED',
        actor: { type: 'USER', id: USER.id },
        reason: 'El cliente desistió',
      }),
    ).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: {
        reservationRequestId: REQUEST_ID,
        previousStatus: 'READY_TO_SEND',
        newStatus: 'CANCELLED',
        actorType: 'USER',
        actorId: USER.id,
        reason: 'El cliente desistió',
      },
      select: { id: true },
    });
  });

  it('SYSTEM puede no tener actor; sin motivo guarda null', async () => {
    await recordRequestStatusChange(tx, {
      requestId: REQUEST_ID,
      previousStatus: 'WAITING_RESPONSE',
      newStatus: 'CANCELLED',
      actor: { type: 'SYSTEM' },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'SYSTEM',
          actorId: null,
          reason: null,
        }) as unknown,
      }),
    );
  });

  it.each(['USER', 'SAMANTA', 'OWNER'] as const)(
    '%s sin actorId es un error de programación',
    async (type) => {
      await expect(
        recordRequestStatusChange(tx, {
          requestId: REQUEST_ID,
          previousStatus: 'READY_TO_SEND',
          newStatus: 'SENT_TO_OWNER',
          actor: { type },
        }),
      ).rejects.toThrow('Falta el actor');
      expect(create).not.toHaveBeenCalled();
    },
  );
});

describe('ReservationRequestsService: historial de estados', () => {
  it('cancelar registra el cambio en la misma transacción, con usuario y motivo', async () => {
    const { tx, transaction, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({ status: 'READY_TO_SEND' }),
    );
    const result = await service.updateStatus(
      REQUEST_ID,
      { status: 'CANCELLED', reason: 'Llamó para anular' },
      USER,
    );
    expect(result.status).toBe('CANCELLED');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.reservationRequestStatusHistory.create).toHaveBeenCalledWith({
      data: {
        reservationRequestId: REQUEST_ID,
        previousStatus: 'READY_TO_SEND',
        newStatus: 'CANCELLED',
        actorType: 'USER',
        actorId: USER.id,
        reason: 'Llamó para anular',
      },
      select: { id: true },
    });
    // The history row is written after the status, inside the same transaction.
    expect(
      tx.reservationRequest.update.mock.invocationCallOrder[0],
    ).toBeLessThan(
      tx.reservationRequestStatusHistory.create.mock.invocationCallOrder[0],
    );
  });

  it('cancelar una solicitud ya cancelada (reintento) no duplica el historial', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({ status: 'CANCELLED' }),
    );
    const result = await service.updateStatus(
      REQUEST_ID,
      { status: 'CANCELLED' },
      USER,
    );
    expect(result.status).toBe('CANCELLED');
    expect(tx.reservationRequest.update).not.toHaveBeenCalled();
    expect(tx.reservationRequestStatusHistory.create).not.toHaveBeenCalled();
  });

  it('un estado no editable no cambia ni deja historial', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({ status: 'WAITING_RESPONSE' }),
    );
    await expect(
      service.updateStatus(REQUEST_ID, { status: 'CANCELLED' }, USER),
    ).rejects.toThrow(ConflictException);
    expect(tx.reservationRequestStatusHistory.create).not.toHaveBeenCalled();
  });

  it('si falla el historial, falla la transacción completa', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({ status: 'READY_TO_SEND' }),
    );
    const failure = new Error('history down');
    tx.reservationRequestStatusHistory.create.mockRejectedValue(failure);
    await expect(
      service.updateStatus(REQUEST_ID, { status: 'CANCELLED' }, USER),
    ).rejects.toBe(failure);
  });

  it('completar fecha y personas registra INCOMPLETE_DATA → READY_TO_SEND', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(stored());
    const result = await service.update(
      REQUEST_ID,
      { reservationAt: future(), numberOfPeople: 4 },
      USER,
    );
    expect(result.status).toBe('READY_TO_SEND');
    expect(tx.reservationRequestStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          previousStatus: 'INCOMPLETE_DATA',
          newStatus: 'READY_TO_SEND',
          actorType: 'USER',
          actorId: USER.id,
          reason: null,
        }) as unknown,
      }),
    );
  });

  it('quitar las personas registra READY_TO_SEND → INCOMPLETE_DATA', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({
        status: 'READY_TO_SEND',
        reservationAt: new Date(future()),
        numberOfPeople: 2,
      }),
    );
    await service.update(REQUEST_ID, { numberOfPeople: null }, USER);
    expect(tx.reservationRequestStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          previousStatus: 'READY_TO_SEND',
          newStatus: 'INCOMPLETE_DATA',
        }) as unknown,
      }),
    );
  });

  it('editar otros campos sin cambiar el estado no escribe historial', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({
        status: 'READY_TO_SEND',
        reservationAt: new Date(future()),
        numberOfPeople: 2,
      }),
    );
    const result = await service.update(
      REQUEST_ID,
      { comments: 'Cumpleaños' },
      USER,
    );
    expect(result.status).toBe('READY_TO_SEND');
    expect(tx.reservationRequestStatusHistory.create).not.toHaveBeenCalled();
  });

  it('crear una solicitud no escribe historial (solo cambios de estado)', async () => {
    const { tx, service } = setup();
    await service.create({
      customerId: CUSTOMER_ID,
      sourceChannel: 'PHONE',
      reservationAt: future(),
      numberOfPeople: 2,
    });
    expect(tx.reservationRequest.create).toHaveBeenCalled();
    expect(tx.reservationRequestStatusHistory.create).not.toHaveBeenCalled();
  });

  it('el detalle incluye el historial ordenado', async () => {
    const { prisma, service } = setup();
    prisma.reservationRequest.findUnique.mockResolvedValue({
      ...stored(),
      statusHistory: [],
    });
    const result = await service.findOne(REQUEST_ID);
    expect(prisma.reservationRequest.findUnique).toHaveBeenCalledWith({
      where: { id: REQUEST_ID },
      select: reservationRequestDetailSelect,
    });
    expect(reservationRequestDetailSelect.statusHistory.orderBy).toEqual([
      { createdAt: 'asc' },
      { id: 'asc' },
    ]);
    expect(result.statusHistory).toEqual([]);
  });
});

describe('ReservationRequestsService: conversación vinculada', () => {
  it('crea la solicitud vinculada a una conversación del mismo cliente', async () => {
    const { tx, service } = setup();
    tx.conversation.findUnique.mockResolvedValue({ customerId: CUSTOMER_ID });
    const result = await service.create({
      customerId: CUSTOMER_ID,
      sourceChannel: 'WHATSAPP',
      conversationId: CONVERSATION_ID,
    });
    expect(tx.conversation.findUnique).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
      select: { customerId: true },
    });
    expect(result.conversationId).toBe(CONVERSATION_ID);
  });

  it('sin conversación no la busca y sigue funcionando como antes', async () => {
    const { tx, service } = setup();
    await service.create({ customerId: CUSTOMER_ID, sourceChannel: 'PHONE' });
    expect(tx.conversation.findUnique).not.toHaveBeenCalled();
    expect(tx.reservationRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ conversationId: undefined }) as unknown,
      }),
    );
  });

  it('rechaza una conversación inexistente', async () => {
    const { tx, service } = setup();
    tx.conversation.findUnique.mockResolvedValue(null);
    await expect(
      service.create({
        customerId: CUSTOMER_ID,
        sourceChannel: 'WHATSAPP',
        conversationId: CONVERSATION_ID,
      }),
    ).rejects.toThrow(NotFoundException);
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
  });

  it('rechaza una conversación de otro cliente', async () => {
    const { tx, service } = setup();
    tx.conversation.findUnique.mockResolvedValue({
      customerId: OTHER_CUSTOMER_ID,
    });
    await expect(
      service.create({
        customerId: CUSTOMER_ID,
        sourceChannel: 'WHATSAPP',
        conversationId: CONVERSATION_ID,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.reservationRequest.create).not.toHaveBeenCalled();
  });

  it('cambiar solo el cliente vuelve a validar la conversación vinculada', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({ conversationId: CONVERSATION_ID }),
    );
    tx.conversation.findUnique.mockResolvedValue({ customerId: CUSTOMER_ID });
    await expect(
      service.update(REQUEST_ID, { customerId: OTHER_CUSTOMER_ID }, USER),
    ).rejects.toThrow('La conversación pertenece a otro cliente');
    expect(tx.reservationRequest.update).not.toHaveBeenCalled();
  });

  it('desvincular con null no consulta la conversación', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({ conversationId: CONVERSATION_ID }),
    );
    await service.update(REQUEST_ID, { conversationId: null }, USER);
    expect(tx.conversation.findUnique).not.toHaveBeenCalled();
    expect(tx.reservationRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ conversationId: null }) as unknown,
      }),
    );
  });

  it('una edición que no toca cliente ni conversación no la vuelve a consultar', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({ conversationId: CONVERSATION_ID }),
    );
    await service.update(REQUEST_ID, { comments: 'Mesa interior' }, USER);
    expect(tx.conversation.findUnique).not.toHaveBeenCalled();
  });
});

describe('ReservationRequestsService: aprobación manual', () => {
  const ITEM = 'd4c3b2a1-0f9e-4d8c-8b7a-6f5e4d3c2b1a';
  const ready = (overrides: Record<string, unknown> = {}) =>
    stored({
      status: 'READY_TO_SEND',
      reservationAt: new Date(future()),
      numberOfPeople: 4,
      commercialItemId: ITEM,
      specialRequirements: 'Mesa junto a la ventana',
      reservation: null,
      ...overrides,
    });

  it('aprobar: ACCEPTED, historial USER y una reserva CONFIRMED con los datos de la solicitud, en una transacción', async () => {
    const { tx, transaction, support, service } = setup();
    const request = ready();
    tx.reservationRequest.findUnique.mockResolvedValue(request);
    const result = await service.approve(REQUEST_ID, USER);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(support.commercialItem).toHaveBeenCalledWith(tx, ITEM);
    expect(support.code).toHaveBeenCalledWith(
      tx,
      'reservation',
      'America/Lima',
      expect.any(Date),
    );
    expect(tx.reservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reservationRequestId: REQUEST_ID,
          customerId: CUSTOMER_ID,
          commercialItemId: ITEM,
          reservationAt: request.reservationAt,
          numberOfPeople: 4,
          notes: 'Mesa junto a la ventana',
          status: 'CONFIRMED',
        }) as unknown,
      }),
    );
    expect(tx.reservationRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ACCEPTED' } }),
    );
    expect(tx.reservationRequestStatusHistory.create).toHaveBeenCalledWith({
      data: {
        reservationRequestId: REQUEST_ID,
        previousStatus: 'READY_TO_SEND',
        newStatus: 'ACCEPTED',
        actorType: 'USER',
        actorId: USER.id,
        reason: null,
      },
      select: { id: true },
    });
    expect(result.request.status).toBe('ACCEPTED');
    expect(result.reservation).toMatchObject({
      id: 'reservation-1',
      status: 'CONFIRMED',
      assignedUser: null,
    });
  });

  it('aprobar dos veces devuelve la misma reserva, sin crear otra ni escribir historial', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      ready({
        status: 'ACCEPTED',
        reservation: {
          id: 'reservation-1',
          code: 'R-2026-000001',
          status: 'CONFIRMED',
          assignedUser: null,
        },
      }),
    );
    const result = await service.approve(REQUEST_ID, USER);
    expect(result.reservation).toMatchObject({ id: 'reservation-1' });
    expect(result.request).not.toHaveProperty('reservation');
    expect(tx.reservation.create).not.toHaveBeenCalled();
    expect(tx.reservationRequest.update).not.toHaveBeenCalled();
    expect(tx.reservationRequestStatusHistory.create).not.toHaveBeenCalled();
  });

  it.each([
    ['REJECTED', 'no se puede aprobar'],
    ['CANCELLED', 'no se puede aprobar'],
    ['MODIFICATION_REQUESTED', 'no se puede aprobar'],
    ['INCOMPLETE_DATA', 'Completa la fecha y el número de personas'],
  ])(
    'aprobar en %s responde 409 sin crear la reserva',
    async (status, text) => {
      const { tx, service } = setup();
      tx.reservationRequest.findUnique.mockResolvedValue(
        ready({ status, reservationAt: null, numberOfPeople: null }),
      );
      await expect(service.approve(REQUEST_ID, USER)).rejects.toThrow(text);
      expect(tx.reservation.create).not.toHaveBeenCalled();
    },
  );

  it('una solicitud con fecha pasada no se aprueba', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      ready({ reservationAt: new Date(Date.now() - 60000) }),
    );
    await expect(service.approve(REQUEST_ID, USER)).rejects.toThrow(
      ConflictException,
    );
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('un servicio retirado del catálogo bloquea la aprobación (misma regla que la reserva manual)', async () => {
    const { tx, support, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(ready());
    support.commercialItem.mockRejectedValue(
      new BadRequestException(
        'El elemento comercial debe estar activo y aprobado',
      ),
    );
    await expect(service.approve(REQUEST_ID, USER)).rejects.toThrow(
      BadRequestException,
    );
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('si falla el historial, falla toda la aprobación (la transacción se revierte)', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(ready());
    const failure = new Error('history down');
    tx.reservationRequestStatusHistory.create.mockRejectedValue(failure);
    await expect(service.approve(REQUEST_ID, USER)).rejects.toBe(failure);
  });

  it('una solicitud inexistente responde 404', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(null);
    await expect(service.approve(REQUEST_ID, USER)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ReservationRequestsService: rechazo manual', () => {
  it('rechazar: REJECTED con motivo en el historial y sin reserva', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({ status: 'READY_TO_SEND' }),
    );
    const result = await service.reject(
      REQUEST_ID,
      { reason: 'No hay mesas ese día' },
      USER,
    );
    expect(result.status).toBe('REJECTED');
    expect(tx.reservation.create).not.toHaveBeenCalled();
    expect(tx.reservationRequestStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        previousStatus: 'READY_TO_SEND',
        newStatus: 'REJECTED',
        actorType: 'USER',
        actorId: USER.id,
        reason: 'No hay mesas ese día',
      }) as unknown,
      select: { id: true },
    });
  });

  it('también se puede rechazar una solicitud incompleta', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(stored());
    await expect(service.reject(REQUEST_ID, {}, USER)).resolves.toMatchObject({
      status: 'REJECTED',
    });
  });

  it('rechazar dos veces no cambia nada ni duplica el historial', async () => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(
      stored({ status: 'REJECTED' }),
    );
    await service.reject(REQUEST_ID, { reason: 'otro motivo' }, USER);
    expect(tx.reservationRequest.update).not.toHaveBeenCalled();
    expect(tx.reservationRequestStatusHistory.create).not.toHaveBeenCalled();
  });

  it.each([
    ['ACCEPTED', 'ya fue aprobada'],
    ['CANCELLED', 'no se puede rechazar'],
    ['RENEGOTIATING', 'no se puede rechazar'],
  ])('rechazar en %s responde 409', async (status, text) => {
    const { tx, service } = setup();
    tx.reservationRequest.findUnique.mockResolvedValue(stored({ status }));
    await expect(service.reject(REQUEST_ID, {}, USER)).rejects.toThrow(text);
    expect(tx.reservationRequest.update).not.toHaveBeenCalled();
  });
});
