import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateReservationRequestDto,
  ReservationRequestQueryDto,
  UpdateReservationRequestDto,
  UpdateReservationRequestStatusDto,
} from './reservation-request.dto';
import {
  CreateReservationDto,
  UpdateReservationDto,
  UpdateReservationStatusDto,
} from './reservation.dto';

const customerId = '052cfe2a-ff46-47c1-aa84-283113d92e68';
const options = { whitelist: true, forbidNonWhitelisted: true };
const valid = { customerId, sourceChannel: 'PHONE' };

describe('Reservation DTOs', () => {
  it('permite solicitudes incompletas y limpia texto', async () => {
    const dto = plainToInstance(CreateReservationRequestDto, {
      ...valid,
      comments: ' Test ',
    });
    expect(await validate(dto, options)).toEqual([]);
    expect(dto.comments).toBe('Test');
  });
  it.each([
    { customerId: null },
    { sourceChannel: null },
    { customerId: 'bad' },
    { sourceChannel: 'INVALID' },
    { numberOfPeople: 0 },
    { numberOfPeople: 1.5 },
    { numberOfPeople: '4' },
    { numberOfPeople: 2147483648 },
    { reservationAt: '2026-09-20' },
    { reservationAt: '2026-09-20T12:00:00' },
    { reservationAt: '2026-02-30T12:00:00Z' },
    { reservationAt: '2026-09-20T12:00:00+25:00' },
    { quotedPrice: 15 },
    { quotedPrice: '-1.00' },
    { quotedPrice: '1.234' },
    { quotedPrice: '100000000.00' },
    { quotedPrice: '1e2' },
    { currency: 'EUR' },
    { comments: '' },
    { comments: '   ' },
    { status: 'ACCEPTED' },
    { code: 'RES-1' },
    { createdAt: new Date().toISOString() },
  ])('rechaza request inválida %j', async (bad) => {
    expect(
      (
        await validate(
          plainToInstance(CreateReservationRequestDto, { ...valid, ...bad }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it.each(['2026-09-20T19:00:00-05:00', '2026-09-21T00:00:00.000Z'])(
    'acepta zona explícita %s',
    async (reservationAt) => {
      expect(
        await validate(
          plainToInstance(CreateReservationRequestDto, {
            ...valid,
            reservationAt,
          }),
          options,
        ),
      ).toEqual([]);
    },
  );
  it('PATCH permite borrar opcionales pero no cliente/canal', async () => {
    expect(
      await validate(
        plainToInstance(UpdateReservationRequestDto, {
          reservationAt: null,
          numberOfPeople: null,
          comments: null,
        }),
        options,
      ),
    ).toEqual([]);
    expect(
      (
        await validate(
          plainToInstance(UpdateReservationRequestDto, {
            customerId: null,
            sourceChannel: null,
          }),
          options,
        )
      ).length,
    ).toBe(2);
  });
  it('reserva exige fecha y personas', async () => {
    expect(
      (
        await validate(
          plainToInstance(CreateReservationDto, { customerId }),
          options,
        )
      ).length,
    ).toBe(2);
  });
  it.each([
    { status: 'CONFIRMED' },
    { reservationRequestId: customerId },
    { code: 'R-1' },
  ])('reserva manual no acepta %j', async (bad) => {
    expect(
      (
        await validate(
          plainToInstance(CreateReservationDto, {
            customerId,
            reservationAt: '2030-01-01T12:00:00Z',
            numberOfPeople: 4,
            ...bad,
          }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('PATCH de reserva no permite borrar obligatorios', async () => {
    expect(
      (
        await validate(
          plainToInstance(UpdateReservationDto, {
            customerId: null,
            reservationAt: null,
            numberOfPeople: null,
          }),
          options,
        )
      ).length,
    ).toBe(3);
  });
  it.each([
    'ACCEPTED',
    'REJECTED',
    'READY_TO_SEND',
    'INCOMPLETE_DATA',
    'WAITING_RESPONSE',
  ])('bloquea estado request %s', async (status) => {
    expect(
      (
        await validate(
          plainToInstance(UpdateReservationRequestStatusDto, { status }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it.each(['RESCHEDULED', 'INVALID'])(
    'bloquea estado operativo %s',
    async (status) => {
      expect(
        (
          await validate(
            plainToInstance(UpdateReservationStatusDto, { status }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);
    },
  );
  it('consulta conserva la paginación existente', async () => {
    const dto = plainToInstance(ReservationRequestQueryDto, {
      page: '2',
      limit: '10',
    });
    expect(await validate(dto, options)).toEqual([]);
    expect(dto).toMatchObject({ page: 2, limit: 10 });
  });
  it.each([
    { limit: '101' },
    { page: '0' },
    { orderBy: 'code' },
    { dateFrom: '2026-09-20' },
    { channel: 'INVALID' },
  ])('rechaza query %j', async (bad) => {
    expect(
      (
        await validate(
          plainToInstance(ReservationRequestQueryDto, bad),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
