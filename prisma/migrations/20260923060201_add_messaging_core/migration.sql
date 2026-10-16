-- CreateEnum
BEGIN;

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'QUEUED', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'FILE', 'OTHER');

-- CreateEnum
CREATE TYPE "MessagingOutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" "ContactChannel" NOT NULL,
    "externalConversationId" VARCHAR(255),
    "isAssistantPaused" BOOLEAN NOT NULL DEFAULT false,
    "assignedUserId" TEXT,
    "lastMessageAt" TIMESTAMPTZ(3),
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channel" "ContactChannel" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "externalMessageId" VARCHAR(255),
    "direction" "MessageDirection" NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "type" "MessageType" NOT NULL,
    "content" TEXT,
    "authorUserId" TEXT,
    "occurredAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "processedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "readAt" TIMESTAMPTZ(3),
    "processingAttempts" INTEGER NOT NULL DEFAULT 0,
    "processingToken" VARCHAR(36),
    "processingUntil" TIMESTAMPTZ(3),
    "errorCode" VARCHAR(80),
    "errorReason" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "MessageType" NOT NULL,
    "fileName" VARCHAR(255),
    "mimeType" VARCHAR(150),
    "sizeBytes" INTEGER,
    "externalMediaId" VARCHAR(255),
    "url" VARCHAR(2048),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging_outbox" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" "MessagingOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "leaseToken" VARCHAR(36),
    "leaseUntil" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(80),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messaging_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_channel_lastMessageAt_id_idx" ON "conversations"("channel", "lastMessageAt", "id");

-- CreateIndex
CREATE INDEX "conversations_lastMessageAt_id_idx" ON "conversations"("lastMessageAt", "id");

-- CreateIndex
CREATE INDEX "conversations_assignedUserId_lastMessageAt_id_idx" ON "conversations"("assignedUserId", "lastMessageAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_customerId_channel_key" ON "conversations"("customerId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_id_channel_key" ON "conversations"("id", "channel");

-- CreateIndex
CREATE INDEX "messages_conversationId_direction_readAt_idx" ON "messages"("conversationId", "direction", "readAt");

-- CreateIndex
CREATE INDEX "messages_status_processingUntil_idx" ON "messages"("status", "processingUntil");

-- CreateIndex
CREATE UNIQUE INDEX "messages_channel_externalMessageId_key" ON "messages"("channel", "externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversationId_sequence_key" ON "messages"("conversationId", "sequence");

-- CreateIndex
CREATE INDEX "message_attachments_messageId_idx" ON "message_attachments"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_outbox_messageId_key" ON "messaging_outbox"("messageId");

-- CreateIndex
CREATE INDEX "messaging_outbox_status_availableAt_leaseUntil_idx" ON "messaging_outbox"("status", "availableAt", "leaseUntil");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_channel_fkey" FOREIGN KEY ("conversationId", "channel") REFERENCES "conversations"("id", "channel") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging_outbox" ADD CONSTRAINT "messaging_outbox_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "conversations" ADD CONSTRAINT "conversation_sequence_nonnegative" CHECK ("lastSequence" >= 0);
ALTER TABLE "messages" ADD CONSTRAINT "message_sequence_positive" CHECK ("sequence" > 0);
ALTER TABLE "messages" ADD CONSTRAINT "message_attempts_range" CHECK ("processingAttempts" BETWEEN 0 AND 5);
ALTER TABLE "messages" ADD CONSTRAINT "message_direction_status" CHECK (
  ("direction" = 'INBOUND' AND "status" IN ('RECEIVED','PROCESSING','PROCESSED','FAILED') AND "receivedAt" IS NOT NULL AND "authorUserId" IS NULL AND "sentAt" IS NULL)
  OR ("direction" = 'OUTBOUND' AND "status" IN ('QUEUED','SENDING','SENT','FAILED') AND "readAt" IS NULL)
);
ALTER TABLE "messages" ADD CONSTRAINT "message_processing_lease" CHECK (
  ("status" = 'PROCESSING' AND "processingToken" IS NOT NULL AND "processingUntil" IS NOT NULL)
  OR ("status" <> 'PROCESSING' AND "processingToken" IS NULL AND "processingUntil" IS NULL)
);
ALTER TABLE "messages" ADD CONSTRAINT "message_terminal_timestamps" CHECK (
  ("status" <> 'PROCESSED' OR "processedAt" IS NOT NULL) AND
  ("status" <> 'SENT' OR "sentAt" IS NOT NULL) AND
  ("status" <> 'FAILED' OR "failedAt" IS NOT NULL)
);
ALTER TABLE "messages" ADD CONSTRAINT "message_content_valid" CHECK (
  ("content" IS NULL OR (length(btrim("content")) > 0 AND length("content") <= 16000)) AND
  ("type" <> 'TEXT' OR "content" IS NOT NULL) AND
  ("externalMessageId" IS NULL OR length(btrim("externalMessageId")) > 0)
);
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachment_valid" CHECK (
  "type" IN ('IMAGE','FILE','OTHER') AND ("sizeBytes" IS NULL OR "sizeBytes" >= 0) AND
  (NULLIF(btrim("externalMediaId"), '') IS NOT NULL OR NULLIF(btrim("url"), '') IS NOT NULL)
);
ALTER TABLE "messaging_outbox" ADD CONSTRAINT "outbox_attempts_nonnegative" CHECK ("publishAttempts" >= 0);
ALTER TABLE "messaging_outbox" ADD CONSTRAINT "outbox_lease_pair" CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL));
COMMIT;
