import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { MessagesService } from '../src/messaging/messages.service';

async function main() {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.ALLOW_MESSAGING_DEMO !== 'true'
  ) {
    throw new Error(
      'Tooling solo de desarrollo: requiere ALLOW_MESSAGING_DEMO=true',
    );
  }
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) {
    throw new Error('La demo solo admite PostgreSQL local');
  }
  // Ingestion persists the outbox; enabling processing is a separate decision.
  process.env.MESSAGING_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const service = app.get(MessagesService);
    for (const [index, content] of [
      'Hola, quiero información',
      '¿Qué platos tienen disponibles?',
    ].entries()) {
      const result = await service.ingestInboundMessage({
        channel: 'WHATSAPP',
        externalMessageId: `local-messaging-demo-${index + 1}`,
        type: 'TEXT',
        content,
        contact: {
          firstName: 'Cliente',
          lastName: 'Demo mensajería',
          email: 'messaging.demo@example.com',
        },
      });
      console.log(
        JSON.stringify({
          conversationId: result.message.conversationId,
          messageId: result.message.id,
          duplicate: result.duplicate,
        }),
      );
    }
  } finally {
    await app.close();
  }
}
main().catch(() => {
  // Never print connection strings, Prisma details or message contents.
  console.error(
    'No se pudo preparar la demo. Revisa permisos y configuración local.',
  );
  process.exitCode = 1;
});
