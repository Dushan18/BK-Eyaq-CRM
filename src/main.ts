import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { assertProductionEnv } from './config/production-env';

async function bootstrap() {
  // AppModule ya cargó .env al importarse (ConfigModule.forRoot).
  assertProductionEnv(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  // Close workers/dispatcher and connections when the process stops gracefully.
  app.enableShutdownHooks();
  // Behind a reverse proxy, req.ip (rate limiting) comes from X-Forwarded-For
  // only for trusted hops: a hop count ("1") or addresses/subnets.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    app.set(
      'trust proxy',
      /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy,
    );
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
