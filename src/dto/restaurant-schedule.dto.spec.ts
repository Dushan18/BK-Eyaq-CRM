import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { DayOfWeek } from '../../generated/prisma/enums';
import { RestaurantScheduleDto } from './restaurant-schedule.dto';

describe('RestaurantScheduleDto', () => {
  const validateInput = async (
    input: Record<string, unknown>,
  ): Promise<ValidationError[]> =>
    validate(plainToInstance(RestaurantScheduleDto, input));

  it('acepta un día abierto con un rango diurno válido', async () => {
    await expect(
      validateInput({
        dayOfWeek: DayOfWeek.MONDAY,
        isOpen: true,
        openTime: '09:00',
        closeTime: '18:00',
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    { dayOfWeek: DayOfWeek.SUNDAY, isOpen: false },
    {
      dayOfWeek: DayOfWeek.SUNDAY,
      isOpen: false,
      openTime: null,
      closeTime: null,
    },
  ])('acepta un día cerrado sin horas', async (input) => {
    await expect(validateInput(input)).resolves.toHaveLength(0);
  });

  it.each([
    ['9:00', '18:00'],
    ['09:00', '24:00'],
    ['09:00', '18:60'],
  ])(
    'rechaza horas fuera del formato HH:mm: %s - %s',
    async (openTime, closeTime) => {
      const errors = await validateInput({
        dayOfWeek: DayOfWeek.MONDAY,
        isOpen: true,
        openTime,
        closeTime,
      });

      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each([
    { dayOfWeek: DayOfWeek.MONDAY, isOpen: true },
    {
      dayOfWeek: DayOfWeek.MONDAY,
      isOpen: true,
      openTime: '09:00',
    },
    {
      dayOfWeek: DayOfWeek.MONDAY,
      isOpen: true,
      closeTime: '18:00',
    },
  ])('rechaza un día abierto sin ambas horas', async (input) => {
    const errors = await validateInput(input);

    expect(errors.some((error) => error.property === 'isOpen')).toBe(true);
  });

  it('rechaza un día cerrado que contiene horas', async () => {
    const errors = await validateInput({
      dayOfWeek: DayOfWeek.SUNDAY,
      isOpen: false,
      openTime: '09:00',
      closeTime: '18:00',
    });

    expect(errors.some((error) => error.property === 'isOpen')).toBe(true);
  });

  it.each([
    ['18:00', '18:00'],
    ['18:00', '09:00'],
    ['18:00', '02:00'],
  ])(
    'rechaza un horario igual, invertido o nocturno: %s - %s',
    async (openTime, closeTime) => {
      const errors = await validateInput({
        dayOfWeek: DayOfWeek.MONDAY,
        isOpen: true,
        openTime,
        closeTime,
      });

      expect(errors.some((error) => error.property === 'isOpen')).toBe(true);
    },
  );
});
