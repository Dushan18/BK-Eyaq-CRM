import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class ReservationSupportService {
  constructor(private readonly prisma: PrismaService) {}

  async transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: 'Serializable',
        });
      } catch (error: unknown) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
        if (code === 'P2034' && attempt < 2) continue;
        if (code === 'P2034')
          throw new ConflictException(
            'Conflicto concurrente; vuelve a intentarlo',
          );
        if (code === 'P2002')
          throw new ConflictException(
            'El código o la solicitud ya están vinculados a una reserva',
          );
        if (code === 'P2025')
          throw new NotFoundException('Solicitud o reserva no encontrada');
        if (code === 'P2003' || code === 'P2004')
          throw new BadRequestException(
            'Datos o relaciones de reserva inválidos',
          );
        throw error;
      }
    }
    throw new ConflictException('Conflicto concurrente');
  }

  async configuration(tx: Prisma.TransactionClient) {
    const config = await tx.restaurantConfig.findUnique({
      where: { scope: 'GLOBAL' },
      select: { currency: true, timeZone: true },
    });
    if (!config)
      throw new ConflictException(
        'Configura el restaurante antes de crear solicitudes o reservas',
      );
    return config;
  }

  async code(
    tx: Prisma.TransactionClient,
    kind: 'request' | 'reservation',
    timeZone: string,
    now: Date,
  ) {
    let year: string;
    try {
      year = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
      }).format(now);
    } catch {
      throw new ServiceUnavailableException(
        'La zona horaria del restaurante no es válida',
      );
    }
    const rows =
      kind === 'request'
        ? await tx.$queryRaw<
            { value: bigint }[]
          >`SELECT nextval('reservation_request_code_seq') AS value`
        : await tx.$queryRaw<
            { value: bigint }[]
          >`SELECT nextval('reservation_code_seq') AS value`;
    return `${kind === 'request' ? 'RES' : 'R'}-${year}-${rows[0].value.toString().padStart(6, '0')}`;
  }

  async customer(tx: Prisma.TransactionClient, id: string) {
    if (
      !(await tx.customer.findUnique({ where: { id }, select: { id: true } }))
    )
      throw new NotFoundException('Cliente no encontrado');
  }

  async commercialItem(tx: Prisma.TransactionClient, id?: string | null) {
    if (!id) return;
    const item = await tx.commercialItem.findUnique({
      where: { id },
      select: { isActive: true, approvalStatus: true },
    });
    if (!item) throw new NotFoundException('Elemento comercial no encontrado');
    if (!item.isActive || item.approvalStatus !== 'APPROVED')
      throw new BadRequestException(
        'El elemento comercial debe estar activo y aprobado',
      );
  }
}
