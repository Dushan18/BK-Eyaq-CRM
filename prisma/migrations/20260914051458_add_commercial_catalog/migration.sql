-- CreateEnum
CREATE TYPE "CommercialItemType" AS ENUM ('DISH', 'BEVERAGE', 'SERVICE', 'PROMOTION', 'EVENT');

-- CreateEnum
CREATE TYPE "CommercialApprovalStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "commercial_categories" (
    "id" TEXT NOT NULL,
    "sourceKey" VARCHAR(120),
    "nameEs" VARCHAR(150),
    "nameEn" VARCHAR(150),
    "normalizedNameEs" VARCHAR(150),
    "normalizedNameEn" VARCHAR(150),
    "descriptionEs" TEXT,
    "descriptionEn" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commercial_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_categories_name_check" CHECK (
        NULLIF(BTRIM("nameEs"), '') IS NOT NULL
        OR NULLIF(BTRIM("nameEn"), '') IS NOT NULL
    ),
    CONSTRAINT "commercial_categories_normalized_names_check" CHECK (
        ("nameEs" IS NULL) = ("normalizedNameEs" IS NULL)
        AND ("nameEn" IS NULL) = ("normalizedNameEn" IS NULL)
        AND ("normalizedNameEs" IS NULL OR NULLIF(BTRIM("normalizedNameEs"), '') IS NOT NULL)
        AND ("normalizedNameEn" IS NULL OR NULLIF(BTRIM("normalizedNameEn"), '') IS NOT NULL)
    ),
    CONSTRAINT "commercial_categories_display_order_check" CHECK ("displayOrder" >= 0),
    CONSTRAINT "commercial_categories_source_key_check" CHECK (
        "sourceKey" IS NULL OR NULLIF(BTRIM("sourceKey"), '') IS NOT NULL
    )
);

-- CreateTable
CREATE TABLE "commercial_items" (
    "id" TEXT NOT NULL,
    "sourceKey" VARCHAR(160),
    "type" "CommercialItemType" NOT NULL,
    "categoryId" TEXT NOT NULL,
    "nameEs" VARCHAR(200),
    "nameEn" VARCHAR(200),
    "normalizedName" VARCHAR(200) NOT NULL,
    "descriptionEs" TEXT,
    "descriptionEn" TEXT,
    "basePrice" DECIMAL(10,2),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "approvalStatus" "CommercialApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "conditions" TEXT,
    "internalNotes" TEXT,
    "availabilityNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commercial_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_items_name_check" CHECK (
        NULLIF(BTRIM("nameEs"), '') IS NOT NULL
        OR NULLIF(BTRIM("nameEn"), '') IS NOT NULL
    ),
    CONSTRAINT "commercial_items_normalized_name_check" CHECK (
        NULLIF(BTRIM("normalizedName"), '') IS NOT NULL
    ),
    CONSTRAINT "commercial_items_approved_spanish_name_check" CHECK (
        "approvalStatus" <> 'APPROVED'
        OR NULLIF(BTRIM("nameEs"), '') IS NOT NULL
    ),
    CONSTRAINT "commercial_items_base_price_check" CHECK (
        "basePrice" IS NULL OR "basePrice" >= 0
    ),
    CONSTRAINT "commercial_items_display_order_check" CHECK ("displayOrder" >= 0),
    CONSTRAINT "commercial_items_source_key_check" CHECK (
        "sourceKey" IS NULL OR NULLIF(BTRIM("sourceKey"), '') IS NOT NULL
    )
);

-- CreateTable
CREATE TABLE "commercial_item_variants" (
    "id" TEXT NOT NULL,
    "commercialItemId" TEXT NOT NULL,
    "nameEs" VARCHAR(150),
    "nameEn" VARCHAR(150),
    "normalizedName" VARCHAR(150) NOT NULL,
    "descriptionEs" TEXT,
    "descriptionEn" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commercial_item_variants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_item_variants_name_check" CHECK (
        NULLIF(BTRIM("nameEs"), '') IS NOT NULL
        OR NULLIF(BTRIM("nameEn"), '') IS NOT NULL
    ),
    CONSTRAINT "commercial_item_variants_normalized_name_check" CHECK (
        NULLIF(BTRIM("normalizedName"), '') IS NOT NULL
    ),
    CONSTRAINT "commercial_item_variants_price_check" CHECK ("price" >= 0),
    CONSTRAINT "commercial_item_variants_display_order_check" CHECK ("displayOrder" >= 0)
);

-- CreateTable
CREATE TABLE "commercial_item_images" (
    "id" TEXT NOT NULL,
    "commercialItemId" TEXT NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "altTextEs" VARCHAR(300),
    "altTextEn" VARCHAR(300),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commercial_item_images_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_item_images_url_check" CHECK (
        NULLIF(BTRIM("url"), '') IS NOT NULL
    ),
    CONSTRAINT "commercial_item_images_display_order_check" CHECK ("displayOrder" >= 0)
);

-- CreateTable
CREATE TABLE "commercial_item_faqs" (
    "id" TEXT NOT NULL,
    "commercialItemId" TEXT NOT NULL,
    "questionEs" VARCHAR(500) NOT NULL,
    "questionEn" VARCHAR(500),
    "answerEs" TEXT NOT NULL,
    "answerEn" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commercial_item_faqs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_item_faqs_content_check" CHECK (
        NULLIF(BTRIM("questionEs"), '') IS NOT NULL
        AND NULLIF(BTRIM("answerEs"), '') IS NOT NULL
        AND ("questionEn" IS NULL OR NULLIF(BTRIM("questionEn"), '') IS NOT NULL)
        AND ("answerEn" IS NULL OR NULLIF(BTRIM("answerEn"), '') IS NOT NULL)
    ),
    CONSTRAINT "commercial_item_faqs_display_order_check" CHECK ("displayOrder" >= 0)
);

-- CreateTable
CREATE TABLE "commercial_item_schedules" (
    "id" TEXT NOT NULL,
    "commercialItemId" TEXT NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT false,
    "startTime" VARCHAR(5),
    "endTime" VARCHAR(5),

    CONSTRAINT "commercial_item_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "commercial_item_schedules_time_check" CHECK (
        (
            "isAvailable" = false
            AND "startTime" IS NULL
            AND "endTime" IS NULL
        )
        OR
        (
            "isAvailable" = true
            AND "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND "startTime" <> "endTime"
        )
    )
);

-- CreateTable
CREATE TABLE "promotion_details" (
    "id" TEXT NOT NULL,
    "commercialItemId" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "promotionalPrice" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotion_details_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "promotion_details_price_check" CHECK (
        "promotionalPrice" IS NULL OR "promotionalPrice" >= 0
    ),
    CONSTRAINT "promotion_details_dates_check" CHECK (
        "validFrom" IS NULL OR "validUntil" IS NULL OR "validFrom" <= "validUntil"
    )
);

-- CreateTable
CREATE TABLE "event_details" (
    "id" TEXT NOT NULL,
    "commercialItemId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "capacity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_details_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "event_details_capacity_check" CHECK (
        "capacity" IS NULL OR "capacity" >= 1
    ),
    CONSTRAINT "event_details_dates_check" CHECK (
        "startAt" IS NULL OR "endAt" IS NULL OR "startAt" <= "endAt"
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "commercial_categories_sourceKey_key" ON "commercial_categories"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_categories_normalizedNameEs_key" ON "commercial_categories"("normalizedNameEs");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_categories_normalizedNameEn_key" ON "commercial_categories"("normalizedNameEn");

-- CreateIndex
CREATE INDEX "commercial_categories_isActive_displayOrder_idx" ON "commercial_categories"("isActive", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_items_sourceKey_key" ON "commercial_items"("sourceKey");

-- CreateIndex
CREATE INDEX "commercial_items_type_idx" ON "commercial_items"("type");

-- CreateIndex
CREATE INDEX "commercial_items_categoryId_displayOrder_idx" ON "commercial_items"("categoryId", "displayOrder");

-- CreateIndex
CREATE INDEX "commercial_items_isActive_idx" ON "commercial_items"("isActive");

-- CreateIndex
CREATE INDEX "commercial_items_approvalStatus_isActive_idx" ON "commercial_items"("approvalStatus", "isActive");

-- CreateIndex
CREATE INDEX "commercial_items_createdAt_idx" ON "commercial_items"("createdAt");

-- CreateIndex
CREATE INDEX "commercial_items_normalizedName_idx" ON "commercial_items"("normalizedName");

-- CreateIndex
CREATE INDEX "commercial_item_variants_commercialItemId_isActive_displayO_idx" ON "commercial_item_variants"("commercialItemId", "isActive", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_item_variants_commercialItemId_normalizedName_key" ON "commercial_item_variants"("commercialItemId", "normalizedName");

-- CreateIndex
CREATE INDEX "commercial_item_images_commercialItemId_displayOrder_idx" ON "commercial_item_images"("commercialItemId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_item_images_commercialItemId_url_key" ON "commercial_item_images"("commercialItemId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_item_images_one_primary_key" ON "commercial_item_images"("commercialItemId") WHERE ("isPrimary" = true);

-- CreateIndex
CREATE INDEX "commercial_item_faqs_commercialItemId_displayOrder_idx" ON "commercial_item_faqs"("commercialItemId", "displayOrder");

-- CreateIndex
CREATE INDEX "commercial_item_schedules_commercialItemId_idx" ON "commercial_item_schedules"("commercialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_item_schedules_commercialItemId_dayOfWeek_key" ON "commercial_item_schedules"("commercialItemId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_details_commercialItemId_key" ON "promotion_details"("commercialItemId");

-- CreateIndex
CREATE UNIQUE INDEX "event_details_commercialItemId_key" ON "event_details"("commercialItemId");

-- AddForeignKey
ALTER TABLE "commercial_items" ADD CONSTRAINT "commercial_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "commercial_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_item_variants" ADD CONSTRAINT "commercial_item_variants_commercialItemId_fkey" FOREIGN KEY ("commercialItemId") REFERENCES "commercial_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_item_images" ADD CONSTRAINT "commercial_item_images_commercialItemId_fkey" FOREIGN KEY ("commercialItemId") REFERENCES "commercial_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_item_faqs" ADD CONSTRAINT "commercial_item_faqs_commercialItemId_fkey" FOREIGN KEY ("commercialItemId") REFERENCES "commercial_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_item_schedules" ADD CONSTRAINT "commercial_item_schedules_commercialItemId_fkey" FOREIGN KEY ("commercialItemId") REFERENCES "commercial_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_details" ADD CONSTRAINT "promotion_details_commercialItemId_fkey" FOREIGN KEY ("commercialItemId") REFERENCES "commercial_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_details" ADD CONSTRAINT "event_details_commercialItemId_fkey" FOREIGN KEY ("commercialItemId") REFERENCES "commercial_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
