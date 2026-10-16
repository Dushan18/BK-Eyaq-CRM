import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AssignReservationDto,
  CreateReservationNoteDto,
  RescheduleReservationDto,
  ReservationQueryDto,
  UpdateReservationStatusDto,
} from './reservation.dto';

const options = { whitelist: true, forbidNonWhitelisted: true };
describe('Calendar DTOs', () => {
  it.each([{}, { assignedUserId: '' }, { assignedUserId: 'invalid' }])(
    'asignación inválida %j',
    async (body) => {
      expect(
        (await validate(plainToInstance(AssignReservationDto, body), options))
          .length,
      ).toBeGreaterThan(0);
    },
  );
  it('permite desasignar explícitamente', async () => {
    expect(
      await validate(
        plainToInstance(AssignReservationDto, { assignedUserId: null }),
        options,
      ),
    ).toEqual([]);
  });
  it.each([
    {},
    { content: null },
    { content: '   ' },
    { content: 'x'.repeat(5001) },
    { content: 'Test', authorUserId: 'invented' },
  ])('nota inválida %j', async (body) => {
    expect(
      (await validate(plainToInstance(CreateReservationNoteDto, body), options))
        .length,
    ).toBeGreaterThan(0);
  });
  it('recorta observación', async () => {
    const dto = plainToInstance(CreateReservationNoteDto, {
      content: ' Test ',
    });
    expect(await validate(dto, options)).toEqual([]);
    expect(dto.content).toBe('Test');
  });
  it.each([
    { reservationAt: '2030-01-01T12:00:00' },
    { reservationAt: null },
    { reservationAt: '2030-01-01T12:00:00Z', reason: ' ' },
    { reservationAt: '2030-01-01T12:00:00Z', changedByUserId: 'fake' },
  ])('reprogramación inválida %j', async (body) => {
    expect(
      (await validate(plainToInstance(RescheduleReservationDto, body), options))
        .length,
    ).toBeGreaterThan(0);
  });
  it.each([
    ['true', true],
    ['false', false],
  ])('convierte booleano %s sin coerción insegura', async (input, expected) => {
    const dto = plainToInstance(ReservationQueryDto, {
      excludeCancelled: input,
    });
    expect(await validate(dto, options)).toEqual([]);
    expect(dto.excludeCancelled).toBe(expected);
  });
  it.each([
    { excludeCancelled: 'yes' },
    { assignedUserId: 'bad' },
    { commercialItemId: null },
    { search: ' ' },
  ])('consulta inválida %j', async (body) => {
    expect(
      (await validate(plainToInstance(ReservationQueryDto, body), options))
        .length,
    ).toBeGreaterThan(0);
  });
  it('UPCOMING habilitado; RESCHEDULED solo mediante cambio de fecha', async () => {
    expect(
      await validate(
        plainToInstance(UpdateReservationStatusDto, { status: 'UPCOMING' }),
        options,
      ),
    ).toEqual([]);
    expect(
      (
        await validate(
          plainToInstance(UpdateReservationStatusDto, {
            status: 'RESCHEDULED',
          }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
