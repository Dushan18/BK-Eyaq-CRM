import {
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { MessagingQueueService } from './messaging-queue.service';
import {
  MessageProcessorService,
  MESSAGE_LEASE_MS,
} from './message-processor.service';
import { OutboundMessagesService } from './outbound-messages.service';
import { MessageStatusService } from './message-status.service';

@Injectable()
export class MessagingOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagingOutboxService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: MessagingQueueService,
    private readonly processor: MessageProcessorService,
    private readonly config: ConfigService,
    @Optional() private readonly outbound?: OutboundMessagesService,
    @Optional() private readonly statuses?: MessageStatusService,
  ) {}
  onModuleInit() {
    const enabled = this.config.get<string>('MESSAGING_ENABLED') ?? 'false';
    if (!['true', 'false'].includes(enabled))
      throw new Error('MESSAGING_ENABLED debe ser true o false');
    if (enabled !== 'true') return;
    this.queue.start(this.processor, this.outbound);
    this.tick();
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
  }
  private tick() {
    if (this.running) return;
    this.running = this.dispatchOnce()
      .catch(() => this.logger.warn('MESSAGING_DISPATCH_UNAVAILABLE'))
      .finally(() => {
        this.running = undefined;
      });
  }
  async dispatchOnce() {
    const now = new Date();
    const rows = await this.prisma.messagingOutbox.findMany({
      where: {
        status: { in: ['PENDING', 'PUBLISHED'] },
        availableAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        message: {
          status: { in: ['RECEIVED', 'PROCESSING', 'QUEUED', 'SENDING'] },
          OR: [{ processingUntil: null }, { processingUntil: { lte: now } }],
        },
      },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: 50,
      include: { message: { select: { direction: true } } },
    });
    for (const row of rows) {
      const token = randomUUID();
      const claimed = await this.prisma.messagingOutbox.updateMany({
        where: {
          id: row.id,
          status: { in: ['PENDING', 'PUBLISHED'] },
          availableAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
          message: {
            status: { in: ['RECEIVED', 'PROCESSING', 'QUEUED', 'SENDING'] },
          },
        },
        data: {
          leaseToken: token,
          leaseUntil: new Date(Date.now() + MESSAGE_LEASE_MS),
          publishAttempts: { increment: 1 },
        },
      });
      if (!claimed.count) continue;
      if (Date.now() - row.createdAt.getTime() > 300000)
        this.logger.warn(
          JSON.stringify({
            code: 'MESSAGING_PENDING_AGED',
            messageId: row.messageId,
          }),
        );
      try {
        await this.queue.publish(row.messageId, row.message.direction);
        await this.prisma.messagingOutbox.updateMany({
          where: {
            id: row.id,
            leaseToken: token,
            leaseUntil: { gt: new Date() },
            status: { in: ['PENDING', 'PUBLISHED'] },
          },
          data: {
            status: 'PUBLISHED',
            publishedAt: new Date(),
            availableAt: new Date(Date.now() + 10000),
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: null,
          },
        });
      } catch {
        await this.prisma.messagingOutbox.updateMany({
          where: {
            id: row.id,
            leaseToken: token,
            leaseUntil: { gt: new Date() },
            status: { in: ['PENDING', 'PUBLISHED'] },
          },
          data: {
            status: 'PENDING',
            availableAt: new Date(
              Date.now() +
                Math.min(60000, 1000 * 2 ** Math.min(row.publishAttempts, 6)),
            ),
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: 'QUEUE_UNAVAILABLE',
          },
        });
      }
    }
    await this.statuses?.reconcileOnce();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
