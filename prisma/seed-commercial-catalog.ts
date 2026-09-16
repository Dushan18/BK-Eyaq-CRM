import type { PrismaClient } from '../generated/prisma/client';
import {
  COMMERCIAL_CATALOG_CATEGORIES,
  COMMERCIAL_CATALOG_ITEMS,
} from './data/commercial-catalog.data';

export const normalizeCommercialCatalogName = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('es-PE')
    .replace(/\s+/g, ' ');

export async function seedCommercialCatalog(
  prisma: PrismaClient,
): Promise<void> {
  const categoryIds = new Map<string, string>();

  for (const category of COMMERCIAL_CATALOG_CATEGORIES) {
    const persistedCategory = await prisma.commercialCategory.upsert({
      where: {
        sourceKey: category.sourceKey,
      },
      update: {},
      create: {
        sourceKey: category.sourceKey,
        nameEs: category.nameEs,
        nameEn: category.nameEn,
        normalizedNameEs: category.nameEs
          ? normalizeCommercialCatalogName(category.nameEs)
          : null,
        normalizedNameEn: category.nameEn
          ? normalizeCommercialCatalogName(category.nameEn)
          : null,
        descriptionEs: category.descriptionEs,
        descriptionEn: category.descriptionEn,
        isActive: category.isActive,
        displayOrder: category.displayOrder,
      },
      select: {
        id: true,
      },
    });

    categoryIds.set(category.sourceKey, persistedCategory.id);
  }

  for (const catalogItem of COMMERCIAL_CATALOG_ITEMS) {
    const categoryId = categoryIds.get(catalogItem.categorySourceKey);

    if (!categoryId) {
      throw new Error(
        `La categoría ${catalogItem.categorySourceKey} no fue creada por el seed`,
      );
    }

    const displayName = catalogItem.nameEs ?? catalogItem.nameEn;

    if (!displayName) {
      throw new Error(
        `El item ${catalogItem.sourceKey} no contiene un nombre utilizable`,
      );
    }

    await prisma.commercialItem.upsert({
      where: {
        sourceKey: catalogItem.sourceKey,
      },
      update: {},
      create: {
        sourceKey: catalogItem.sourceKey,
        type: catalogItem.type,
        categoryId,
        nameEs: catalogItem.nameEs,
        nameEn: catalogItem.nameEn,
        normalizedName: normalizeCommercialCatalogName(displayName),
        descriptionEs: catalogItem.descriptionEs,
        descriptionEn: catalogItem.descriptionEn,
        basePrice: catalogItem.basePrice,
        displayOrder: catalogItem.displayOrder,
        isActive: catalogItem.isActive,
        approvalStatus: catalogItem.approvalStatus,
        conditions: catalogItem.conditions,
        internalNotes: catalogItem.internalNotes,
        availabilityNote: catalogItem.availabilityNote,
        variants:
          catalogItem.variants.length > 0
            ? {
                create: catalogItem.variants.map((catalogVariant) => {
                  const variantDisplayName =
                    catalogVariant.nameEs ?? catalogVariant.nameEn;

                  if (!variantDisplayName) {
                    throw new Error(
                      `Una variante de ${catalogItem.sourceKey} no contiene un nombre utilizable`,
                    );
                  }

                  return {
                    nameEs: catalogVariant.nameEs,
                    nameEn: catalogVariant.nameEn,
                    normalizedName:
                      normalizeCommercialCatalogName(variantDisplayName),
                    descriptionEs: catalogVariant.descriptionEs,
                    descriptionEn: catalogVariant.descriptionEn,
                    price: catalogVariant.price,
                    isActive: catalogVariant.isActive,
                    displayOrder: catalogVariant.displayOrder,
                  };
                }),
              }
            : undefined,
      },
      select: {
        id: true,
      },
    });
  }
}
