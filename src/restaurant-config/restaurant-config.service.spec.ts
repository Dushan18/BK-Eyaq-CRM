/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import {
  CurrencyCode,
  DayOfWeek,
  LanguageCode,
  RestaurantConfigScope,
  RoleCode,
} from '../../generated/prisma/enums';
import type { PrismaService } from '../database/prisma.service';
import type { PutRestaurantConfigDto } from '../dto/put-restaurant-config.dto';
import { RestaurantConfigService } from './restaurant-config.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('RestaurantConfigService', () => {
  const configId = '5ded68d7-41b0-4a3c-aef5-08de01b4b6a3';
  const ownerId = 'ef3458ae-3b8b-4aed-8d34-fdb4cb5ea978';

  const findUnique = jest.fn();
  const transaction = jest.fn();

  const responsibleFindUnique = jest.fn();
  const configUpsert = jest.fn();
  const configFindUniqueOrThrow = jest.fn();
  const scheduleDeleteMany = jest.fn();
  const scheduleCreateMany = jest.fn();
  const languageDeleteMany = jest.fn();
  const languageCreateMany = jest.fn();

  const tx = {
    user: {
      findUnique: responsibleFindUnique,
    },
    restaurantConfig: {
      upsert: configUpsert,
      findUniqueOrThrow: configFindUniqueOrThrow,
    },
    restaurantSchedule: {
      deleteMany: scheduleDeleteMany,
      createMany: scheduleCreateMany,
    },
    restaurantLanguage: {
      deleteMany: languageDeleteMany,
      createMany: languageCreateMany,
    },
  };

  const prisma = {
    restaurantConfig: {
      findUnique,
    },
    $transaction: transaction,
  } as unknown as PrismaService;

  let service: RestaurantConfigService;

  const allSchedules = (): PutRestaurantConfigDto['schedules'] => [
    {
      dayOfWeek: DayOfWeek.SUNDAY,
      isOpen: false,
    },
    {
      dayOfWeek: DayOfWeek.WEDNESDAY,
      isOpen: true,
      openTime: '09:00',
      closeTime: '18:00',
    },
    {
      dayOfWeek: DayOfWeek.MONDAY,
      isOpen: true,
      openTime: '08:30',
      closeTime: '17:30',
    },
    {
      dayOfWeek: DayOfWeek.SATURDAY,
      isOpen: false,
    },
    {
      dayOfWeek: DayOfWeek.FRIDAY,
      isOpen: true,
      openTime: '09:00',
      closeTime: '18:00',
    },
    {
      dayOfWeek: DayOfWeek.TUESDAY,
      isOpen: true,
      openTime: '09:00',
      closeTime: '18:00',
    },
    {
      dayOfWeek: DayOfWeek.THURSDAY,
      isOpen: true,
      openTime: '09:00',
      closeTime: '18:00',
    },
  ];

  const validDto = (): PutRestaurantConfigDto => ({
    businessName: ' Restaurante EYAQ ',
    logoUrl: ' https://eyaqsystems.com/logo.png ',
    description: ' Restaurante de prueba ',
    address: ' Av. Principal 123 ',
    latitude: -12.046374,
    longitude: -77.042793,
    whatsappNumber: ' +51987654321 ',
    email: ' CONTACTO@EYAQSYSTEMS.COM ',
    website: ' https://eyaqsystems.com ',
    currency: CurrencyCode.PEN,
    timeZone: ' America/Lima ',
    reservationPolicy: ' Reservar con anticipación ',
    cancellationPolicy: ' Cancelar con anticipación ',
    responseTimeoutMinutes: 15,
    approvalResponsibleId: ownerId,
    languages: [LanguageCode.PT, LanguageCode.ES],
    schedules: allSchedules(),
  });

  const configRecord = () => ({
    id: configId,
    businessName: 'Restaurante EYAQ',
    logoUrl: 'https://eyaqsystems.com/logo.png',
    description: 'Restaurante de prueba',
    address: 'Av. Principal 123',
    latitude: new Prisma.Decimal('-12.0463740'),
    longitude: new Prisma.Decimal('-77.0427930'),
    whatsappNumber: '+51987654321',
    email: 'contacto@eyaqsystems.com',
    website: 'https://eyaqsystems.com',
    currency: CurrencyCode.PEN,
    timeZone: 'America/Lima',
    reservationPolicy: 'Reservar con anticipación',
    cancellationPolicy: 'Cancelar con anticipación',
    responseTimeoutMinutes: 15,
    approvalResponsibleId: ownerId,
    createdAt: new Date('2026-09-02T12:00:00.000Z'),
    updatedAt: new Date('2026-09-02T12:00:00.000Z'),
    approvalResponsible: {
      id: ownerId,
      firstName: 'Olivia',
      lastName: 'Owner',
      email: 'owner@eyaqsystems.com',
    },
    languages: [
      { language: LanguageCode.PT },
      { language: LanguageCode.EN },
      { language: LanguageCode.ES },
    ],
    schedules: allSchedules(),
  });

  beforeEach(() => {
    jest.resetAllMocks();

    service = new RestaurantConfigService(prisma);

    responsibleFindUnique.mockResolvedValue({
      id: ownerId,
      isActive: true,
      roles: [
        {
          role: {
            code: RoleCode.OWNER,
          },
        },
      ],
    });
    configUpsert.mockResolvedValue({ id: configId });
    scheduleDeleteMany.mockResolvedValue({ count: 0 });
    scheduleCreateMany.mockResolvedValue({ count: 7 });
    languageDeleteMany.mockResolvedValue({ count: 0 });
    languageCreateMany.mockResolvedValue({ count: 2 });
    configFindUniqueOrThrow.mockResolvedValue(configRecord());
    transaction.mockImplementation(
      async (
        callback: (transactionClient: typeof tx) => Promise<unknown>,
      ): Promise<unknown> => callback(tx),
    );
  });

  describe('findOne', () => {
    it('retorna 404 cuando aún no existe la configuración global', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.findOne()).rejects.toBeInstanceOf(NotFoundException);

      expect(findUnique).toHaveBeenCalledWith({
        where: {
          scope: RestaurantConfigScope.GLOBAL,
        },
        select: expect.any(Object),
      });
    });

    it('serializa decimales, ordena idiomas y horarios y no selecciona datos sensibles', async () => {
      findUnique.mockResolvedValue(configRecord());

      const result = await service.findOne();
      const query = findUnique.mock.calls[0][0] as {
        select: Record<string, unknown> & {
          approvalResponsible: {
            select: Record<string, unknown>;
          };
        };
      };

      expect(result.latitude).toBe(-12.046374);
      expect(result.longitude).toBe(-77.042793);
      expect(result.languages).toEqual([
        LanguageCode.ES,
        LanguageCode.EN,
        LanguageCode.PT,
      ]);
      expect(result.schedules.map(({ dayOfWeek }) => dayOfWeek)).toEqual(
        Object.values(DayOfWeek),
      );
      expect(result).not.toHaveProperty('passwordHash');
      expect(result.approvalResponsible).not.toHaveProperty('passwordHash');
      expect(query.select).not.toHaveProperty('passwordHash');
      expect(query.select.approvalResponsible.select).not.toHaveProperty(
        'passwordHash',
      );
    });
  });

  describe('upsert', () => {
    it('crea o actualiza GLOBAL y reemplaza horarios e idiomas dentro de una transacción Serializable', async () => {
      const result = await service.upsert(validDto());

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
      expect(responsibleFindUnique).toHaveBeenCalledWith({
        where: { id: ownerId },
        select: expect.any(Object),
      });
      expect(configUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            scope: RestaurantConfigScope.GLOBAL,
          },
          create: expect.objectContaining({
            scope: RestaurantConfigScope.GLOBAL,
            businessName: 'Restaurante EYAQ',
            email: 'contacto@eyaqsystems.com',
            approvalResponsible: {
              connect: { id: ownerId },
            },
          }),
          update: expect.objectContaining({
            businessName: 'Restaurante EYAQ',
            approvalResponsible: {
              connect: { id: ownerId },
            },
          }),
        }),
      );
      expect(scheduleDeleteMany).toHaveBeenCalledWith({
        where: { restaurantConfigId: configId },
      });
      expect(scheduleCreateMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          {
            restaurantConfigId: configId,
            dayOfWeek: DayOfWeek.MONDAY,
            isOpen: true,
            openTime: '08:30',
            closeTime: '17:30',
          },
          {
            restaurantConfigId: configId,
            dayOfWeek: DayOfWeek.SUNDAY,
            isOpen: false,
            openTime: null,
            closeTime: null,
          },
        ]),
      });
      expect(languageDeleteMany).toHaveBeenCalledWith({
        where: { restaurantConfigId: configId },
      });
      expect(languageCreateMany).toHaveBeenCalledWith({
        data: [
          {
            restaurantConfigId: configId,
            language: LanguageCode.PT,
          },
          {
            restaurantConfigId: configId,
            language: LanguageCode.ES,
          },
        ],
      });
      expect(scheduleDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        scheduleCreateMany.mock.invocationCallOrder[0],
      );
      expect(languageDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        languageCreateMany.mock.invocationCallOrder[0],
      );
      expect(result.languages).toEqual([
        LanguageCode.ES,
        LanguageCode.EN,
        LanguageCode.PT,
      ]);
    });

    it('desconecta el responsable cuando PUT recibe null', async () => {
      const dto = validDto();
      dto.approvalResponsibleId = null;

      await service.upsert(dto);

      expect(responsibleFindUnique).not.toHaveBeenCalled();
      expect(configUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            approvalResponsible: {
              disconnect: true,
            },
          }),
        }),
      );
    });

    it('convierte opcionales omitidos en null para mantener semántica de reemplazo', async () => {
      const dto = validDto();
      delete dto.logoUrl;
      delete dto.description;
      delete dto.website;
      delete dto.latitude;
      delete dto.longitude;
      delete dto.approvalResponsibleId;

      await service.upsert(dto);

      expect(configUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            logoUrl: null,
            description: null,
            website: null,
            latitude: null,
            longitude: null,
          }),
          update: expect.objectContaining({
            logoUrl: null,
            description: null,
            website: null,
            latitude: null,
            longitude: null,
            approvalResponsible: {
              disconnect: true,
            },
          }),
        }),
      );
    });

    it('usa el mismo scope GLOBAL en PUT sucesivos', async () => {
      await service.upsert(validDto());
      await service.upsert(validDto());

      expect(configUpsert).toHaveBeenCalledTimes(2);
      for (const [arguments_] of configUpsert.mock.calls) {
        expect(arguments_).toEqual(
          expect.objectContaining({
            where: {
              scope: RestaurantConfigScope.GLOBAL,
            },
          }),
        );
      }
    });

    it.each([
      {
        name: 'inexistente',
        responsible: null,
        message: 'El responsable de aprobación no existe',
      },
      {
        name: 'inactivo',
        responsible: {
          id: ownerId,
          isActive: false,
          roles: [{ role: { code: RoleCode.OWNER } }],
        },
        message: 'El responsable de aprobación debe estar activo',
      },
      {
        name: 'sin OWNER',
        responsible: {
          id: ownerId,
          isActive: true,
          roles: [{ role: { code: RoleCode.ADMIN } }],
        },
        message: 'El responsable de aprobación debe tener el rol OWNER',
      },
    ])(
      'rechaza un responsable $name antes de escribir la configuración',
      async ({ responsible, message }) => {
        responsibleFindUnique.mockResolvedValue(responsible);

        await expect(service.upsert(validDto())).rejects.toMatchObject({
          constructor: BadRequestException,
          message,
        });

        expect(configUpsert).not.toHaveBeenCalled();
        expect(scheduleDeleteMany).not.toHaveBeenCalled();
        expect(languageDeleteMany).not.toHaveBeenCalled();
      },
    );

    it('reintenta la transacción cuando Prisma devuelve P2034 y luego responde', async () => {
      transaction.mockRejectedValueOnce({ code: 'P2034' });

      await expect(service.upsert(validDto())).resolves.toEqual(
        expect.objectContaining({ id: configId }),
      );

      expect(transaction).toHaveBeenCalledTimes(2);
    });

    it('convierte P2034 persistente en ConflictException después de tres intentos', async () => {
      transaction.mockRejectedValue({ code: 'P2034' });

      await expect(service.upsert(validDto())).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(transaction).toHaveBeenCalledTimes(3);
    });

    it('rechaza coordenadas incompletas antes de abrir la transacción', async () => {
      const dto = validDto();
      dto.longitude = null;

      await expect(service.upsert(dto)).rejects.toThrow(
        'latitude y longitude deben proporcionarse juntas',
      );

      expect(transaction).not.toHaveBeenCalled();
    });

    it('rechaza días faltantes o duplicados antes de abrir la transacción', async () => {
      const dto = validDto();
      dto.schedules = [
        ...allSchedules().slice(0, 6),
        {
          dayOfWeek: DayOfWeek.MONDAY,
          isOpen: false,
        },
      ];

      await expect(service.upsert(dto)).rejects.toThrow(
        'schedules debe contener exactamente una entrada para cada día de la semana',
      );

      expect(transaction).not.toHaveBeenCalled();
    });

    it('rechaza horarios incoherentes y los que cruzan la medianoche', async () => {
      const dto = validDto();
      dto.schedules = allSchedules().map((schedule) =>
        schedule.dayOfWeek === DayOfWeek.MONDAY
          ? {
              ...schedule,
              openTime: '18:00',
              closeTime: '02:00',
            }
          : schedule,
      );

      await expect(service.upsert(dto)).rejects.toThrow(
        'Los horarios son incoherentes o cruzan la medianoche',
      );

      expect(transaction).not.toHaveBeenCalled();
    });

    it('propaga un error al crear horarios y no continúa con idiomas', async () => {
      const childError = new Error('schedule insert failed');
      scheduleCreateMany.mockRejectedValue(childError);

      await expect(service.upsert(validDto())).rejects.toBe(childError);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(scheduleDeleteMany).toHaveBeenCalled();
      expect(scheduleCreateMany).toHaveBeenCalled();
      expect(languageDeleteMany).not.toHaveBeenCalled();
      expect(languageCreateMany).not.toHaveBeenCalled();
      expect(configFindUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('propaga un error al crear idiomas y no retorna una respuesta parcial', async () => {
      const childError = new Error('language insert failed');
      languageCreateMany.mockRejectedValue(childError);

      await expect(service.upsert(validDto())).rejects.toBe(childError);

      expect(scheduleCreateMany).toHaveBeenCalled();
      expect(languageDeleteMany).toHaveBeenCalled();
      expect(languageCreateMany).toHaveBeenCalled();
      expect(configFindUniqueOrThrow).not.toHaveBeenCalled();
    });
  });
});
