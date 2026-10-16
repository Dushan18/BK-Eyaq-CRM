import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AssignConversationDto,
  ConversationQueryDto,
  MarkConversationReadDto,
  UpdateAssistantPauseDto,
} from './messaging.dto';
import { validateInboundMessage } from './inbound-message.command';
import { redisConnection } from './messaging-queue.service';
import { prismaCode } from './messaging-transaction.service';

const command = () => ({
  channel: 'WHATSAPP',
  externalMessageId: 'provider-1',
  type: 'TEXT',
  content: 'Hola',
  contact: { phone: '+51 987 654 321' },
});
describe('Mensajería: validación', () => {
  it('reconoce conflictos de serialización de consultas SQL sin reintentar errores arbitrarios', () => {
    expect(
      prismaCode({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '40001' } } },
      }),
    ).toBe('P2034');
    expect(prismaCode({ code: 'P2010', meta: { code: '42601' } })).toBe(
      'P2010',
    );
  });
  it('valida y normaliza comando interno sin endpoint HTTP', () => {
    expect(validateInboundMessage(command())).toMatchObject({
      content: 'Hola',
      channel: 'WHATSAPP',
    });
  });
  it.each([
    null,
    [],
    {},
    { ...command(), direction: 'OUTBOUND' },
    { ...command(), status: 'SENT' },
    { ...command(), channel: 'INVENTED' },
    { ...command(), type: 'INVENTED' },
    { ...command(), content: ' ' },
    { ...command(), externalMessageId: '' },
    { ...command(), attachments: [null] },
    { ...command(), contact: { phone: '987654321' } },
    { ...command(), occurredAt: '2026-01-01' },
    { ...command(), type: 'IMAGE' },
    { ...command(), content: 'x'.repeat(16001) },
    { ...command(), attachments: [{ type: 'FILE', url: 'file:///secret' }] },
    {
      ...command(),
      attachments: [
        { type: 'FILE', url: 'https://example.com', sizeBytes: -1 },
      ],
    },
  ])('rechaza comando inválido %#', (body) => {
    expect(() => validateInboundMessage(body)).toThrow();
  });
  it.each(['IMAGE', 'FILE'])('acepta metadata %s, sin binario', (type) => {
    const parsed = validateInboundMessage({
      ...command(),
      type,
      content: undefined,
      attachments: [{ type, externalMediaId: 'media-1', sizeBytes: 1024 }],
    });
    expect(parsed.attachments).toHaveLength(1);
  });
  it.each([{}, { assignedUserId: '' }, { assignedUserId: false }])(
    'rechaza asignación inválida %j',
    async (input) => {
      expect(
        await validate(plainToInstance(AssignConversationDto, input)),
      ).not.toHaveLength(0);
    },
  );
  it('null desasigna explícitamente', async () => {
    expect(
      await validate(
        plainToInstance(AssignConversationDto, { assignedUserId: null }),
      ),
    ).toHaveLength(0);
  });
  it('read exige corte UUID', async () => {
    expect(
      await validate(plainToInstance(MarkConversationReadDto, {})),
    ).not.toHaveLength(0);
  });
  it('pausa exige boolean real', async () => {
    expect(
      await validate(
        plainToInstance(UpdateAssistantPauseDto, { paused: 'false' }),
      ),
    ).not.toHaveLength(0);
  });
  it.each([
    { page: 0 },
    { page: 1e30 },
    { limit: 101 },
    { unreadOnly: 'yes' },
    { isAssistantPaused: null },
    { channel: 'INVALID' },
  ])('rechaza filtros %j', async (input) => {
    expect(
      await validate(plainToInstance(ConversationQueryDto, input)),
    ).not.toHaveLength(0);
  });
  it('transforma filtros y aplica defaults', async () => {
    const dto = plainToInstance(ConversationQueryDto, {
      unreadOnly: 'false',
      page: '2',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto).toMatchObject({ unreadOnly: false, page: 2, limit: 50 });
  });
  it('Redis configura productor acotado y worker bloqueante', () => {
    expect(redisConnection('redis://localhost:6379/0')).toMatchObject({
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    expect(redisConnection('rediss://localhost:6379/0', true)).toMatchObject({
      maxRetriesPerRequest: null,
      tls: {},
    });
    expect(() => redisConnection('https://example.com')).toThrow(
      'REDIS_URL inválida',
    );
  });
});
