import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { ReservationSupportService } from './reservation-support.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('ReservationSupportService', () => {
  const transaction = jest.fn();
  const service = new ReservationSupportService({
    $transaction: transaction,
  } as unknown as PrismaService);
  beforeEach(() => jest.resetAllMocks());

  it('reintenta conflictos serializables y vuelve a ejecutar la operación', async () => {
    const operation = jest.fn().mockResolvedValue('ok');
    transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce((fn: () => Promise<string>) => fn());
    expect(await service.transaction(operation)).toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('limita los reintentos a tres', async () => {
    transaction.mockRejectedValue({ code: 'P2034' });
    await expect(service.transaction(jest.fn())).rejects.toThrow(
      ConflictException,
    );
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['P2002', ConflictException],
    ['P2025', NotFoundException],
    ['P2003', BadRequestException],
    ['P2004', BadRequestException],
  ])('traduce %s sin exponer Prisma', async (code, exception) => {
    transaction.mockRejectedValue({ code });
    await expect(service.transaction(jest.fn())).rejects.toThrow(exception);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('propaga fallos inesperados al filtro global', async () => {
    const failure = new Error('unexpected');
    transaction.mockRejectedValue(failure);
    await expect(service.transaction(jest.fn())).rejects.toBe(failure);
  });

  it('año del código usa la zona del restaurante y no trunca la secuencia', async () => {
    const query = jest.fn().mockResolvedValue([{ value: 1000001n }]);
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    const at = new Date('2027-01-01T01:00:00Z');
    expect(await service.code(tx, 'request', 'America/Lima', at)).toBe(
      'RES-2026-1000001',
    );
    expect(await service.code(tx, 'reservation', 'UTC', at)).toBe(
      'R-2027-1000001',
    );
    await expect(service.code(tx, 'request', 'invalid', at)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
