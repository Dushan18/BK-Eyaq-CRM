/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import type { PrismaService } from '../database/prisma.service';
import { CommercialCategoriesService } from './commercial-categories.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('CommercialCategoriesService', () => {
  const category = {
    id: '11111111-1111-4111-8111-111111111111',
    nameEs: 'Entradas',
    nameEn: 'Starters',
    descriptionEs: null,
    descriptionEn: null,
    isActive: true,
    displayOrder: 0,
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    updatedAt: new Date('2026-09-14T00:00:00.000Z'),
  };

  const findFirst = jest.fn();
  const findUnique = jest.fn();
  const findMany = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const prisma = {
    commercialCategory: {
      findFirst,
      findUnique,
      findMany,
      create,
      update,
    },
  } as unknown as PrismaService;
  const service = new CommercialCategoriesService(prisma);

  beforeEach(() => {
    jest.resetAllMocks();
    findFirst.mockResolvedValue(null);
    findUnique.mockResolvedValue(category);
    findMany.mockResolvedValue([category]);
    create.mockResolvedValue(category);
    update.mockResolvedValue(category);
  });

  it('crea una categoría y normaliza sus nombres', async () => {
    await expect(
      service.create({
        nameEs: '  Entrádas  ',
        nameEn: ' Starters ',
      }),
    ).resolves.toEqual(category);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nameEs: 'Entrádas',
          nameEn: 'Starters',
          normalizedNameEs: 'entradas',
          normalizedNameEn: 'starters',
        }),
      }),
    );
  });

  it('rechaza una categoría sin ningún nombre', async () => {
    await expect(service.create({})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('rechaza nombres normalizados duplicados', async () => {
    findFirst.mockResolvedValue({ id: 'existing-id' });

    await expect(service.create({ nameEs: 'Entradas' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('lista categorías con un orden estable', async () => {
    await expect(service.findAll()).resolves.toEqual([category]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: expect.any(Array),
      }),
    );
  });

  it('devuelve 404 cuando la categoría no existe', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.findOne(category.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('actualiza parcialmente y permite limpiar una descripción', async () => {
    await service.update(category.id, {
      nameEn: ' Appetizers ',
      descriptionEs: null,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nameEs: 'Entradas',
          nameEn: 'Appetizers',
          normalizedNameEs: 'entradas',
          normalizedNameEn: 'appetizers',
          descriptionEs: null,
        }),
      }),
    );
  });

  it('rechaza un PATCH vacío', async () => {
    await expect(service.update(category.id, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('desactiva la categoría sin borrar sus items', async () => {
    await service.updateStatus(category.id, { isActive: false });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: category.id },
        data: { isActive: false },
      }),
    );
  });

  it('convierte P2002 en ConflictException', async () => {
    create.mockRejectedValue({ code: 'P2002' });

    await expect(service.create({ nameEs: 'Nueva' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
