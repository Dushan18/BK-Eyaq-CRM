import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { assertUtcDatabase, createPgAdapter } from './pg-adapter';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>('DATABASE_URL');

    if (!databaseUrl) {
      throw new Error('DATABASE_URL no está configurada');
    }

    super({
      adapter: createPgAdapter(databaseUrl),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await assertUtcDatabase(this);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
