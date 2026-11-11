-- M9.2: the owner's WhatsApp answers are tied to the request they answer. An inbound
-- message keeps the WhatsApp message it quotes or answers with a button (context.id) and
-- whether it was a button tap; an owner's answer also keeps what the backend did with it.
-- Additive: existing rows get NULL / false and do not change.
ALTER TABLE "messages" ADD COLUMN "replyToExternalMessageId" VARCHAR(255),
ADD COLUMN "isButtonReply" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "ownerReplyOutcome" VARCHAR(40);

-- Only inbound messages answer something or carry an owner's decision.
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_inbound_check" CHECK (
  "direction" = 'INBOUND' OR (
    "replyToExternalMessageId" IS NULL AND "isButtonReply" = false AND "ownerReplyOutcome" IS NULL
  )
);
