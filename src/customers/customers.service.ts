import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { normalizeContact } from '../common/contact-normalization';
import {
  CreateCustomerDto,
  CreateCustomerInterestDto,
  CustomerQueryDto,
  UpdateCustomerDto,
  UpdateCustomerStatusDto,
} from '../dto/customer.dto';

const customerSelect = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  phoneCountry: true,
  email: true,
  sourceChannel: true,
  status: true,
  firstContactAt: true,
  lastContactAt: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerSelect;

const interestSelect = {
  id: true,
  firstInterestedAt: true,
  lastInterestedAt: true,
  notes: true,
  commercialItem: {
    select: {
      id: true,
      nameEs: true,
      nameEn: true,
      type: true,
      isActive: true,
      approvalStatus: true,
    },
  },
} satisfies Prisma.CustomerInterestSelect;

type NormalizedContact = ReturnType<typeof normalizeContact>;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCustomerDto) {
    const contact = normalizeContact(dto);
    try {
      await this.ensureAvailable(this.prisma, contact);
      const now = new Date();
      return await this.prisma.customer.create({
        data: {
          ...this.createData(dto, contact),
          firstContactAt: now,
          lastContactAt: now,
        },
        select: customerSelect,
      });
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  async findAll(query: CustomerQueryDto) {
    const search = query.search?.trim();
    const digits = search?.replace(/\D/g, '');
    const where: Prisma.CustomerWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { sourceChannel: query.channel } : {}),
      ...(query.commercialItemId
        ? { interests: { some: { commercialItemId: query.commercialItemId } } }
        : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              { email: { contains: search, mode: 'insensitive' } },
              { normalizedEmail: { contains: search.toLowerCase() } },
              ...(digits ? [{ normalizedPhone: { contains: digits } }] : []),
            ],
          }
        : {}),
    };
    const { page = 1, limit = 20 } = query;
    const [data, total] = await this.prisma.$transaction(
      [
        this.prisma.customer.findMany({
          where,
          select: customerSelect,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: [{ lastContactAt: 'desc' }, { id: 'asc' }],
        }),
        this.prisma.customer.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        ...customerSelect,
        interests: {
          select: interestSelect,
          orderBy: [{ lastInterestedAt: 'desc' }, { id: 'asc' }],
        },
      },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto) {
    if (!Object.values(dto).some((value) => value !== undefined)) {
      throw new BadRequestException(
        'Debes proporcionar al menos un campo para actualizar',
      );
    }
    return this.transaction(async (tx) => {
      const current = await tx.customer.findUnique({
        where: { id },
        select: {
          id: true,
          phone: true,
          phoneCountry: true,
          email: true,
        },
      });
      if (!current) throw new NotFoundException('Cliente no encontrado');
      const contact = normalizeContact({
        phone: dto.phone !== undefined ? dto.phone : current.phone,
        phoneCountry:
          dto.phone === null
            ? null
            : dto.phoneCountry !== undefined
              ? dto.phoneCountry
              : dto.phone !== undefined
                ? null
                : current.phoneCountry,
        email: dto.email !== undefined ? dto.email : current.email,
      });
      if (dto.phone === null && dto.phoneCountry != null) {
        throw new BadRequestException('phoneCountry requiere un teléfono');
      }
      await this.ensureAvailable(tx, contact, id);
      const data: Prisma.CustomerUpdateInput = { ...contact };
      if (dto.firstName !== undefined)
        data.firstName = this.text(dto.firstName);
      if (dto.lastName !== undefined) data.lastName = this.text(dto.lastName);
      if (dto.notes !== undefined) data.notes = this.text(dto.notes);
      if (dto.sourceChannel !== undefined)
        data.sourceChannel = dto.sourceChannel;
      // La edición administrativa no constituye un nuevo contacto.
      return tx.customer.update({
        where: { id },
        data,
        select: customerSelect,
      });
    });
  }

  async updateStatus(id: string, dto: UpdateCustomerStatusDto) {
    // TODO: REQUESTED_RESERVATION/CONFIRMED se integrarán con reservas.
    try {
      return await this.prisma.customer.update({
        where: { id },
        data: { status: dto.status },
        select: customerSelect,
      });
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  async touchLastContact(
    customerId: string,
    at = new Date(),
    transaction?: Prisma.TransactionClient,
  ) {
    this.validateContactDate(at);
    const operation = async (tx: Prisma.TransactionClient) => {
      await this.requireCustomer(tx, customerId);
      await this.touch(tx, customerId, at);
      return tx.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: customerSelect,
      });
    };
    return transaction ? operation(transaction) : this.transaction(operation);
  }

  async findOrCreateByContact(
    dto: CreateCustomerDto,
    transaction?: Prisma.TransactionClient,
  ) {
    const contact = normalizeContact(dto);
    const operation = async (tx: Prisma.TransactionClient) => {
      const matches = await this.matches(tx, contact);
      if (matches.length > 1) {
        throw new ConflictException(
          'Los contactos corresponden a clientes distintos; requiere revisión manual',
        );
      }
      const now = new Date();
      if (matches.length === 1) {
        const existing = matches[0];
        // No fusionar ni reemplazar datos existentes mediante el flujo automático.
        if (
          (contact.normalizedPhone &&
            existing.normalizedPhone &&
            contact.normalizedPhone !== existing.normalizedPhone) ||
          (contact.normalizedEmail &&
            existing.normalizedEmail &&
            contact.normalizedEmail !== existing.normalizedEmail)
        ) {
          throw new ConflictException(
            'La identidad de contacto requiere revisión manual',
          );
        }
        await this.touch(tx, existing.id, now);
        return tx.customer.findUniqueOrThrow({
          where: { id: existing.id },
          select: customerSelect,
        });
      }
      return tx.customer.create({
        data: {
          ...this.createData(dto, contact),
          firstContactAt: now,
          lastContactAt: now,
        },
        select: customerSelect,
      });
    };
    return transaction ? operation(transaction) : this.transaction(operation);
  }

  async addInterest(customerId: string, dto: CreateCustomerInterestDto) {
    return this.transaction(async (tx) => {
      await this.requireCustomer(tx, customerId);
      const item = await tx.commercialItem.findUnique({
        where: { id: dto.commercialItemId },
        select: { id: true },
      });
      if (!item)
        throw new NotFoundException('Elemento comercial no encontrado');
      const where = {
        customerId_commercialItemId: {
          customerId,
          commercialItemId: dto.commercialItemId,
        },
      };
      const existing = await tx.customerInterest.findUnique({
        where,
        select: { lastInterestedAt: true },
      });
      const now = new Date();
      const lastInterestedAt =
        existing && existing.lastInterestedAt > now
          ? existing.lastInterestedAt
          : now;
      const interest = await tx.customerInterest.upsert({
        where,
        create: {
          customerId,
          commercialItemId: dto.commercialItemId,
          firstInterestedAt: now,
          lastInterestedAt: now,
          notes: this.text(dto.notes),
        },
        update: {
          lastInterestedAt,
          ...(dto.notes !== undefined ? { notes: this.text(dto.notes) } : {}),
        },
        select: interestSelect,
      });
      // Registrar una consulta sí constituye contacto; los intereses pueden ser históricos.
      await this.touch(tx, customerId, now);
      return interest;
    });
  }

  async removeInterest(
    customerId: string,
    commercialItemId: string,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      await this.requireCustomer(tx, customerId);
      const result = await tx.customerInterest.deleteMany({
        where: { customerId, commercialItemId },
      });
      if (!result.count) throw new NotFoundException('Interés no encontrado');
    });
  }

  private createData(dto: CreateCustomerDto, contact: NormalizedContact) {
    return {
      ...contact,
      firstName: this.text(dto.firstName),
      lastName: this.text(dto.lastName),
      sourceChannel: dto.sourceChannel,
      notes: this.text(dto.notes),
    };
  }

  private text(value?: string | null): string | null {
    if (value == null) return null;
    const result = value.trim();
    if (!result)
      throw new BadRequestException(
        'Los campos de texto no pueden estar vacíos',
      );
    return result;
  }

  private matches(tx: Prisma.TransactionClient, contact: NormalizedContact) {
    const OR: Prisma.CustomerWhereInput[] = [];
    if (contact.normalizedPhone)
      OR.push({ normalizedPhone: contact.normalizedPhone });
    if (contact.normalizedEmail)
      OR.push({ normalizedEmail: contact.normalizedEmail });
    return tx.customer.findMany({
      where: { OR },
      take: 2,
      select: { id: true, normalizedPhone: true, normalizedEmail: true },
    });
  }

  private async ensureAvailable(
    tx: Prisma.TransactionClient,
    contact: NormalizedContact,
    id?: string,
  ) {
    const matches = await this.matches(tx, contact);
    if (matches.some((match) => match.id !== id)) {
      throw new ConflictException(
        'Ya existe un cliente con ese teléfono o correo',
      );
    }
  }

  private async requireCustomer(tx: Prisma.TransactionClient, id: string) {
    const customer = await tx.customer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
  }

  private touch(tx: Prisma.TransactionClient, id: string, at: Date) {
    return tx.customer.updateMany({
      where: { id, lastContactAt: { lt: at } },
      data: { lastContactAt: at },
    });
  }

  private validateContactDate(at: Date) {
    if (
      !(at instanceof Date) ||
      !Number.isFinite(at.getTime()) ||
      at.getTime() > Date.now()
    ) {
      throw new BadRequestException(
        'La fecha de contacto debe ser válida y no futura',
      );
    }
  }

  private code(error: unknown): string | undefined {
    return typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
      ? error.code
      : undefined;
  }

  private async transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: 'Serializable',
        });
      } catch (error: unknown) {
        // Releer identidad/fechas después de una carrera de creación o actualización.
        if (['P2002', 'P2034'].includes(this.code(error) ?? '') && attempt < 2)
          continue;
        this.rethrow(error);
      }
    }
    throw new ConflictException('Conflicto concurrente; vuelve a intentarlo');
  }

  private rethrow(error: unknown): never {
    switch (this.code(error)) {
      case 'P2002':
        throw new ConflictException(
          'Ya existe un cliente o interés con esos datos',
        );
      case 'P2034':
        throw new ConflictException(
          'Conflicto concurrente; vuelve a intentarlo',
        );
      case 'P2025':
        throw new NotFoundException('Cliente o interés no encontrado');
      case 'P2003':
      case 'P2004':
        throw new BadRequestException(
          'Los datos o referencias del cliente son inválidos',
        );
      default:
        throw error;
    }
  }
}
// TODO: integrar auditoría funcional. No registrar teléfonos, correos ni notas en logs.
// Sprint 3: Conversation y reservas referenciarán Customer.id mediante sus propias migraciones.
