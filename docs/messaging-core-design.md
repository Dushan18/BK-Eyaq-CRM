# Mensajería central — diseño de Fase 1 para revisión

Estado original (2026-09-23): diseño aprobado e implementado en persistencia/API; migración aplicada. Actualización 13/10/2026: pruebas INBOUND/OUTBOUND y recuperación tras caída abrupta/reinicio de Redis aislado aprobadas. Ver [avance actualizado y límites](sprint-3-progress.md).
Este documento conserva el diseño revisado previamente. Estado de ejecución y pruebas: [messaging-postman.md](messaging-postman.md).

## Infraestructura y código encontrados

No hay dependencias Redis/BullMQ, colas, workers ni módulos de mensajería registrados en package.json/AppModule. Tampoco configuración Redis en .env.example. Esto no determina si el usuario tiene un servidor Redis externo instalado.

Customer conserva nombres/contactos, normalizedPhone/normalizedEmail únicos, sourceChannel, estado y fechas; no se copiarán esos datos a Conversation.
CustomersService está exportado. findOrCreateByContact normaliza, resuelve coincidencias, rechaza identidades ambiguas y actualiza lastContactAt en clientes existentes. touchLastContact no hace retroceder la fecha. Ambos abren actualmente su propia transacción Serializable.
normalizeContact reutiliza libphonenumber-js y exige teléfono normalizable o email válido. No se asumirá país automáticamente ni se inventarán contactos para identidades sociales.
ContactChannel: WHATSAPP, FACEBOOK, INSTAGRAM, WEBSITE, PHONE, EMAIL, OTHER. RoleCode: ADMIN, OWNER, OPERATOR, SUPPORT.

## Decisiones de alcance

- Una cuenta receptora por canal en esta fase, sin administración multicuenta. Una conversación persistente por Customer+Channel. Antes de conectar más de una cuenta por canal se revisará esta identidad.
- Lectura compartida por equipo, no recibos individuales. readAt nunca significa lectura del cliente/proveedor.
- Sin ConversationStatus ni endpoint cerrar/reabrir: no hay flujo aprobado para ello.
- Fechas nuevas Timestamptz(3), UTC. receivedAt es recepción del servidor; occurredAt conserva opcionalmente fecha declarada por proveedor. lastMessageAt usa recepción y nunca retrocede.
- Secuencia por conversación para historial estable y corte de lectura; no es código público. Se asigna incrementando lastSequence dentro de la transacción de ingestión.
- INBOUND funcional. OUTBOUND solo modelo/contrato en esta fase: no cola que finja enviar, no SENT sin proveedor.
- TEXT requiere contenido no vacío; IMAGE/FILE requieren metadata de adjunto. OTHER exige contenido o adjunto. Límites propuestos: contenido 16 000 caracteres, máximo 10 adjuntos, identificador externo 255, URL 2048, tamaño por adjunto 0..2 147 483 647 bytes.
- No descargar URLs. No subir archivos. No binarios ni payload completo del proveedor en BD/Redis/logs.
- Asignación y pausa independientes. ADMIN administra asignación; OPERATOR toma libre, conserva la propia o se desasigna. No transfiere a otros operadores. OWNER solo lee, SUPPORT no accede.

## Schema exacto propuesto

Se añadirán estas relaciones a los modelos existentes, sin reemplazarlos:

```prisma
// Dentro de User:
assignedConversations Conversation[] @relation("ConversationAssignee")
authoredMessages      Message[]      @relation("MessageAuthor")

// Dentro de Customer:
conversations Conversation[]
```

Modelos y enums nuevos:

```prisma
enum MessageDirection {
  INBOUND
  OUTBOUND
}

enum MessageStatus {
  RECEIVED
  PROCESSING
  PROCESSED
  QUEUED
  SENDING
  SENT
  FAILED
}

enum MessageType {
  TEXT
  IMAGE
  FILE
  OTHER
}

enum MessagingOutboxStatus {
  PENDING
  PUBLISHED
  COMPLETED
  FAILED
}

model Conversation {
  id                     String         @id @default(uuid())
  customerId             String
  channel                ContactChannel
  externalConversationId String?        @db.VarChar(255)
  isAssistantPaused      Boolean        @default(false)
  assignedUserId         String?
  lastMessageAt          DateTime?      @db.Timestamptz(3)
  lastSequence           Int            @default(0)
  createdAt              DateTime       @default(now()) @db.Timestamptz(3)
  updatedAt              DateTime       @updatedAt @db.Timestamptz(3)
  customer               Customer       @relation(fields: [customerId], references: [id], onDelete: Restrict)
  assignedUser           User?          @relation("ConversationAssignee", fields: [assignedUserId], references: [id], onDelete: SetNull)
  messages               Message[]

  @@unique([customerId, channel])
  // Necesario como destino de FK compuesta para impedir Message.channel distinto.
  @@unique([id, channel])
  @@index([channel, lastMessageAt, id])
  @@index([lastMessageAt, id])
  @@index([assignedUserId, lastMessageAt, id])
  @@map("conversations")
}

model Message {
  id              String           @id @default(uuid())
  conversationId  String
  channel         ContactChannel
  sequence        Int
  externalMessageId String?        @db.VarChar(255)
  direction       MessageDirection
  status          MessageStatus
  type            MessageType
  content         String?          @db.Text
  authorUserId    String?
  occurredAt      DateTime?        @db.Timestamptz(3)
  receivedAt      DateTime?        @db.Timestamptz(3)
  processedAt     DateTime?        @db.Timestamptz(3)
  sentAt          DateTime?        @db.Timestamptz(3)
  failedAt        DateTime?        @db.Timestamptz(3)
  readAt          DateTime?        @db.Timestamptz(3)
  processingAttempts Int          @default(0)
  processingToken String?         @db.VarChar(36)
  processingUntil DateTime?       @db.Timestamptz(3)
  errorCode       String?         @db.VarChar(80)
  errorReason     String?         @db.VarChar(300)
  createdAt       DateTime        @default(now()) @db.Timestamptz(3)
  updatedAt       DateTime        @updatedAt @db.Timestamptz(3)
  conversation    Conversation    @relation(fields: [conversationId, channel], references: [id, channel], onDelete: Restrict)
  author          User?           @relation("MessageAuthor", fields: [authorUserId], references: [id], onDelete: Restrict)
  attachments     MessageAttachment[]
  outbox          MessagingOutbox?

  @@unique([channel, externalMessageId])
  @@unique([conversationId, sequence])
  @@index([conversationId, direction, readAt])
  @@index([status, processingUntil])
  @@map("messages")
}

model MessageAttachment {
  id              String      @id @default(uuid())
  messageId       String
  type            MessageType
  fileName        String?     @db.VarChar(255)
  mimeType        String?     @db.VarChar(150)
  sizeBytes       Int?
  externalMediaId String?     @db.VarChar(255)
  url             String?     @db.VarChar(2048)
  createdAt       DateTime    @default(now()) @db.Timestamptz(3)
  message         Message     @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@index([messageId])
  @@map("message_attachments")
}

model MessagingOutbox {
  id              String                @id @default(uuid())
  messageId       String                @unique
  status          MessagingOutboxStatus @default(PENDING)
  publishAttempts Int                   @default(0)
  availableAt     DateTime              @default(now()) @db.Timestamptz(3)
  publishedAt     DateTime?             @db.Timestamptz(3)
  completedAt     DateTime?             @db.Timestamptz(3)
  leaseToken      String?               @db.VarChar(36)
  leaseUntil      DateTime?             @db.Timestamptz(3)
  lastErrorCode   String?               @db.VarChar(80)
  createdAt       DateTime              @default(now()) @db.Timestamptz(3)
  updatedAt       DateTime              @updatedAt @db.Timestamptz(3)
  message         Message               @relation(fields: [messageId], references: [id], onDelete: Restrict)

  @@index([status, availableAt, leaseUntil])
  @@map("messaging_outbox")
}
```

Un evento de procesamiento inbound por mensaje; messageId único evita múltiples outboxes. No se añade eventType anticipando eventos todavía inexistentes.

La migración incluirá CHECKs para secuencias positivas, contadores/tamaños no negativos, dirección/estado coherentes, readAt solo INBOUND y tipo de adjunto IMAGE/FILE/OTHER. No se deduce corrección solo de validadores TypeScript. Los límites de contenido y metadata se validan también al ingresar comandos internos, no únicamente mediante ValidationPipe HTTP.

Restrict conserva Customer, Conversation, mensajes y autoría. Cascade solo limpia metadata al eliminar explícitamente Message fuera de la API; no habrá DELETE público. Las restricciones sí se prueban mediante SQL aislado aunque no exista DELETE HTTP.

## Ingestión transaccional e idempotencia

1. Validar en runtime InboundMessageCommand; tipo TS por sí solo no valida. Exigir externalMessageId para ingestión externa, dirección/estado determinados por servidor.
2. Normalizar con funciones existentes. Buscar clave canal+externalMessageId antes de tocar contacto.
3. Si existe: devolver su ID sin efectos. Si la identidad de contacto es incompatible, devolver conflicto seguro; no reasignar ni sobrescribir el original.
4. Una única transacción Serializable engloba resolución de Customer, Conversation, secuencia, Message RECEIVED, metadata y Outbox PENDING.
5. Adaptar findOrCreateByContact/touchLastContact para aceptar contexto transaccional opcional, reutilizando su implementación. El consumidor actual sin contexto mantiene su contrato. No anidar transacciones ni duplicar touch.
6. Customer/Conversation concurrentes: uniques y reintento completo acotado. Ante P2002 de mensaje, rollback y lectura del registro ganador fuera de la transacción abortada. No tratar cualquier P2002 como mensaje duplicado.
7. Commit antes de publicar en Redis. La confirmación de ingestión significa persistencia durable, no procesamiento terminado.

## Redis, outbox y recuperación exacta

Agregar configuración centralizada Redis/BullMQ; no conexión a proveedor externo. Conexiones técnicas de workers permitidas. REDIS_URL no se imprime. API y worker con configuración explícita; apagar mensajería para pruebas antiguas no contará como evidencia de funcionamiento.

Dispatcher periódico (también al arrancar) reclama lotes mediante actualización atómica de leaseToken/leaseUntil. Solo el propietario vigente puede confirmar publicación. Publica messaging-inbound con jobId inbound-MESSAGE_UUID y payload { messageId }. Ninguna llamada a Redis dentro de una transacción SQL abierta.

PUBLISHED significa encolado, nunca procesado. Si Redis cae, permanece recuperable. Si se publicó y el dispatcher cayó antes de registrar PUBLISHED, republicar mismo ID no duplica efectos.

Reconciliación periódica revisa pendientes vencidos, publicaciones sin trabajo efectivo y PROCESSING con lease expirado. No borra jobs activos para crear sustitutos. Si Redis perdió jobs, recrea solo mensajes no terminales conservando presupuesto persistente de intentos.

Un job determinístico ya fallido no se reanima con queue.add: recuperación debe inspeccionar estado y reintentar explícitamente o retirar/recrear solo si corresponde, nunca para mensajes FAILED/PROCESSED. Ningún evento COMPLETED o FAILED vuelve automáticamente a PENDING.

Worker reclama Message con token y vencimiento en operación atómica. Token actúa como fencing: un worker antiguo no puede confirmar efectos tras perder su lease. Confirmación PROCESSED y Outbox COMPLETED se realiza en la misma transacción que cualquier efecto interno futuro, verificando token vigente. En esta fase el procesamiento solo valida/prepara el registro persistido; no IA, envío ni reservas. Historial/contacto/unread se guardan en ingestión, no se repiten en worker.

Si proceso cae antes de commit, recuperación podrá repetir; si cae después del commit y antes del ACK, nueva ejecución no hace nada. Se garantiza efecto persistido idempotente, no ejecución única del job.

## Retries

- Procesamiento temporal: máximo 5 intentos persistidos por mensaje, backoff exponencial (base 1 s, tope configurable). BullMQ acompaña esa política, no sustituye el contador durable.
- Validación definitiva/relación imposible: FAILED inmediato, código seguro, sin payload/stack. Outbox FAILED conserva trazabilidad.
- Caída de Redis al publicar: no consume intentos de procesamiento. Dispatcher espacia comprobaciones (tope 60 s), conserva pendiente y emite señal técnica por antigüedad. Puede esperar recuperación indefinidamente sin descartar el mensaje; no es retry infinito del procesamiento.
- Mensajes FAILED requieren decisión de recuperación interna explícita futura; no habrá endpoint de reintento público en esta fase.
- Lease propuesto 60 s, renovable para procesamiento legítimamente largo; pruebas con reloj controlado. Shutdown detiene dispatcher y cierra worker/conexiones.

## Bandeja, historial y lectura

GET /conversations: filtros channel, customerId, assignedUserId, unreadOnly, isAssistantPaused, search, page, limit. Sin status porque no se propone ConversationStatus.
Orden lastMessageAt DESC NULLS LAST, id DESC. Contar INBOUND/readAt null mediante consulta agregada/relación filtrada; no contador duplicado ni N+1 por conversación.
search solo campos de Customer por ahora, sin buscar texto completo de mensajes.
page 1..1 000 000; limit 1..100. Historial default 50, sequence DESC. Secuencia/id se exponen; frontend puede invertir la página para mostrarla cronológicamente.

PATCH read exige { throughMessageId: UUID } del último mensaje que la interfaz realmente mostró. Verifica pertenencia a conversación, toma su sequence y actualiza solo INBOUND con readAt null y sequence <= corte. Una inserción posterior no queda leída. Actualización/ingestión se serializan con la misma conversación para respetar el corte. Lectura idempotente y compartida. No mark-read implícito en GET.

## Endpoints y RBAC

| Método/ruta | ADMIN | OWNER | OPERATOR | SUPPORT |
| --- | --- | --- | --- | --- |
| GET /conversations | Sí | Sí | Sí | No |
| GET /conversations/:id | Sí | Sí | Sí | No |
| GET /conversations/:id/messages | Sí | Sí | Sí | No |
| PATCH /conversations/:id/read | Sí | No | Sí | No |
| PATCH /conversations/:id/assistant | Sí | No | Sí | No |
| PATCH /conversations/:id/assignee | Sí | No | Sí, con regla propia | No |

assistant: { paused: boolean }. assignee: { assignedUserId: UUID|null }, requerido; omisión no desasigna.
Asignado activo con ADMIN/OPERATOR. Detalle seguro con isEligible; desactivación conserva relación y señala inelegibilidad.
No endpoint HTTP de ingestión ni envío simulado. Adaptador mínimo: contrato para transformar entrada autenticada a comando; capacidades outbound/media se implementarán al integrar el proveedor, no adaptadores vacíos.

## Verificación y pasos después de aprobación

1. Confirmar diseño y acceso a Redis de desarrollo/pruebas (local/WSL o servicio autorizado; Docker no obligatorio).
2. Registrar baseline de build/tests y preservar cambios previos; instalar dependencias compatibles con versiones fijadas.
3. Integrar schema, format/validate, revisar SQL aditivo antes de aplicar. Nunca reset; si hay drift o migraciones pendientes inesperadas, detener y reportar. Generate explícito.
4. Implementar persistencia/API y después dispatcher/worker.
5. Pruebas de concurrencia real: diez ingestiones iguales, dos workers/dispatchers, caída antes/después de publicar y ACK, pérdida de cola, lease vencido, agotamiento de intentos, lectura concurrente y fechas fuera de orden.
6. Pruebas PostgreSQL+Redis aisladas. Caída simulada del adaptador no sustituye todas las pruebas Redis reales. No apagar servidores compartidos ni usar FLUSHALL.
7. Regresión Sprint 1/2, lint de archivos cambiados y documentación/Postman con tooling interno seguro de fixtures.
8. No declarar cerrada Fase 1 si no se verificaron Redis y recuperación. No declarar Módulo 6 completo.

Base documental revisada: Prisma Client transactions y Prisma CLI migrate-dev (skills locales). Decisiones de transacciones cortas, rollback y revisión previa de migración siguen esas guías.
Referencias BullMQ: https://docs.bullmq.io/guide/jobs/job-ids , https://docs.bullmq.io/guide/connections , https://docs.bullmq.io/patterns/idempotent-jobs .

## Punto de aprobación

El usuario aprobó este diseño antes de modificar schema.prisma/migrar, incluyendo cuenta única por canal, lectura compartida con corte obligatorio y permisos de autoasignación del OPERATOR. La migración aplicada es 20260923060201_add_messaging_core.
