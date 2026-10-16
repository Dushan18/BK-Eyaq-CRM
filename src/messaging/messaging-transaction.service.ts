import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

function serializationFailure(value: unknown, depth = 0): boolean {
  if (depth > 4 || typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    ['40001', '40P01'].includes(String(data.code)) ||
    ['40001', '40P01'].includes(String(data.originalCode)) ||
    data.kind === 'TransactionWriteConflict' ||
    ['meta', 'cause', 'driverAdapterError'].some((key) =>
      serializationFailure(data[key], depth + 1),
    )
  );
}

export function prismaCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2010' &&
    serializationFailure(error)
  )
    return 'P2034';
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
@Injectable()
export class MessagingTransactionService {
  constructor(private readonly prisma: PrismaService) {}
  async run<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    retryUnique = false,
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: 'Serializable',
        });
      } catch (error) {
        const code = prismaCode(error);
        if (
          (code === 'P2034' || (retryUnique && code === 'P2002')) &&
          attempt < 4
        )
          continue;
        if (code === 'P2002' || code === 'P2034')
          throw new ConflictException(
            'Conflicto de mensajería; vuelve a intentarlo',
          );
        if (code === 'P2025')
          throw new NotFoundException('Recurso de mensajería no encontrado');
        if (code === 'P2003' || code === 'P2004')
          throw new BadRequestException('Datos de mensajería inválidos');
        throw error;
      }
    }
    throw new ConflictException('Conflicto de mensajería');
  }
}
