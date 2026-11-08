-- Samanta replies on her own: an inbound text schedules an AUTO draft that a background
-- worker generates and sends. Additive: existing drafts become MANUAL and keep their data.
-- 'SCHEDULED' is not used below: a new enum value cannot be used in the same transaction.
ALTER TYPE "SamantaDraftStatus" ADD VALUE 'SCHEDULED' BEFORE 'GENERATING';
CREATE TYPE "SamantaDraftMode" AS ENUM ('MANUAL', 'AUTO');
CREATE TYPE "AssistantPauseReason" AS ENUM ('MANUAL', 'OPERATOR_REPLIED', 'SAMANTA_HANDOFF');

-- A scheduled draft has not started generating yet, so it has no generation deadline.
-- The daily limit counts generationStartedAt, not createdAt: a superseded scheduled
-- draft never reached OpenAI.
ALTER TABLE "samanta_drafts" ADD COLUMN "mode" "SamantaDraftMode" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "availableAt" TIMESTAMPTZ(3),
  ADD COLUMN "generationStartedAt" TIMESTAMPTZ(3),
  ALTER COLUMN "generationExpiresAt" DROP NOT NULL;
UPDATE "samanta_drafts" SET "generationStartedAt" = "createdAt";
CREATE INDEX "samanta_drafts_mode_status_availableAt_idx" ON "samanta_drafts"("mode", "status", "availableAt");
CREATE INDEX "samanta_drafts_generationStartedAt_idx" ON "samanta_drafts"("generationStartedAt");
CREATE INDEX "samanta_drafts_conversationId_generationStartedAt_idx" ON "samanta_drafts"("conversationId", "generationStartedAt");

-- Why Samanta stopped attending a conversation. Existing pauses were set by hand.
ALTER TABLE "conversations" ADD COLUMN "assistantPauseReason" "AssistantPauseReason",
  ADD COLUMN "assistantPausedAt" TIMESTAMPTZ(3);
UPDATE "conversations" SET "assistantPauseReason" = 'MANUAL', "assistantPausedAt" = "updatedAt"
WHERE "isAssistantPaused";

-- System user that signs automatic replies (SAMANTA_USER_ID). Inactive and without roles:
-- it cannot log in, be assigned or reset its password; '!' is not a bcrypt hash.
INSERT INTO "users" ("id", "firstName", "lastName", "email", "passwordHash", "isActive", "createdAt", "updatedAt")
VALUES ('00000000-0000-4000-8000-00000000a0a1', 'Samanta', 'IA', 'samanta@sistema.invalid', '!', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
