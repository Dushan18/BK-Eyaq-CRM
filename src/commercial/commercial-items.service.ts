import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client';
import {
  CommercialApprovalStatus,
  CommercialItemType,
} from '../../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import {
  CommercialItemQueryDto,
  CreateCommercialItemDto,
  UpdateCommercialItemApprovalDto,
  UpdateCommercialItemDto,
  UpdateCommercialItemStatusDto,
} from '../dto/commercial-item.dto';
import {
  CommercialEventDetailDto,
  CommercialItemFaqDto,
  CommercialItemImageDto,
  CommercialItemScheduleDto,
  CommercialItemVariantDto,
  CommercialPromotionDetailDto,
  isCommercialScheduleTimeCoherent,
} from '../dto/commercial-item-resource.dto';
import {
  normalizeCommercialName,
  normalizeOptionalString,
  requireLocalizedName,
  serializeMoney,
} from './commercial.utils';

const commercialItemSelect = {
  id: true,
  type: true,
  categoryId: true,
  nameEs: true,
  nameEn: true,
  descriptionEs: true,
  descriptionEn: true,
  basePrice: true,
  displayOrder: true,
  isActive: true,
  approvalStatus: true,
  conditions: true,
  internalNotes: true,
  availabilityNote: true,
  createdAt: true,
  updatedAt: true,
  category: {
    select: {
      id: true,
      nameEs: true,
      nameEn: true,
      isActive: true,
      displayOrder: true,
    },
  },
  variants: {
    select: {
      id: true,
      nameEs: true,
      nameEn: true,
      descriptionEs: true,
      descriptionEn: true,
      price: true,
      isActive: true,
      displayOrder: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  },
  images: {
    select: {
      id: true,
      url: true,
      altTextEs: true,
      altTextEn: true,
      isPrimary: true,
      displayOrder: true,
      createdAt: true,
    },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  },
  faqs: {
    select: {
      id: true,
      questionEs: true,
      questionEn: true,
      answerEs: true,
      answerEn: true,
      displayOrder: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  },
  schedules: {
    select: {
      id: true,
      dayOfWeek: true,
      isAvailable: true,
      startTime: true,
      endTime: true,
    },
    orderBy: { dayOfWeek: 'asc' },
  },
  promotionDetail: {
    select: {
      id: true,
      validFrom: true,
      validUntil: true,
      promotionalPrice: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  eventDetail: {
    select: {
      id: true,
      startAt: true,
      endAt: true,
      capacity: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.CommercialItemSelect;

const assistantCommercialItemSelect = {
  ...commercialItemSelect,
  internalNotes: false,
  variants: {
    ...commercialItemSelect.variants,
    where: { isActive: true },
  },
} satisfies Prisma.CommercialItemSelect;

type CommercialItemRecord = Prisma.CommercialItemGetPayload<{
  select: typeof commercialItemSelect;
}>;

type AssistantCommercialItemRecord = Prisma.CommercialItemGetPayload<{
  select: typeof assistantCommercialItemSelect;
}>;

export interface AssistantCommercialItemsQuery {
  search?: string;
  type?: CommercialItemType;
  categoryId?: string;
  limit?: number;
}

const MAX_TRANSACTION_ATTEMPTS = 3;

@Injectable()
export class CommercialItemsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCommercialItemDto) {
    const prepared = this.prepareCreate(dto);

    const item = await this.runSerializableTransaction(async (tx) => {
      await this.ensureActiveCategory(tx, dto.categoryId);

      return tx.commercialItem.create({
        data: {
          type: dto.type,
          category: { connect: { id: dto.categoryId } },
          nameEs: prepared.names.nameEs,
          nameEn: prepared.names.nameEn,
          normalizedName: prepared.normalizedName,
          descriptionEs: normalizeOptionalString(dto.descriptionEs),
          descriptionEn: normalizeOptionalString(dto.descriptionEn),
          basePrice: dto.basePrice ?? null,
          displayOrder: dto.displayOrder ?? 0,
          conditions: normalizeOptionalString(dto.conditions),
          internalNotes: normalizeOptionalString(dto.internalNotes),
          availabilityNote: normalizeOptionalString(dto.availabilityNote),
          ...(prepared.variants.length > 0
            ? { variants: { create: prepared.variants } }
            : {}),
          ...(prepared.images.length > 0
            ? { images: { create: prepared.images } }
            : {}),
          ...(prepared.faqs.length > 0
            ? { faqs: { create: prepared.faqs } }
            : {}),
          ...(prepared.schedules.length > 0
            ? { schedules: { create: prepared.schedules } }
            : {}),
          ...(prepared.promotionDetail
            ? { promotionDetail: { create: prepared.promotionDetail } }
            : {}),
          ...(prepared.eventDetail
            ? { eventDetail: { create: prepared.eventDetail } }
            : {}),
        },
        select: commercialItemSelect,
      });
    });

    // TODO: integrar auditoría de COMMERCIAL_ITEM_CREATED.
    return this.serializeItem(item);
  }

  async findAll(query: CommercialItemQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.buildWhere(query);
    const orderBy = this.buildOrderBy(query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.commercialItem.findMany({
        where,
        select: commercialItemSelect,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.commercialItem.count({ where }),
    ]);

    return {
      data: items.map((item) => this.serializeItem(item)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const item = await this.prisma.commercialItem.findUnique({
      where: { id },
      select: commercialItemSelect,
    });

    if (!item) {
      throw new NotFoundException('Elemento comercial no encontrado');
    }

    return this.serializeItem(item);
  }

  async update(id: string, dto: UpdateCommercialItemDto) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException(
        'Debes proporcionar al menos un campo para actualizar',
      );
    }

    const item = await this.runSerializableTransaction(async (tx) => {
      const current = await tx.commercialItem.findUnique({
        where: { id },
        select: {
          id: true,
          type: true,
          nameEs: true,
          nameEn: true,
          basePrice: true,
          approvalStatus: true,
          variants: { select: { isActive: true } },
        },
      });

      if (!current) {
        throw new NotFoundException('Elemento comercial no encontrado');
      }

      if (dto.categoryId !== undefined) {
        await this.ensureActiveCategory(tx, dto.categoryId);
      }

      const names = requireLocalizedName(
        {
          nameEs: dto.nameEs !== undefined ? dto.nameEs : current.nameEs,
          nameEn: dto.nameEn !== undefined ? dto.nameEn : current.nameEn,
        },
        'El elemento comercial',
      );
      const preparedVariants =
        dto.variants === undefined
          ? undefined
          : this.prepareVariants(dto.variants);
      const activeVariantCount =
        preparedVariants?.filter((variant) => variant.isActive).length ??
        current.variants.filter((variant) => variant.isActive).length;
      const resultingBasePrice =
        dto.basePrice !== undefined ? dto.basePrice : current.basePrice;

      this.validatePriceRule(
        current.type,
        resultingBasePrice,
        activeVariantCount,
      );
      this.validateDetailType(
        current.type,
        dto.promotionDetail,
        dto.eventDetail,
      );

      const preparedImages =
        dto.images === undefined ? undefined : this.prepareImages(dto.images);
      const preparedFaqs =
        dto.faqs === undefined ? undefined : this.prepareFaqs(dto.faqs);
      const preparedSchedules =
        dto.schedules === undefined
          ? undefined
          : this.prepareSchedules(dto.schedules);
      const preparedPromotion =
        dto.promotionDetail === undefined
          ? undefined
          : dto.promotionDetail === null
            ? null
            : this.preparePromotionDetail(dto.promotionDetail);
      const preparedEvent =
        dto.eventDetail === undefined
          ? undefined
          : dto.eventDetail === null
            ? null
            : this.prepareEventDetail(dto.eventDetail);

      const data: Prisma.CommercialItemUpdateInput = {
        approvalStatus:
          current.approvalStatus === CommercialApprovalStatus.APPROVED
            ? CommercialApprovalStatus.DRAFT
            : current.approvalStatus,
      };

      if (dto.categoryId !== undefined) {
        data.category = { connect: { id: dto.categoryId } };
      }

      if (dto.nameEs !== undefined || dto.nameEn !== undefined) {
        data.nameEs = names.nameEs;
        data.nameEn = names.nameEn;
        data.normalizedName = normalizeCommercialName(
          names.nameEs ?? names.nameEn!,
        );
      }

      this.assignOptionalScalarFields(data, dto);

      await tx.commercialItem.update({ where: { id }, data });

      if (preparedVariants !== undefined) {
        await tx.commercialItemVariant.deleteMany({
          where: { commercialItemId: id },
        });
        if (preparedVariants.length > 0) {
          await tx.commercialItemVariant.createMany({
            data: preparedVariants.map((variant) => ({
              commercialItemId: id,
              ...variant,
            })),
          });
        }
      }

      if (preparedImages !== undefined) {
        await tx.commercialItemImage.deleteMany({
          where: { commercialItemId: id },
        });
        if (preparedImages.length > 0) {
          await tx.commercialItemImage.createMany({
            data: preparedImages.map((image) => ({
              commercialItemId: id,
              ...image,
            })),
          });
        }
      }

      if (preparedFaqs !== undefined) {
        await tx.commercialItemFaq.deleteMany({
          where: { commercialItemId: id },
        });
        if (preparedFaqs.length > 0) {
          await tx.commercialItemFaq.createMany({
            data: preparedFaqs.map((faq) => ({
              commercialItemId: id,
              ...faq,
            })),
          });
        }
      }

      if (preparedSchedules !== undefined) {
        await tx.commercialItemSchedule.deleteMany({
          where: { commercialItemId: id },
        });
        if (preparedSchedules.length > 0) {
          await tx.commercialItemSchedule.createMany({
            data: preparedSchedules.map((schedule) => ({
              commercialItemId: id,
              ...schedule,
            })),
          });
        }
      }

      await this.replacePromotionDetail(tx, id, preparedPromotion);
      await this.replaceEventDetail(tx, id, preparedEvent);

      return tx.commercialItem.findUniqueOrThrow({
        where: { id },
        select: commercialItemSelect,
      });
    });

    // Los cambios de contenido requieren una nueva aprobación.
    // TODO: integrar auditoría de COMMERCIAL_ITEM_UPDATED.
    return this.serializeItem(item);
  }

  async updateStatus(id: string, dto: UpdateCommercialItemStatusDto) {
    const current = await this.prisma.commercialItem.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!current) {
      throw new NotFoundException('Elemento comercial no encontrado');
    }

    const item = await this.prisma.commercialItem.update({
      where: { id },
      data: { isActive: dto.isActive },
      select: commercialItemSelect,
    });

    // TODO: integrar auditoría de COMMERCIAL_ITEM_STATUS_UPDATED.
    return this.serializeItem(item);
  }

  async updateApproval(id: string, dto: UpdateCommercialItemApprovalDto) {
    const item = await this.runSerializableTransaction(async (tx) => {
      const current = await tx.commercialItem.findUnique({
        where: { id },
        select: {
          id: true,
          type: true,
          nameEs: true,
          basePrice: true,
          category: { select: { isActive: true } },
          variants: { select: { isActive: true } },
        },
      });

      if (!current) {
        throw new NotFoundException('Elemento comercial no encontrado');
      }

      if (dto.approvalStatus === CommercialApprovalStatus.APPROVED) {
        if (!normalizeOptionalString(current.nameEs)) {
          throw new BadRequestException(
            'El elemento necesita un nombre en español antes de aprobarse',
          );
        }

        if (!current.category.isActive) {
          throw new BadRequestException(
            'No se puede aprobar un elemento de una categoría inactiva',
          );
        }

        this.validatePriceRule(
          current.type,
          current.basePrice,
          current.variants.filter((variant) => variant.isActive).length,
        );
      }

      return tx.commercialItem.update({
        where: { id },
        data: { approvalStatus: dto.approvalStatus },
        select: commercialItemSelect,
      });
    });

    // TODO: integrar auditoría de COMMERCIAL_ITEM_APPROVAL_UPDATED.
    return this.serializeItem(item);
  }

  async findAvailableForAssistant(query: AssistantCommercialItemsQuery = {}) {
    const search = normalizeOptionalString(query.search);
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 100);
    const where: Prisma.CommercialItemWhereInput = {
      isActive: true,
      approvalStatus: CommercialApprovalStatus.APPROVED,
      category: { isActive: true },
      ...(query.type ? { type: query.type } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(search ? { OR: this.buildSearchFilters(search) } : {}),
    };

    const items = await this.prisma.commercialItem.findMany({
      where,
      select: assistantCommercialItemSelect,
      orderBy: this.defaultOrderBy('asc'),
      take: limit,
    });

    return items.map((item) => this.serializeItem(item));
  }

  private prepareCreate(dto: CreateCommercialItemDto) {
    const names = requireLocalizedName(dto, 'El elemento comercial');
    const variants = this.prepareVariants(dto.variants ?? []);
    const images = this.prepareImages(dto.images ?? []);
    const faqs = this.prepareFaqs(dto.faqs ?? []);
    const schedules = this.prepareSchedules(dto.schedules ?? []);
    const promotionDetail = dto.promotionDetail
      ? this.preparePromotionDetail(dto.promotionDetail)
      : null;
    const eventDetail = dto.eventDetail
      ? this.prepareEventDetail(dto.eventDetail)
      : null;

    this.validatePriceRule(
      dto.type,
      dto.basePrice,
      variants.filter((variant) => variant.isActive).length,
    );
    this.validateDetailType(dto.type, dto.promotionDetail, dto.eventDetail);

    return {
      names,
      normalizedName: normalizeCommercialName(names.nameEs ?? names.nameEn!),
      variants,
      images,
      faqs,
      schedules,
      promotionDetail,
      eventDetail,
    };
  }

  private prepareVariants(variants: CommercialItemVariantDto[]) {
    const normalizedNames = new Set<string>();

    return variants.map((variant, index) => {
      const names = requireLocalizedName(variant, 'Cada variante');
      const normalizedName = normalizeCommercialName(
        names.nameEs ?? names.nameEn!,
      );

      if (normalizedNames.has(normalizedName)) {
        throw new BadRequestException('Las variantes no pueden duplicarse');
      }
      normalizedNames.add(normalizedName);

      return {
        ...names,
        normalizedName,
        descriptionEs: normalizeOptionalString(variant.descriptionEs),
        descriptionEn: normalizeOptionalString(variant.descriptionEn),
        price: variant.price,
        isActive: variant.isActive ?? true,
        displayOrder: variant.displayOrder ?? index,
      };
    });
  }

  private prepareImages(images: CommercialItemImageDto[]) {
    const urls = new Set<string>();
    let primaryCount = 0;

    const prepared = images.map((image, index) => {
      const url = image.url.trim();

      if (urls.has(url)) {
        throw new BadRequestException('Las imágenes no pueden duplicarse');
      }
      urls.add(url);

      if (image.isPrimary === true) {
        primaryCount += 1;
      }

      return {
        url,
        altTextEs: normalizeOptionalString(image.altTextEs),
        altTextEn: normalizeOptionalString(image.altTextEn),
        isPrimary: image.isPrimary ?? false,
        displayOrder: image.displayOrder ?? index,
      };
    });

    if (primaryCount > 1) {
      throw new BadRequestException(
        'Un elemento comercial solo puede tener una imagen principal',
      );
    }

    return prepared;
  }

  private prepareFaqs(faqs: CommercialItemFaqDto[]) {
    return faqs.map((faq, index) => ({
      questionEs: faq.questionEs.trim(),
      questionEn: normalizeOptionalString(faq.questionEn),
      answerEs: faq.answerEs.trim(),
      answerEn: normalizeOptionalString(faq.answerEn),
      displayOrder: faq.displayOrder ?? index,
    }));
  }

  private prepareSchedules(schedules: CommercialItemScheduleDto[]) {
    const days = new Set(schedules.map((schedule) => schedule.dayOfWeek));

    if (days.size !== schedules.length) {
      throw new BadRequestException(
        'No puede repetirse un día en los horarios del elemento',
      );
    }

    if (
      schedules.some((schedule) => !isCommercialScheduleTimeCoherent(schedule))
    ) {
      throw new BadRequestException(
        'Los horarios comerciales son incoherentes',
      );
    }

    return schedules.map((schedule) => ({
      dayOfWeek: schedule.dayOfWeek,
      isAvailable: schedule.isAvailable,
      startTime: schedule.isAvailable ? schedule.startTime! : null,
      endTime: schedule.isAvailable ? schedule.endTime! : null,
    }));
  }

  private preparePromotionDetail(detail: CommercialPromotionDetailDto) {
    const validFrom = this.parseOptionalDate(detail.validFrom, 'validFrom');
    const validUntil = this.parseOptionalDate(detail.validUntil, 'validUntil');

    if (validFrom && validUntil && validFrom > validUntil) {
      throw new BadRequestException(
        'validFrom no puede ser posterior a validUntil',
      );
    }

    return {
      validFrom,
      validUntil,
      promotionalPrice: detail.promotionalPrice ?? null,
    };
  }

  private prepareEventDetail(detail: CommercialEventDetailDto) {
    const startAt = this.parseOptionalDate(detail.startAt, 'startAt');
    const endAt = this.parseOptionalDate(detail.endAt, 'endAt');

    if (startAt && endAt && startAt > endAt) {
      throw new BadRequestException('startAt no puede ser posterior a endAt');
    }

    return {
      startAt,
      endAt,
      capacity: detail.capacity ?? null,
    };
  }

  private parseOptionalDate(
    value: string | null | undefined,
    field: string,
  ): Date | null {
    if (value == null) {
      return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} debe ser una fecha válida`);
    }

    return date;
  }

  private validatePriceRule(
    type: CommercialItemType,
    basePrice: unknown,
    activeVariantCount: number,
  ): void {
    if (
      type !== CommercialItemType.DISH &&
      type !== CommercialItemType.BEVERAGE
    ) {
      return;
    }

    const hasBasePrice = basePrice !== null && basePrice !== undefined;
    const hasActiveVariants = activeVariantCount > 0;

    if (hasBasePrice === hasActiveVariants) {
      throw new BadRequestException(
        'Un plato o bebida debe tener un precio base o variantes activas, pero no ambos',
      );
    }
  }

  private validateDetailType(
    type: CommercialItemType,
    promotionDetail?: CommercialPromotionDetailDto | null,
    eventDetail?: CommercialEventDetailDto | null,
  ): void {
    if (promotionDetail && type !== CommercialItemType.PROMOTION) {
      throw new BadRequestException(
        'promotionDetail solo corresponde a elementos PROMOTION',
      );
    }

    if (eventDetail && type !== CommercialItemType.EVENT) {
      throw new BadRequestException(
        'eventDetail solo corresponde a elementos EVENT',
      );
    }
  }

  private assignOptionalScalarFields(
    data: Prisma.CommercialItemUpdateInput,
    dto: UpdateCommercialItemDto,
  ): void {
    if (dto.descriptionEs !== undefined) {
      data.descriptionEs = normalizeOptionalString(dto.descriptionEs);
    }
    if (dto.descriptionEn !== undefined) {
      data.descriptionEn = normalizeOptionalString(dto.descriptionEn);
    }
    if (dto.basePrice !== undefined) {
      data.basePrice = dto.basePrice;
    }
    if (dto.displayOrder !== undefined) {
      data.displayOrder = dto.displayOrder;
    }
    if (dto.conditions !== undefined) {
      data.conditions = normalizeOptionalString(dto.conditions);
    }
    if (dto.internalNotes !== undefined) {
      data.internalNotes = normalizeOptionalString(dto.internalNotes);
    }
    if (dto.availabilityNote !== undefined) {
      data.availabilityNote = normalizeOptionalString(dto.availabilityNote);
    }
  }

  private async replacePromotionDetail(
    tx: Prisma.TransactionClient,
    commercialItemId: string,
    detail:
      | ReturnType<CommercialItemsService['preparePromotionDetail']>
      | null
      | undefined,
  ): Promise<void> {
    if (detail === undefined) {
      return;
    }

    if (detail === null) {
      await tx.promotionDetail.deleteMany({ where: { commercialItemId } });
      return;
    }

    await tx.promotionDetail.upsert({
      where: { commercialItemId },
      create: { commercialItemId, ...detail },
      update: detail,
    });
  }

  private async replaceEventDetail(
    tx: Prisma.TransactionClient,
    commercialItemId: string,
    detail:
      | ReturnType<CommercialItemsService['prepareEventDetail']>
      | null
      | undefined,
  ): Promise<void> {
    if (detail === undefined) {
      return;
    }

    if (detail === null) {
      await tx.eventDetail.deleteMany({ where: { commercialItemId } });
      return;
    }

    await tx.eventDetail.upsert({
      where: { commercialItemId },
      create: { commercialItemId, ...detail },
      update: detail,
    });
  }

  private async ensureActiveCategory(
    tx: Prisma.TransactionClient,
    categoryId: string,
  ): Promise<void> {
    const category = await tx.commercialCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true },
    });

    if (!category) {
      throw new BadRequestException('La categoría comercial no existe');
    }

    if (!category.isActive) {
      throw new BadRequestException('La categoría comercial está inactiva');
    }
  }

  private buildWhere(
    query: CommercialItemQueryDto,
  ): Prisma.CommercialItemWhereInput {
    const search = normalizeOptionalString(query.search);

    return {
      ...(query.type ? { type: query.type } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.approvalStatus ? { approvalStatus: query.approvalStatus } : {}),
      ...(search ? { OR: this.buildSearchFilters(search) } : {}),
    };
  }

  private buildSearchFilters(
    search: string,
  ): Prisma.CommercialItemWhereInput[] {
    return [
      { nameEs: { contains: search, mode: 'insensitive' } },
      { nameEn: { contains: search, mode: 'insensitive' } },
      { descriptionEs: { contains: search, mode: 'insensitive' } },
      { descriptionEn: { contains: search, mode: 'insensitive' } },
    ];
  }

  private buildOrderBy(
    query: CommercialItemQueryDto,
  ): Prisma.CommercialItemOrderByWithRelationInput[] {
    const order = query.order ?? 'desc';

    if (query.sort === 'name') {
      return [
        { nameEs: { sort: order, nulls: 'last' } },
        { nameEn: { sort: order, nulls: 'last' } },
        { createdAt: 'desc' },
      ];
    }

    if (query.sort === 'category') {
      return this.defaultOrderBy(order);
    }

    return [{ createdAt: order }, { id: 'asc' }];
  }

  private defaultOrderBy(
    order: 'asc' | 'desc',
  ): Prisma.CommercialItemOrderByWithRelationInput[] {
    return [
      { category: { displayOrder: order } },
      { displayOrder: order },
      { nameEs: { sort: order, nulls: 'last' } },
      { nameEn: { sort: order, nulls: 'last' } },
    ];
  }

  private serializeItem(
    item: CommercialItemRecord | AssistantCommercialItemRecord,
  ) {
    const { basePrice, variants, promotionDetail, ...data } = item;

    return {
      ...data,
      basePrice: serializeMoney(basePrice),
      variants: variants.map((variant) => ({
        ...variant,
        price: serializeMoney(variant.price),
      })),
      promotionDetail: promotionDetail
        ? {
            ...promotionDetail,
            promotionalPrice: serializeMoney(promotionDetail.promotionalPrice),
          }
        : null,
    };
  }

  private async runSerializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: 'Serializable',
        });
      } catch (error: unknown) {
        if (
          this.hasPrismaCode(error, 'P2034') &&
          attempt < MAX_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }

        this.throwForKnownPrismaError(error);
        throw error;
      }
    }

    throw new ConflictException(
      'La operación comercial entró en conflicto; inténtalo nuevamente',
    );
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
    if (this.hasPrismaCode(error, 'P2034')) {
      throw new ConflictException(
        'La operación comercial entró en conflicto; inténtalo nuevamente',
      );
    }

    if (this.hasPrismaCode(error, 'P2002')) {
      throw new ConflictException(
        'La operación contiene datos comerciales duplicados',
      );
    }

    if (
      this.hasPrismaCode(error, 'P2003') ||
      this.hasPrismaCode(error, 'P2004')
    ) {
      throw new BadRequestException(
        'La operación contiene referencias o valores comerciales inválidos',
      );
    }

    if (this.hasPrismaCode(error, 'P2025')) {
      throw new NotFoundException('Elemento comercial no encontrado');
    }
  }
}
