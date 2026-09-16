-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('NEW', 'INTERESTED', 'IN_CONVERSATION', 'REQUESTED_RESERVATION', 'CONFIRMED', 'REJECTED', 'LOST', 'RECURRENT');

-- CreateEnum
CREATE TYPE "ContactChannel" AS ENUM ('WHATSAPP', 'FACEBOOK', 'INSTAGRAM', 'WEBSITE', 'PHONE', 'EMAIL', 'OTHER');

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "firstName" VARCHAR(100),
    "lastName" VARCHAR(100),
    "phone" VARCHAR(80),
    "phoneCountry" VARCHAR(2),
    "normalizedPhone" VARCHAR(16),
    "email" VARCHAR(320),
    "normalizedEmail" VARCHAR(320),
    "sourceChannel" "ContactChannel" NOT NULL,
    "status" "CustomerStatus" NOT NULL DEFAULT 'NEW',
    "firstContactAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastContactAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customers_contact_check" CHECK (
        "normalizedPhone" IS NOT NULL OR "normalizedEmail" IS NOT NULL
    ),
    CONSTRAINT "customers_phone_check" CHECK (
        ("phone" IS NULL OR LENGTH(BTRIM("phone")) > 0)
        AND ("normalizedPhone" IS NULL OR
          ("phone" IS NOT NULL AND "normalizedPhone" ~ '^\+[1-9][0-9]{1,14}$'))
        AND ("phoneCountry" IS NULL OR
          ("phone" IS NOT NULL AND "phoneCountry" ~ '^[A-Z]{2}$'))
    ),
    CONSTRAINT "customers_email_check" CHECK (
        ("email" IS NULL AND "normalizedEmail" IS NULL)
        OR ("email" IS NOT NULL AND "normalizedEmail" IS NOT NULL
            AND LENGTH(BTRIM("email")) > 0
            AND "normalizedEmail" = LOWER(BTRIM("email")))
    ),
    CONSTRAINT "customers_contact_dates_check" CHECK ("lastContactAt" >= "firstContactAt")
);

-- CreateTable
CREATE TABLE "customer_interests" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "commercialItemId" TEXT NOT NULL,
    "firstInterestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInterestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "customer_interests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_interests_dates_check" CHECK ("lastInterestedAt" >= "firstInterestedAt")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_normalizedPhone_key" ON "customers"("normalizedPhone");

-- CreateIndex
CREATE UNIQUE INDEX "customers_normalizedEmail_key" ON "customers"("normalizedEmail");

-- CreateIndex
CREATE INDEX "customers_status_idx" ON "customers"("status");

-- CreateIndex
CREATE INDEX "customers_sourceChannel_idx" ON "customers"("sourceChannel");

-- CreateIndex
CREATE INDEX "customers_lastContactAt_id_idx" ON "customers"("lastContactAt", "id");

-- CreateIndex
CREATE INDEX "customers_createdAt_idx" ON "customers"("createdAt");

-- CreateIndex
CREATE INDEX "customer_interests_commercialItemId_idx" ON "customer_interests"("commercialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_interests_customerId_commercialItemId_key" ON "customer_interests"("customerId", "commercialItemId");

-- AddForeignKey
ALTER TABLE "customer_interests" ADD CONSTRAINT "customer_interests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_interests" ADD CONSTRAINT "customer_interests_commercialItemId_fkey" FOREIGN KEY ("commercialItemId") REFERENCES "commercial_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
