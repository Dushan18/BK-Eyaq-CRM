/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import {
  CommercialApprovalStatus,
  CommercialItemType,
  DayOfWeek,
} from '../../generated/prisma/enums';
import type { PrismaService } from '../database/prisma.service';
import { CommercialItemsService } from './commercial-items.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('CommercialItemsService', () => {
  const categoryId = '11111111-1111-4111-8111-111111111111';
  const itemId = '22222222-2222-4222-8222-222222222222';
  const now = new Date('2026-09-14T00:00:00.000Z');

  const makeRecord = (overrides: Record<string, unknown> = {}) => ({
    id: itemId,
    type: CommercialItemType.DISH,
    categoryId,
    nameEs: 'Trucha a la parrilla',
    nameEn: 'Grilled trout',
    descriptionEs: null,
    descriptionEn: null,
    basePrice: new Prisma.Decimal('39.90'),
    displayOrder: 0,
    isActive: true,
    approvalStatus: CommercialApprovalStatus.DRAFT,
    conditions: null,
    internalNotes: null,
    availabilityNote: null,
    createdAt: now,
    updatedAt: now,
    category: {
      id: categoryId,
      nameEs: 'Trucha',
      nameEn: 'Trout',
      isActive: true,
      displayOrder: 0,
    },
    variants: [],
    images: [],
    faqs: [],
    schedules: [],
    promotionDetail: null,
    eventDetail: null,
    ...overrides,
  });

  const categoryFindUnique = jest.fn();
  const itemCreate = jest.fn();
  const itemFindMany = jest.fn();
  const itemCount = jest.fn();
  const itemFindUnique = jest.fn();
  const itemFindUniqueOrThrow = jest.fn();
  const itemUpdate = jest.fn();
  const variantDeleteMany = jest.fn();
  const variantCreateMany = jest.fn();
  const imageDeleteMany = jest.fn();
  const imageCreateMany = jest.fn();
  const faqDeleteMany = jest.fn();
  const faqCreateMany = jest.fn();
  const scheduleDeleteMany = jest.fn();
  const scheduleCreateMany = jest.fn();
  const promotionDeleteMany = jest.fn();
  const promotionUpsert = jest.fn();
  const eventDeleteMany = jest.fn();
  const eventUpsert = jest.fn();

  const tx = {
    commercialCategory: { findUnique: categoryFindUnique },
    commercialItem: {
      create: itemCreate,
      findMany: itemFindMany,
      count: itemCount,
      findUnique: itemFindUnique,
      findUniqueOrThrow: itemFindUniqueOrThrow,
      update: itemUpdate,
    },
    commercialItemVariant: {
      deleteMany: variantDeleteMany,
      createMany: variantCreateMany,
    },
    commercialItemImage: {
      deleteMany: imageDeleteMany,
      createMany: imageCreateMany,
    },
    commercialItemFaq: {
      deleteMany: faqDeleteMany,
      createMany: faqCreateMany,
    },
    commercialItemSchedule: {
      deleteMany: scheduleDeleteMany,
      createMany: scheduleCreateMany,
    },
    promotionDetail: {
      deleteMany: promotionDeleteMany,
      upsert: promotionUpsert,
    },
    eventDetail: {
      deleteMany: eventDeleteMany,
      upsert: eventUpsert,
    },
  };

  const transaction = jest.fn();
  const prisma = {
    ...tx,
    $transaction: transaction,
  } as unknown as PrismaService;
  const service = new CommercialItemsService(prisma);

  beforeEach(() => {
    jest.resetAllMocks();
    categoryFindUnique.mockResolvedValue({ id: categoryId, isActive: true });
    itemCreate.mockResolvedValue(makeRecord());
    itemFindMany.mockResolvedValue([makeRecord()]);
    itemCount.mockResolvedValue(1);
    itemFindUnique.mockResolvedValue(makeRecord());
    itemFindUniqueOrThrow.mockResolvedValue(makeRecord());
    itemUpdate.mockResolvedValue(makeRecord());
    variantDeleteMany.mockResolvedValue({ count: 0 });
    variantCreateMany.mockResolvedValue({ count: 1 });
    imageDeleteMany.mockResolvedValue({ count: 0 });
    imageCreateMany.mockResolvedValue({ count: 1 });
    faqDeleteMany.mockResolvedValue({ count: 0 });
    faqCreateMany.mockResolvedValue({ count: 1 });
    scheduleDeleteMany.mockResolvedValue({ count: 0 });
    scheduleCreateMany.mockResolvedValue({ count: 1 });
    promotionDeleteMany.mockResolvedValue({ count: 0 });
    promotionUpsert.mockResolvedValue({ id: 'promotion-id' });
    eventDeleteMany.mockResolvedValue({ count: 0 });
    eventUpsert.mockResolvedValue({ id: 'event-id' });
    transaction.mockImplementation(
      async (
        operation:
          | ((transactionClient: typeof tx) => Promise<unknown>)
          | Promise<unknown>[],
      ) => (Array.isArray(operation) ? Promise.all(operation) : operation(tx)),
    );
  });

  it('crea un plato con precio base dentro de una transacción', async () => {
    const result = await service.create({
      type: CommercialItemType.DISH,
      categoryId,
      nameEs: ' Trucha a la parrilla ',
      basePrice: '39.90',
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(categoryFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: categoryId } }),
    );
    expect(itemCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nameEs: 'Trucha a la parrilla',
          normalizedName: 'trucha a la parrilla',
          basePrice: '39.90',
        }),
      }),
    );
    expect(result.basePrice).toBe('39.90');
  });

  it('crea una bebida con variantes y conserva dos decimales', async () => {
    itemCreate.mockResolvedValue(
      makeRecord({
        type: CommercialItemType.BEVERAGE,
        nameEs: null,
        nameEn: 'Orange juice',
        basePrice: null,
        variants: [
          {
            id: 'variant-id',
            nameEs: null,
            nameEn: 'Without Milk',
            descriptionEs: null,
            descriptionEn: null,
            price: new Prisma.Decimal('14.00'),
            isActive: true,
            displayOrder: 0,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );

    const result = await service.create({
      type: CommercialItemType.BEVERAGE,
      categoryId,
      nameEn: 'Orange juice',
      variants: [{ nameEn: 'Without Milk', price: '14.00' }],
    });

    expect(itemCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          basePrice: null,
          variants: {
            create: [
              expect.objectContaining({
                normalizedName: 'without milk',
                price: '14.00',
              }),
            ],
          },
        }),
      }),
    );
    expect(result.variants[0]?.price).toBe('14.00');
  });

  it('rechaza platos sin precio base ni variantes activas', async () => {
    await expect(
      service.create({
        type: CommercialItemType.DISH,
        categoryId,
        nameEs: 'Sin precio',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rechaza precio base y variantes simultáneos en platos/bebidas', async () => {
    await expect(
      service.create({
        type: CommercialItemType.BEVERAGE,
        categoryId,
        nameEs: 'Jugo',
        basePrice: '10.00',
        variants: [{ nameEs: 'Grande', price: '15.00' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza una categoría inexistente o inactiva', async () => {
    categoryFindUnique.mockResolvedValue(null);

    await expect(
      service.create({
        type: CommercialItemType.DISH,
        categoryId,
        nameEs: 'Plato',
        basePrice: '20.00',
      }),
    ).rejects.toThrow('La categoría comercial no existe');
  });

  it('rechaza detalles especializados incompatibles con el tipo', async () => {
    await expect(
      service.create({
        type: CommercialItemType.SERVICE,
        categoryId,
        nameEs: 'Servicio',
        promotionDetail: {},
      }),
    ).rejects.toThrow('promotionDetail solo corresponde a elementos PROMOTION');
  });

  it('rechaza más de una imagen principal', async () => {
    await expect(
      service.create({
        type: CommercialItemType.SERVICE,
        categoryId,
        nameEs: 'Servicio',
        images: [
          { url: 'https://example.com/1.jpg', isPrimary: true },
          { url: 'https://example.com/2.jpg', isPrimary: true },
        ],
      }),
    ).rejects.toThrow(
      'Un elemento comercial solo puede tener una imagen principal',
    );
  });

  it('acepta horarios que cruzan la medianoche', async () => {
    await service.create({
      type: CommercialItemType.SERVICE,
      categoryId,
      nameEs: 'Cena',
      schedules: [
        {
          dayOfWeek: DayOfWeek.FRIDAY,
          isAvailable: true,
          startTime: '18:00',
          endTime: '02:00',
        },
      ],
    });

    expect(itemCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          schedules: {
            create: [
              expect.objectContaining({
                startTime: '18:00',
                endTime: '02:00',
              }),
            ],
          },
        }),
      }),
    );
  });

  it('combina búsqueda, filtros, paginación y serializa precios', async () => {
    const result = await service.findAll({
      page: 2,
      limit: 10,
      search: 'trucha',
      type: CommercialItemType.DISH,
      isActive: true,
      approvalStatus: CommercialApprovalStatus.APPROVED,
      categoryId,
      sort: 'name',
      order: 'asc',
    });

    expect(itemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: CommercialItemType.DISH,
          categoryId,
          isActive: true,
          approvalStatus: CommercialApprovalStatus.APPROVED,
          OR: expect.arrayContaining([
            { nameEs: { contains: 'trucha', mode: 'insensitive' } },
          ]),
        }),
        skip: 10,
        take: 10,
      }),
    );
    expect(result.data[0]?.basePrice).toBe('39.90');
    expect(result.pagination).toEqual({
      page: 2,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
  });

  it('devuelve 404 al consultar un item inexistente', async () => {
    itemFindUnique.mockResolvedValue(null);

    await expect(service.findOne(itemId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reemplaza arrays presentes y devuelve un item aprobado a DRAFT', async () => {
    itemFindUnique.mockResolvedValue({
      id: itemId,
      type: CommercialItemType.DISH,
      nameEs: 'Trucha',
      nameEn: 'Trout',
      basePrice: new Prisma.Decimal('39.90'),
      approvalStatus: CommercialApprovalStatus.APPROVED,
      variants: [],
    });
    itemFindUniqueOrThrow.mockResolvedValue(
      makeRecord({ approvalStatus: CommercialApprovalStatus.DRAFT }),
    );

    const result = await service.update(itemId, {
      nameEs: 'Trucha especial',
      images: [],
      faqs: [],
      schedules: [],
    });

    expect(itemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: itemId },
        data: expect.objectContaining({
          nameEs: 'Trucha especial',
          approvalStatus: CommercialApprovalStatus.DRAFT,
        }),
      }),
    );
    expect(imageDeleteMany).toHaveBeenCalled();
    expect(faqDeleteMany).toHaveBeenCalled();
    expect(scheduleDeleteMany).toHaveBeenCalled();
    expect(imageCreateMany).not.toHaveBeenCalled();
    expect(result.approvalStatus).toBe(CommercialApprovalStatus.DRAFT);
  });

  it('reemplaza variantes de forma transaccional', async () => {
    itemFindUnique.mockResolvedValue({
      id: itemId,
      type: CommercialItemType.BEVERAGE,
      nameEs: 'Jugo',
      nameEn: null,
      basePrice: null,
      approvalStatus: CommercialApprovalStatus.DRAFT,
      variants: [{ isActive: true }],
    });

    await service.update(itemId, {
      variants: [{ nameEs: 'Con leche', price: '17.00' }],
    });

    expect(variantDeleteMany).toHaveBeenCalledWith({
      where: { commercialItemId: itemId },
    });
    expect(variantCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          commercialItemId: itemId,
          normalizedName: 'con leche',
          price: '17.00',
        }),
      ],
    });
  });

  it('no devuelve una respuesta parcial si falla un recurso hijo', async () => {
    itemFindUnique.mockResolvedValue({
      id: itemId,
      type: CommercialItemType.BEVERAGE,
      nameEs: 'Jugo',
      nameEn: null,
      basePrice: null,
      approvalStatus: CommercialApprovalStatus.DRAFT,
      variants: [{ isActive: true }],
    });
    const childError = new Error('variant insert failed');
    variantCreateMany.mockRejectedValue(childError);

    await expect(
      service.update(itemId, {
        variants: [{ nameEs: 'Grande', price: '20.00' }],
      }),
    ).rejects.toBe(childError);
    expect(itemFindUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('actualiza el estado sin cambiar la aprobación', async () => {
    const result = await service.updateStatus(itemId, { isActive: false });

    expect(itemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
    expect(result.basePrice).toBe('39.90');
  });

  it('exige nombre español antes de aprobar', async () => {
    itemFindUnique.mockResolvedValue({
      id: itemId,
      type: CommercialItemType.BEVERAGE,
      nameEs: null,
      basePrice: new Prisma.Decimal('9.00'),
      category: { isActive: true },
      variants: [],
    });

    await expect(
      service.updateApproval(itemId, {
        approvalStatus: CommercialApprovalStatus.APPROVED,
      }),
    ).rejects.toThrow(
      'El elemento necesita un nombre en español antes de aprobarse',
    );
  });

  it('permite a la capa de servicio aprobar un item coherente', async () => {
    itemFindUnique.mockResolvedValue({
      id: itemId,
      type: CommercialItemType.DISH,
      nameEs: 'Trucha',
      basePrice: new Prisma.Decimal('39.90'),
      category: { isActive: true },
      variants: [],
    });
    itemUpdate.mockResolvedValue(
      makeRecord({ approvalStatus: CommercialApprovalStatus.APPROVED }),
    );

    const result = await service.updateApproval(itemId, {
      approvalStatus: CommercialApprovalStatus.APPROVED,
    });

    expect(result.approvalStatus).toBe(CommercialApprovalStatus.APPROVED);
  });

  it('la consulta para el asistente filtra item/categoría y variantes activas', async () => {
    await service.findAvailableForAssistant({
      type: CommercialItemType.DISH,
      search: 'trucha',
      limit: 500,
    });

    expect(itemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          approvalStatus: CommercialApprovalStatus.APPROVED,
          category: { isActive: true },
          type: CommercialItemType.DISH,
        }),
        select: expect.objectContaining({
          internalNotes: false,
          variants: expect.objectContaining({ where: { isActive: true } }),
        }),
        take: 100,
      }),
    );
  });

  it('reintenta una transacción ante P2034', async () => {
    transaction.mockRejectedValueOnce({ code: 'P2034' });

    await expect(
      service.create({
        type: CommercialItemType.DISH,
        categoryId,
        nameEs: 'Trucha',
        basePrice: '39.90',
      }),
    ).resolves.toBeDefined();

    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
