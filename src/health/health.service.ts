import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

export const HEALTH_DATABASE_TIMEOUT_MS = 3_000;

type HealthStatus = 'ok' | 'error';
type ServiceStatus = 'up' | 'down';

export interface HealthResponse {
  status: HealthStatus;
  services: {
    api: 'up';
    database: ServiceStatus;
  };
  timestamp: string;
  uptimeSeconds: number;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthResponse> {
    try {
      await this.pingDatabase();
      return this.createResponse('ok', 'up');
    } catch {
      this.logger.error('Health check database failed');

      throw new ServiceUnavailableException(
        this.createResponse('error', 'down'),
      );
    }
  }

  private async pingDatabase(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('Database health check timed out'));
      }, HEALTH_DATABASE_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        this.prisma.$queryRaw<Array<{ result: number }>>`
          SELECT 1 AS "result"
        `,
        timeoutPromise,
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private createResponse(
    status: HealthStatus,
    database: ServiceStatus,
  ): HealthResponse {
    return {
      status,
      services: {
        api: 'up',
        database,
      },
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
