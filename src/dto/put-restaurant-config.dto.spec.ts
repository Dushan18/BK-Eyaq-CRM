import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import {
  CurrencyCode,
  DayOfWeek,
  LanguageCode,
} from '../../generated/prisma/enums';
import { PutRestaurantConfigDto } from './put-restaurant-config.dto';
import { RestaurantScheduleDto } from './restaurant-schedule.dto';

describe('PutRestaurantConfigDto', () => {
  const approvalResponsibleId = '11111111-1111-4111-8111-111111111111';

  const validSchedules = () =>
    Object.values(DayOfWeek).map((dayOfWeek) =>
      dayOfWeek === DayOfWeek.SUNDAY
        ? {
            dayOfWeek,
            isOpen: false,
            openTime: null,
            closeTime: null,
          }
        : {
            dayOfWeek,
            isOpen: true,
            openTime: '09:00',
            closeTime: '18:00',
          },
    );

  const validInput = () => ({
    businessName: 'EYAQ Restaurant',
    logoUrl: 'https://example.com/logo.png',
    description: 'Restaurante de comida peruana',
    address: 'Av. Principal 123, Lima',
    latitude: -12.046374,
    longitude: -77.042793,
    whatsappNumber: '+51987654321',
    email: 'contacto@eyaqsystems.com',
    website: 'https://eyaqsystems.com',
    currency: CurrencyCode.PEN,
    timeZone: 'America/Lima',
    reservationPolicy: 'Reservar con anticipación.',
    cancellationPolicy: 'Cancelar con dos horas de anticipación.',
    responseTimeoutMinutes: 30,
    approvalResponsibleId,
    languages: [LanguageCode.ES, LanguageCode.EN],
    schedules: validSchedules(),
  });

  const validateInput = async (
    input: Record<string, unknown>,
  ): Promise<ValidationError[]> => {
    const dto = plainToInstance(PutRestaurantConfigDto, input);

    return validate(dto);
  };

  const hasErrorFor = (errors: ValidationError[], property: string): boolean =>
    errors.some((error) => error.property === property);

  it('acepta un body completo válido y transforma los horarios anidados', async () => {
    const dto = plainToInstance(PutRestaurantConfigDto, validInput());

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.schedules).toHaveLength(Object.values(DayOfWeek).length);
    expect(dto.schedules[0]).toBeInstanceOf(RestaurantScheduleDto);
  });

  it('normaliza espacios, email y responseTimeoutMinutes', async () => {
    const dto = plainToInstance(PutRestaurantConfigDto, {
      ...validInput(),
      businessName: '  EYAQ Restaurant  ',
      description: '  Restaurante de comida peruana  ',
      address: '  Av. Principal 123, Lima  ',
      whatsappNumber: '  +51987654321  ',
      email: '  CONTACTO@EYAQSYSTEMS.COM  ',
      website: '  https://eyaqsystems.com  ',
      timeZone: '  America/Lima  ',
      reservationPolicy: '  Reservar con anticipación.  ',
      cancellationPolicy: '  Cancelar con anticipación.  ',
      responseTimeoutMinutes: '45',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toMatchObject({
      businessName: 'EYAQ Restaurant',
      description: 'Restaurante de comida peruana',
      address: 'Av. Principal 123, Lima',
      whatsappNumber: '+51987654321',
      email: 'contacto@eyaqsystems.com',
      website: 'https://eyaqsystems.com',
      timeZone: 'America/Lima',
      reservationPolicy: 'Reservar con anticipación.',
      cancellationPolicy: 'Cancelar con anticipación.',
      responseTimeoutMinutes: 45,
    });
  });

  it('rechaza una moneda que no pertenece a CurrencyCode', async () => {
    const errors = await validateInput({
      ...validInput(),
      currency: 'EUR',
    });

    expect(hasErrorFor(errors, 'currency')).toBe(true);
  });

  it('rechaza un idioma que no pertenece a LanguageCode', async () => {
    const errors = await validateInput({
      ...validInput(),
      languages: [LanguageCode.ES, 'FR'],
    });

    expect(hasErrorFor(errors, 'languages')).toBe(true);
  });

  it('rechaza el array de idiomas vacío', async () => {
    const errors = await validateInput({
      ...validInput(),
      languages: [],
    });

    expect(hasErrorFor(errors, 'languages')).toBe(true);
  });

  it('rechaza idiomas duplicados', async () => {
    const errors = await validateInput({
      ...validInput(),
      languages: [LanguageCode.ES, LanguageCode.ES],
    });

    expect(hasErrorFor(errors, 'languages')).toBe(true);
  });

  it('requiere exactamente los siete días de la semana', async () => {
    const errors = await validateInput({
      ...validInput(),
      schedules: validSchedules().slice(0, -1),
    });

    expect(hasErrorFor(errors, 'schedules')).toBe(true);
  });

  it('rechaza días duplicados aunque el array contenga siete horarios', async () => {
    const schedules = validSchedules();
    schedules[schedules.length - 1] = {
      dayOfWeek: DayOfWeek.MONDAY,
      isOpen: false,
      openTime: null,
      closeTime: null,
    };

    const errors = await validateInput({
      ...validInput(),
      schedules,
    });

    expect(hasErrorFor(errors, 'schedules')).toBe(true);
  });

  it('acepta coordenadas cuando ambas están ausentes o son nulas', async () => {
    const withoutCoordinates = validInput();
    delete withoutCoordinates.latitude;
    delete withoutCoordinates.longitude;

    await expect(validateInput(withoutCoordinates)).resolves.toHaveLength(0);
    await expect(
      validateInput({
        ...validInput(),
        latitude: null,
        longitude: null,
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    ['latitude sin longitude', { latitude: -12.046374, longitude: undefined }],
    ['longitude sin latitude', { latitude: undefined, longitude: -77.042793 }],
  ])('rechaza coordenadas incompletas: %s', async (_name, coordinates) => {
    const errors = await validateInput({
      ...validInput(),
      ...coordinates,
    });

    expect(
      hasErrorFor(errors, 'latitude') || hasErrorFor(errors, 'longitude'),
    ).toBe(true);
  });

  it.each([
    ['latitude', 90.0000001, -77.042793],
    ['latitude', -90.0000001, -77.042793],
    ['longitude', -12.046374, 180.0000001],
    ['longitude', -12.046374, -180.0000001],
  ])('rechaza %s fuera de rango', async (property, latitude, longitude) => {
    const errors = await validateInput({
      ...validInput(),
      latitude,
      longitude,
    });

    expect(hasErrorFor(errors, property)).toBe(true);
  });

  it.each([
    ['latitude', -12.12345678, -77.042793],
    ['longitude', -12.046374, -77.12345678],
  ])(
    'rechaza %s con más de siete decimales',
    async (property, latitude, longitude) => {
      const errors = await validateInput({
        ...validInput(),
        latitude,
        longitude,
      });

      expect(hasErrorFor(errors, property)).toBe(true);
    },
  );

  it('rechaza un WhatsApp que no cumple E.164', async () => {
    const errors = await validateInput({
      ...validInput(),
      whatsappNumber: '987654321',
    });

    expect(hasErrorFor(errors, 'whatsappNumber')).toBe(true);
  });

  it('rechaza una zona horaria IANA inexistente', async () => {
    const errors = await validateInput({
      ...validInput(),
      timeZone: 'Lima/Peru',
    });

    expect(hasErrorFor(errors, 'timeZone')).toBe(true);
  });

  it.each(['logoUrl', 'website'])(
    'rechaza una %s inválida',
    async (property) => {
      const errors = await validateInput({
        ...validInput(),
        [property]: 'ftp://example.com/recurso',
      });

      expect(hasErrorFor(errors, property)).toBe(true);
    },
  );

  it('rechaza un approvalResponsibleId que no es UUID', async () => {
    const errors = await validateInput({
      ...validInput(),
      approvalResponsibleId: 'usuario-1',
    });

    expect(hasErrorFor(errors, 'approvalResponsibleId')).toBe(true);
  });
});
