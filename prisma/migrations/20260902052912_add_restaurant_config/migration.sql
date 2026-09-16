-- CreateEnum
CREATE TYPE "RestaurantConfigScope" AS ENUM ('GLOBAL');

-- CreateEnum
CREATE TYPE "CurrencyCode" AS ENUM ('PEN', 'USD');

-- CreateEnum
CREATE TYPE "LanguageCode" AS ENUM ('ES', 'EN', 'PT');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateTable
CREATE TABLE "restaurant_configs" (
    "id" TEXT NOT NULL,
    "scope" "RestaurantConfigScope" NOT NULL DEFAULT 'GLOBAL',
    "businessName" VARCHAR(150) NOT NULL,
    "logoUrl" VARCHAR(2048),
    "description" TEXT,
    "address" VARCHAR(300) NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "whatsappNumber" VARCHAR(16) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "website" VARCHAR(2048),
    "currency" "CurrencyCode" NOT NULL DEFAULT 'PEN',
    "timeZone" VARCHAR(64) NOT NULL DEFAULT 'America/Lima',
    "reservationPolicy" TEXT NOT NULL,
    "cancellationPolicy" TEXT NOT NULL,
    "responseTimeoutMinutes" INTEGER NOT NULL,
    "approvalResponsibleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_configs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "restaurant_configs_coordinates_pair_check" CHECK (
        ("latitude" IS NULL AND "longitude" IS NULL)
        OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL)
    ),
    CONSTRAINT "restaurant_configs_latitude_range_check" CHECK (
        "latitude" IS NULL OR "latitude" BETWEEN -90 AND 90
    ),
    CONSTRAINT "restaurant_configs_longitude_range_check" CHECK (
        "longitude" IS NULL OR "longitude" BETWEEN -180 AND 180
    ),
    CONSTRAINT "restaurant_configs_response_timeout_check" CHECK (
        "responseTimeoutMinutes" BETWEEN 1 AND 1440
    )
);

-- CreateTable
CREATE TABLE "restaurant_schedules" (
    "restaurantConfigId" TEXT NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "isOpen" BOOLEAN NOT NULL DEFAULT false,
    "openTime" VARCHAR(5),
    "closeTime" VARCHAR(5),

    CONSTRAINT "restaurant_schedules_pkey" PRIMARY KEY ("restaurantConfigId","dayOfWeek"),
    CONSTRAINT "restaurant_schedules_time_coherence_check" CHECK (
        (
            "isOpen" = false
            AND "openTime" IS NULL
            AND "closeTime" IS NULL
        )
        OR
        (
            "isOpen" = true
            AND "openTime" IS NOT NULL
            AND "closeTime" IS NOT NULL
            AND "openTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND "closeTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND "openTime" < "closeTime"
        )
    )
);

-- CreateTable
CREATE TABLE "restaurant_languages" (
    "restaurantConfigId" TEXT NOT NULL,
    "language" "LanguageCode" NOT NULL,

    CONSTRAINT "restaurant_languages_pkey" PRIMARY KEY ("restaurantConfigId","language")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_configs_scope_key" ON "restaurant_configs"("scope");

-- CreateIndex
CREATE INDEX "restaurant_configs_approvalResponsibleId_idx" ON "restaurant_configs"("approvalResponsibleId");

-- AddForeignKey
ALTER TABLE "restaurant_configs" ADD CONSTRAINT "restaurant_configs_approvalResponsibleId_fkey" FOREIGN KEY ("approvalResponsibleId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_schedules" ADD CONSTRAINT "restaurant_schedules_restaurantConfigId_fkey" FOREIGN KEY ("restaurantConfigId") REFERENCES "restaurant_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_languages" ADD CONSTRAINT "restaurant_languages_restaurantConfigId_fkey" FOREIGN KEY ("restaurantConfigId") REFERENCES "restaurant_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
