import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  CreateCommercialCategoryDto,
  UpdateCommercialCategoryDto,
  UpdateCommercialCategoryStatusDto,
} from '../dto/commercial-category.dto';
import {
  normalizeCommercialName,
  normalizeOptionalString,
  requireLocalizedName,
} from './commercial.utils';

const commercialCategorySelect = {
  id: true,
  nameEs: true,
  nameEn: true,
  descriptionEs: true,
  descriptionEn: true,
  isActive: true,
  displayOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CommercialCategorySelect;

@Injectable()
export class CommercialCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCommercialCategoryDto) {
    const names = requireLocalizedName(dto, 'La categoría');
    const normalizedNames = this.getNormalizedNames(names);

    await this.ensureNamesAvailable(normalizedNames);

    try {
      const category = await this.prisma.commercialCategory.create({
        data: {
          ...names,
          ...normalizedNames,
          descriptionEs: normalizeOptionalString(dto.descriptionEs),
          descriptionEn: normalizeOptionalString(dto.descriptionEn),
          displayOrder: dto.displayOrder ?? 0,
        },
        select: commercialCategorySelect,
      });

      // TODO: integrar auditoría de COMMERCIAL_CATEGORY_CREATED.
      return category;
    } catch (error: unknown) {
      this.throwForKnownPrismaError(error);
      throw error;
    }
  }

  async findAll() {
    return this.prisma.commercialCategory.findMany({
      select: commercialCategorySelect,
      orderBy: [
        { displayOrder: 'asc' },
        { nameEs: { sort: 'asc', nulls: 'last' } },
        { nameEn: { sort: 'asc', nulls: 'last' } },
      ],
    });
  }

  async findOne(id: string) {
    const category = await this.prisma.commercialCategory.findUnique({
      where: { id },
      select: commercialCategorySelect,
    });

    if (!category) {
      throw new NotFoundException('Categoría comercial no encontrada');
    }

    return category;
  }

  async update(id: string, dto: UpdateCommercialCategoryDto) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException(
        'Debes proporcionar al menos un campo para actualizar',
      );
    }

    const existing = await this.prisma.commercialCategory.findUnique({
      where: { id },
      select: {
        id: true,
        nameEs: true,
        nameEn: true,
      },
    });

    if (!existing) {
      throw new NotFoundException('Categoría comercial no encontrada');
    }

    const names = requireLocalizedName(
      {
        nameEs: dto.nameEs !== undefined ? dto.nameEs : existing.nameEs,
        nameEn: dto.nameEn !== undefined ? dto.nameEn : existing.nameEn,
      },
      'La categoría',
    );
    const normalizedNames = this.getNormalizedNames(names);

    await this.ensureNamesAvailable(normalizedNames, id);

    const data: Prisma.CommercialCategoryUpdateInput = {};

    if (dto.nameEs !== undefined || dto.nameEn !== undefined) {
      Object.assign(data, names, normalizedNames);
    }

    if (dto.descriptionEs !== undefined) {
      data.descriptionEs = normalizeOptionalString(dto.descriptionEs);
    }

    if (dto.descriptionEn !== undefined) {
      data.descriptionEn = normalizeOptionalString(dto.descriptionEn);
    }

    if (dto.displayOrder !== undefined) {
      data.displayOrder = dto.displayOrder;
    }

    try {
      const category = await this.prisma.commercialCategory.update({
        where: { id },
        data,
        select: commercialCategorySelect,
      });

      // TODO: integrar auditoría de COMMERCIAL_CATEGORY_UPDATED.
      return category;
    } catch (error: unknown) {
      this.throwForKnownPrismaError(error);
      throw error;
    }
  }

  async updateStatus(id: string, dto: UpdateCommercialCategoryStatusDto) {
    await this.ensureExists(id);

    const category = await this.prisma.commercialCategory.update({
      where: { id },
      data: { isActive: dto.isActive },
      select: commercialCategorySelect,
    });

    // Los items se conservan; la consulta para el asistente excluye categorías inactivas.
    // TODO: integrar auditoría de COMMERCIAL_CATEGORY_STATUS_UPDATED.
    return category;
  }

  private async ensureExists(id: string): Promise<void> {
    const category = await this.prisma.commercialCategory.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!category) {
      throw new NotFoundException('Categoría comercial no encontrada');
    }
  }

  private getNormalizedNames(names: {
    nameEs: string | null;
    nameEn: string | null;
  }): { normalizedNameEs: string | null; normalizedNameEn: string | null } {
    return {
      normalizedNameEs: names.nameEs
        ? normalizeCommercialName(names.nameEs)
        : null,
      normalizedNameEn: names.nameEn
        ? normalizeCommercialName(names.nameEn)
        : null,
    };
  }

  private async ensureNamesAvailable(
    names: { normalizedNameEs: string | null; normalizedNameEn: string | null },
    excludedId?: string,
  ): Promise<void> {
    const values = [names.normalizedNameEs, names.normalizedNameEn].filter(
      (value): value is string => value !== null,
    );
    const nameFilters: Prisma.CommercialCategoryWhereInput[] = values.flatMap(
      (value) => [{ normalizedNameEs: value }, { normalizedNameEn: value }],
    );

    const duplicate = await this.prisma.commercialCategory.findFirst({
      where: {
        ...(excludedId ? { id: { not: excludedId } } : {}),
        OR: nameFilters,
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictException(
        'Ya existe una categoría comercial con ese nombre',
      );
    }
  }

  private hasPrismaCode(error: unknown, code: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === code
    );
  }

  private throwForKnownPrismaError(error: unknown): void {
    if (this.hasPrismaCode(error, 'P2002')) {
      throw new ConflictException(
        'Ya existe una categoría comercial con ese nombre',
      );
    }

    if (this.hasPrismaCode(error, 'P2004')) {
      throw new BadRequestException('Los datos de la categoría son inválidos');
    }
  }
}
