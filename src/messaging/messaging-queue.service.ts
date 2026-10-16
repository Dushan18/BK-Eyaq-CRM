import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { isUUID } from 'class-validator';
import {
  MessageProcessorService,
  MESSAGE_ATTEMPTS,
} from './message-processor.service';

export const INBOUND_QUEUE = 'messaging-inbound';
export const OUTBOUND_QUEUE = 'messaging-outbound';
interface Processor {
  process(messageId: string): Promise<'processed' | 'terminal' | 'busy'>;
}
export interface MessageJob {
  messageId: string;
}
export function redisConnection(
  url: string,
  worker = false,
): ConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('REDIS_URL inválida');
  }
  const database = parsed.pathname.slice(1) || '0';
  if (
    !['redis:', 'rediss:'].includes(parsed.protocol) ||
    !/^\d+$/.test(database) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('REDIS_URL inválida');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    db: Number(database),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    connectTimeout: 2000,
    ...(worker ? {} : { commandTimeout: 3000 }),
  };
}
@Injectable()
export class MessagingQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(MessagingQueueService.name);
  private queue?: Queue<MessageJob>;
  private worker?: Worker<MessageJob>;
  private outboundQueue?: Queue<MessageJob>;
  private outboundWorker?: Worker<MessageJob>;
  constructor(private readonly config: ConfigService) {}
  start(processor: MessageProcessorService, outbound?: Processor) {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) throw new Error('REDIS_URL requerida al habilitar mensajería');
    const prefix =
      this.config.get<string>('MESSAGING_QUEUE_PREFIX') ?? 'eyaq-messaging';
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(prefix))
      throw new Error('MESSAGING_QUEUE_PREFIX inválido');
    this.queue = new Queue<MessageJob>(INBOUND_QUEUE, {
      connection: redisConnection(url),
      prefix,
    });
    this.queue.on('error', () =>
      this.logger.warn('MESSAGING_REDIS_UNAVAILABLE'),
    );
    this.worker = new Worker<MessageJob>(
      INBOUND_QUEUE,
      async (job) => {
        if (
          !job.data ||
          Object.keys(job.data).length !== 1 ||
          !isUUID(job.data.messageId)
        )
          throw new Error('MESSAGE_JOB_INVALID');
        let result: Awaited<ReturnType<MessageProcessorService['process']>>;
        try {
          result = await processor.process(job.data.messageId);
        } catch {
          // BullMQ persists failure reasons/stacktraces; never forward DB/provider errors.
          const safe = new Error('MESSAGE_PROCESSING_TEMPORARY');
          safe.stack = undefined;
          throw safe;
        }
        if (result === 'busy') throw new Error('MESSAGE_BUSY');
        return result;
      },
      { connection: redisConnection(url, true), prefix, concurrency: 4 },
    );
    this.worker.on('error', () =>
      this.logger.warn('MESSAGING_WORKER_UNAVAILABLE'),
    );
    this.worker.on('failed', (job) =>
      this.logger.warn(
        JSON.stringify({ code: 'MESSAGE_JOB_FAILED', jobId: job?.id }),
      ),
    );
    if (outbound) {
      this.outboundQueue = new Queue<MessageJob>(OUTBOUND_QUEUE, {
        connection: redisConnection(url),
        prefix,
      });
      this.outboundQueue.on('error', () =>
        this.logger.warn('MESSAGING_REDIS_UNAVAILABLE'),
      );
      this.outboundWorker = new Worker<MessageJob>(
        OUTBOUND_QUEUE,
        async (job) => {
          if (
            !job.data ||
            Object.keys(job.data).length !== 1 ||
            !isUUID(job.data.messageId)
          )
            throw new Error('MESSAGE_JOB_INVALID');
          try {
            const result = await outbound.process(job.data.messageId);
            if (result === 'busy') throw new Error('MESSAGE_BUSY');
            return result;
          } catch {
            const safe = new Error('MESSAGE_OUTBOUND_TEMPORARY');
            safe.stack = undefined;
            throw safe;
          }
        },
        { connection: redisConnection(url, true), prefix, concurrency: 4 },
      );
      this.outboundWorker.on('error', () =>
        this.logger.warn('MESSAGING_WORKER_UNAVAILABLE'),
      );
      this.outboundWorker.on('failed', () =>
        this.logger.warn('MESSAGE_OUTBOUND_JOB_FAILED'),
      );
    }
  }
  async publish(
    messageId: string,
    direction: 'INBOUND' | 'OUTBOUND' = 'INBOUND',
  ) {
    const queue = direction === 'INBOUND' ? this.queue : this.outboundQueue;
    if (!queue) throw new Error('MESSAGING_QUEUE_DISABLED');
    const jobId = `${direction.toLowerCase()}-${messageId}`;
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') {
        // Only called by the durable outbox for a nonterminal message.
        await existing.retry(state);
      }
      return;
    }
    await queue.add(
      `process-${direction.toLowerCase()}`,
      { messageId },
      {
        jobId,
        attempts: MESSAGE_ATTEMPTS,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 1000 },
      },
    );
  }
  async onModuleDestroy() {
    if (this.outboundWorker) await this.outboundWorker.close();
    if (this.outboundQueue) await this.outboundQueue.close();
    if (this.worker) await this.worker.close();
    if (this.queue) await this.queue.close();
  }
}
