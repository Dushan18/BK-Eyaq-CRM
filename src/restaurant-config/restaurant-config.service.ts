import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client';
import {
  DayOfWeek,
  LanguageCode,
  RestaurantConfigScope,
  RoleCode,
} from '../../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import { PutRestaurantConfigDto } from '../dto/put-restaurant-config.dto';
import { isScheduleTimeCoherent } from '../dto/restaurant-schedule.dto';

const restaurantConfigSelect = {
  id: true,
  businessName: true,
  logoUrl: true,
  description: true,
  address: true,
  latitude: true,
  longitude: true,
  whatsappNumber: true,
  email: true,
  website: true,
  currency: true,
  timeZone: true,
  reservationPolicy: true,
  cancellationPolicy: true,
  responseTimeoutMinutes: true,
  approvalResponsibleId: true,
  createdAt: true,
  updatedAt: true,
  approvalResponsible: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  languages: {
    select: {
      language: true,
    },
  },
  schedules: {
    select: {
      dayOfWeek: true,
      isOpen: true,
      openTime: true,
      closeTime: true,
    },
  },
} satisfies Prisma.RestaurantConfigSelect;

type RestaurantConfigRecord = Prisma.RestaurantConfigGetPayload<{
  select: typeof restaurantConfigSelect;
}>;

const dayOrder: Record<DayOfWeek, number> = {
  [DayOfWeek.MONDAY]: 0,
  [DayOfWeek.TUESDAY]: 1,
  [DayOfWeek.WEDNESDAY]: 2,
  [DayOfWeek.THURSDAY]: 3,
  [DayOfWeek.FRIDAY]: 4,
  [DayOfWeek.SATURDAY]: 5,
  [DayOfWeek.SUNDAY]: 6,
};

const languageOrder: Record<LanguageCode, number> = {
  [LanguageCode.ES]: 0,
  [LanguageCode.EN]: 1,
  [LanguageCode.PT]: 2,
};

const MAX_TRANSACTION_ATTEMPTS = 3;

@Injectable()
export class RestaurantConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne() {
    const config = await this.prisma.restaurantConfig.findUnique({
      where: {
        scope: RestaurantConfigScope.GLOBAL,
      },
      select: restaurantConfigSelect,
    });

    if (!config) {
      throw new NotFoundException(
        'Configuración del restaurante no encontrada',
      );
    }

    return this.serialize(config);
  }

  async upsert(dto: PutRestaurantConfigDto) {
    this.validateConsistency(dto);

    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        const config = await this.prisma.$transaction(
          async (tx) => this.upsertInTransaction(tx, dto),
          {
            isolationLevel: 'Serializable',
          },
        );

        // TODO: integrar auditoría de RESTAURANT_CONFIG_CREATED/UPDATED.
        return this.serialize(config);
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
      'La configuración entró en conflicto con otro cambio; inténtalo nuevamente',
    );
  }

  private async upsertInTransaction(
    tx: Prisma.TransactionClient,
    dto: PutRestaurantConfigDto,
  ): Promise<RestaurantConfigRecord> {
    await this.validateApprovalResponsible(tx, dto.approvalResponsibleId);

    const scalarData = {
      businessName: dto.businessName.trim(),
      logoUrl: this.normalizeOptionalString(dto.logoUrl),
      description: this.normalizeOptionalString(dto.description),
      address: dto.address.trim(),
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
      whatsappNumber: dto.whatsappNumber.trim(),
      email: dto.email.trim().toLowerCase(),
      website: this.normalizeOptionalString(dto.website),
      currency: dto.currency,
      timeZone: dto.timeZone.trim(),
      reservationPolicy: dto.reservationPolicy.trim(),
      cancellationPolicy: dto.cancellationPolicy.trim(),
      responseTimeoutMinutes: dto.responseTimeoutMinutes,
    };

    const responsibleId = dto.approvalResponsibleId ?? null;

    const config = await tx.restaurantConfig.upsert({
      where: {
        scope: RestaurantConfigScope.GLOBAL,
      },
      create: {
        ...scalarData,
        scope: RestaurantConfigScope.GLOBAL,
        ...(responsibleId
          ? {
              approvalResponsible: {
                connect: {
                  id: responsibleId,
                },
              },
            }
          : {}),
      },
      update: {
        ...scalarData,
        approvalResponsible: responsibleId
          ? {
              connect: {
                id: responsibleId,
              },
            }
          : {
              disconnect: true,
            },
      },
      select: {
        id: true,
      },
    });

    await tx.restaurantSchedule.deleteMany({
      where: {
        restaurantConfigId: config.id,
      },
    });

    await tx.restaurantSchedule.createMany({
      data: dto.schedules.map((schedule) => ({
        restaurantConfigId: config.id,
        dayOfWeek: schedule.dayOfWeek,
        isOpen: schedule.isOpen,
        openTime: schedule.isOpen ? schedule.openTime! : null,
        closeTime: schedule.isOpen ? schedule.closeTime! : null,
      })),
    });

    await tx.restaurantLanguage.deleteMany({
      where: {
        restaurantConfigId: config.id,
      },
    });

    await tx.restaurantLanguage.createMany({
      data: dto.languages.map((language) => ({
        restaurantConfigId: config.id,
        language,
      })),
    });

    return tx.restaurantConfig.findUniqueOrThrow({
      where: {
        scope: RestaurantConfigScope.GLOBAL,
      },
      select: restaurantConfigSelect,
    });
  }

  private async validateApprovalResponsible(
    tx: Prisma.TransactionClient,
    approvalResponsibleId?: string | null,
  ): Promise<void> {
    if (!approvalResponsibleId) {
      return;
    }

    const responsible = await tx.user.findUnique({
      where: {
        id: approvalResponsibleId,
      },
      select: {
        id: true,
        isActive: true,
        roles: {
          select: {
            role: {
              select: {
                code: true,
              },
            },
          },
        },
      },
    });

    if (!responsible) {
      throw new BadRequestException('El responsable de aprobación no existe');
    }

    if (!responsible.isActive) {
      throw new BadRequestException(
        'El responsable de aprobación debe estar activo',
      );
    }

    const isOwner = responsible.roles.some(
      (userRole) => userRole.role.code === RoleCode.OWNER,
    );

    if (!isOwner) {
      throw new BadRequestException(
        'El responsable de aprobación debe tener el rol OWNER',
      );
    }
  }

  private validateConsistency(dto: PutRestaurantConfigDto): void {
    const hasLatitude = dto.latitude != null;
    const hasLongitude = dto.longitude != null;

    if (hasLatitude !== hasLongitude) {
      throw new BadRequestException(
        'latitude y longitude deben proporcionarse juntas',
      );
    }

    const expectedDays = Object.values(DayOfWeek);
    const receivedDays = new Set(
      dto.schedules.map((schedule) => schedule.dayOfWeek),
    );

    if (
      dto.schedules.length !== expectedDays.length ||
      receivedDays.size !== expectedDays.length ||
      expectedDays.some((day) => !receivedDays.has(day))
    ) {
      throw new BadRequestException(
        'schedules debe contener exactamente una entrada para cada día de la semana',
      );
    }

    if (dto.schedules.some((schedule) => !isScheduleTimeCoherent(schedule))) {
      throw new BadRequestException(
        'Los horarios son incoherentes o cruzan la medianoche',
      );
    }
  }

  private serialize(config: RestaurantConfigRecord) {
    const { languages, schedules, latitude, longitude, ...data } = config;

    return {
      ...data,
      latitude: latitude?.toNumber() ?? null,
      longitude: longitude?.toNumber() ?? null,
      languages: languages
        .map(({ language }) => language)
        .sort((a, b) => languageOrder[a] - languageOrder[b]),
      schedules: [...schedules].sort(
        (a, b) => dayOrder[a.dayOfWeek] - dayOrder[b.dayOfWeek],
      ),
    };
  }

  private normalizeOptionalString(value?: string | null): string | null {
    if (value == null) {
      return null;
    }

    const normalizedValue = value.trim();
    return normalizedValue || null;
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
        'La configuración entró en conflicto con otro cambio; inténtalo nuevamente',
      );
    }

    if (this.hasPrismaCode(error, 'P2002')) {
      throw new ConflictException(
        'Ya existe una configuración global en conflicto',
      );
    }

    if (
      this.hasPrismaCode(error, 'P2003') ||
      this.hasPrismaCode(error, 'P2004')
    ) {
      throw new BadRequestException(
        'La configuración contiene referencias o valores inválidos',
      );
    }
  }
}
