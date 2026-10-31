-- Additive only. Apply to the CRM database separately after review.
CREATE TYPE "SamantaDraftStatus" AS ENUM ('GENERATING', 'READY', 'APPROVED', 'REJECTED', 'STALE', 'FAILED');
CREATE TABLE "samanta_drafts" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "baselineSequence" INTEGER NOT NULL,
  "idempotencyKey" VARCHAR(80) NOT NULL,
  "createdById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "editedById" TEXT,
  "status" "SamantaDraftStatus" NOT NULL DEFAULT 'GENERATING',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "model" VARCHAR(80) NOT NULL,
  "promptVersion" VARCHAR(80) NOT NULL,
  "knowledgeHash" VARCHAR(64) NOT NULL,
  "originalContent" TEXT,
  "content" TEXT,
  "intent" VARCHAR(20),
  "requiresHuman" BOOLEAN NOT NULL DEFAULT true,
  "missingFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "errorCode" VARCHAR(80),
  "generationExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "reviewedAt" TIMESTAMPTZ(3),
  "outboundMessageId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "samanta_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "samanta_drafts_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "samanta_drafts_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "samanta_drafts_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "samanta_drafts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "samanta_drafts_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "samanta_drafts_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "samanta_drafts_counts_check" CHECK ("revision" > 0 AND "baselineSequence" > 0 AND "inputTokens" >= 0 AND "outputTokens" >= 0),
  CONSTRAINT "samanta_drafts_content_check" CHECK (char_length("content") <= 4096 AND char_length("originalContent") <= 4096 AND ("status" NOT IN ('READY', 'APPROVED') OR ("content" IS NOT NULL AND char_length(btrim("content")) > 0))),
  CONSTRAINT "samanta_drafts_review_check" CHECK (("status" = 'APPROVED') = ("outboundMessageId" IS NOT NULL) AND ("status" NOT IN ('APPROVED', 'REJECTED') OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)))
);
CREATE UNIQUE INDEX "samanta_drafts_outboundMessageId_key" ON "samanta_drafts"("outboundMessageId");
CREATE UNIQUE INDEX "samanta_drafts_conversationId_idempotencyKey_key" ON "samanta_drafts"("conversationId", "idempotencyKey");
CREATE INDEX "samanta_drafts_conversationId_createdAt_id_idx" ON "samanta_drafts"("conversationId", "createdAt", "id");
CREATE INDEX "samanta_drafts_createdAt_idx" ON "samanta_drafts"("createdAt");
CREATE INDEX "samanta_drafts_status_generationExpiresAt_idx" ON "samanta_drafts"("status", "generationExpiresAt");
