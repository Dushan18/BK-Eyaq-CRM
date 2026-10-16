BEGIN;
ALTER TABLE "messages"
  ADD COLUMN "deliveredAt" TIMESTAMPTZ(3),
  ADD COLUMN "providerReadAt" TIMESTAMPTZ(3),
  ADD COLUMN "idempotencyKey" VARCHAR(80),
  ADD COLUMN "recipientPhone" VARCHAR(16),
  ADD COLUMN "providerAccountId" VARCHAR(80);
CREATE UNIQUE INDEX "messages_conversationId_idempotencyKey_key" ON "messages"("conversationId", "idempotencyKey");
CREATE INDEX "messages_conversationId_direction_occurredAt_idx" ON "messages"("conversationId", "direction", "occurredAt");
ALTER TABLE "messages" DROP CONSTRAINT "message_direction_status";
ALTER TABLE "messages" ADD CONSTRAINT "message_direction_status" CHECK (
  ("direction" = 'INBOUND' AND "status" IN ('RECEIVED','PROCESSING','PROCESSED','FAILED') AND "receivedAt" IS NOT NULL AND "authorUserId" IS NULL AND "sentAt" IS NULL AND "deliveredAt" IS NULL AND "providerReadAt" IS NULL)
  OR ("direction" = 'OUTBOUND' AND "status" IN ('QUEUED','SENDING','SENT','DELIVERED','READ','UNKNOWN','FAILED') AND "readAt" IS NULL)
);
ALTER TABLE "messages" DROP CONSTRAINT "message_processing_lease";
ALTER TABLE "messages" ADD CONSTRAINT "message_processing_lease" CHECK (
  ("status" IN ('PROCESSING','SENDING') AND "processingToken" IS NOT NULL AND "processingUntil" IS NOT NULL)
  OR ("status" NOT IN ('PROCESSING','SENDING') AND "processingToken" IS NULL AND "processingUntil" IS NULL)
);
ALTER TABLE "messages" ADD CONSTRAINT "message_delivery_timestamps" CHECK (
  ("status" NOT IN ('DELIVERED','READ') OR ("sentAt" IS NOT NULL AND "deliveredAt" IS NOT NULL)) AND
  ("status" <> 'READ' OR "providerReadAt" IS NOT NULL)
);
CREATE TABLE "message_status_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channel" "ContactChannel" NOT NULL,
  "providerAccountId" VARCHAR(80) NOT NULL,
  "externalMessageId" VARCHAR(255) NOT NULL,
  "status" "MessageStatus" NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "processedAt" TIMESTAMPTZ(3),
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_status_valid" CHECK ("status" IN ('SENT','DELIVERED','READ','FAILED'))
);
CREATE UNIQUE INDEX "message_status_events_dedup_key" ON "message_status_events"("channel", "providerAccountId", "externalMessageId", "status", "occurredAt");
CREATE INDEX "message_status_events_processedAt_availableAt_idx" ON "message_status_events"("processedAt", "availableAt");
CREATE TABLE "messaging_webhook_rejections" (
  "fingerprint" VARCHAR(64) NOT NULL PRIMARY KEY,
  "code" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMIT;
