import { ConflictException } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';
import { MessagingTransactionService } from './messaging-transaction.service';

describe('MessagingTransactionService: conflictos al commit', () => {
  it('reintenta un conflicto no envuelto del adaptador y devuelve el resultado', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce({ cause: { kind: 'TransactionWriteConflict' } })
      .mockResolvedValue('ok');
    const service = new MessagingTransactionService({
      $transaction: transaction,
    } as unknown as PrismaService);
    await expect(service.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it('limita reintentos y convierte un conflicto persistente en 409', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValue({ cause: { originalCode: '40001' } });
    const service = new MessagingTransactionService({
      $transaction: transaction,
    } as unknown as PrismaService);
    await expect(
      service.run(() => Promise.resolve('ok')),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction).toHaveBeenCalledTimes(5);
  });
  it('no reintenta errores ajenos a serialización', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValue(new Error('DB unavailable'));
    const service = new MessagingTransactionService({
      $transaction: transaction,
    } as unknown as PrismaService);
    await expect(service.run(() => Promise.resolve('ok'))).rejects.toThrow(
      'DB unavailable',
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
