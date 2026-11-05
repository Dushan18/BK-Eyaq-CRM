import { BadRequestException, ConflictException } from '@nestjs/common';
import { INBOUND_IDENTITY_CONFLICT, MessagesService } from './messages.service';
import { ChannelTransports, type ChannelTransport } from './channel-transport';
import type { InboundMessageCommand } from './inbound-message.command';
import type { CustomersService } from '../customers/customers.service';
import type { MessagingTransactionService } from './messaging-transaction.service';
import type { PrismaService } from '../database/prisma.service';

const command = (id: string): InboundMessageCommand => ({
  channel: 'WHATSAPP',
  externalMessageId: id,
  type: 'TEXT',
  content: 'Hola',
  contact: { phone: '+51987654321' },
});
const service = (createMany = jest.fn()) =>
  new MessagesService(
    {} as CustomersService,
    {} as MessagingTransactionService,
    { messagingWebhookRejection: { createMany } } as unknown as PrismaService,
  );

describe('Recepción unificada: política común de webhooks', () => {
  it('pone en cuarentena lo inválido o de otra identidad y devuelve solo lo nuevo', async () => {
    const messages = service();
    const customer = { id: 'c1', firstName: null, lastName: null };
    jest
      .spyOn(messages, 'ingestInboundMessage')
      .mockResolvedValueOnce({
        message: {} as never,
        duplicate: false,
        customer: customer as never,
      })
      .mockResolvedValueOnce({ message: {} as never, duplicate: true })
      .mockRejectedValueOnce(new BadRequestException('Comando inválido'))
      .mockRejectedValueOnce(new ConflictException(INBOUND_IDENTITY_CONFLICT));
    const rejected: string[] = [];
    const created = await messages.ingestFromProvider(
      ['new', 'duplicate', 'invalid', 'conflict'].map(command),
      rejected,
    );
    expect(created).toEqual([{ command: command('new'), customer }]);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  });
  it.each([
    new ConflictException('Conflicto de mensajería; vuelve a intentarlo'),
    new Error('DB unavailable'),
  ])(
    'relanza lo transitorio para que el proveedor reintente (%#)',
    async (error) => {
      const messages = service();
      jest.spyOn(messages, 'ingestInboundMessage').mockRejectedValueOnce(error);
      const rejected: string[] = [];
      await expect(
        messages.ingestFromProvider([command('busy')], rejected),
      ).rejects.toBe(error);
      expect(rejected).toEqual([]);
    },
  );
  it('registra la cuarentena sin duplicar y sin tocar la base si no hay nada', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    await service(createMany).quarantine([], 'WHATSAPP_EVENT_INVALID');
    expect(createMany).not.toHaveBeenCalled();
    await service(createMany).quarantine(['a'.repeat(64)], 'X_EVENT_INVALID');
    expect(createMany).toHaveBeenCalledWith({
      data: [{ fingerprint: 'a'.repeat(64), code: 'X_EVENT_INVALID' }],
      skipDuplicates: true,
    });
  });
});

describe('Registro de canales', () => {
  const transport = (channel: 'WHATSAPP' | 'FACEBOOK', enabled: boolean) =>
    ({ channel, enabled, errorPrefix: `${channel}_X` }) as ChannelTransport;
  it('encuentra cada canal por nombre y usa su prefijo de errores', () => {
    const transports = new ChannelTransports([
      transport('WHATSAPP', false),
      transport('FACEBOOK', true),
    ]);
    expect(transports.find('FACEBOOK')?.errorPrefix).toBe('FACEBOOK_X');
    expect(transports.find('INSTAGRAM')).toBeUndefined();
    expect(transports.errorPrefix('INSTAGRAM')).toBe('INSTAGRAM');
    expect(transports.anyEnabled).toBe(true);
    expect(
      new ChannelTransports([transport('WHATSAPP', false)]).anyEnabled,
    ).toBe(false);
  });
});
