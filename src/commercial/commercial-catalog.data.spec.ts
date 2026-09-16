import {
  CommercialApprovalStatus,
  CommercialItemType,
} from '../../generated/prisma/enums';
import {
  COMMERCIAL_CATALOG_CATEGORIES,
  COMMERCIAL_CATALOG_ITEMS,
} from '../../prisma/data/commercial-catalog.data';

describe('Datos del catálogo comercial de Sabor Mágico Grill', () => {
  const allPrices = COMMERCIAL_CATALOG_ITEMS.flatMap((item) => [
    ...(item.basePrice ? [item.basePrice] : []),
    ...item.variants.map(({ price }) => price),
  ]);

  it('contiene las 16 categorías y 86 filas de la carta', () => {
    expect(COMMERCIAL_CATALOG_CATEGORIES).toHaveLength(16);
    expect(COMMERCIAL_CATALOG_ITEMS).toHaveLength(86);

    const expectedItemsByCategoryOrder = [
      5, 6, 6, 4, 4, 4, 4, 4, 7, 4, 7, 6, 6, 5, 7, 7,
    ];

    for (const category of COMMERCIAL_CATALOG_CATEGORIES) {
      expect(
        COMMERCIAL_CATALOG_ITEMS.filter(
          ({ categorySourceKey }) => categorySourceKey === category.sourceKey,
        ),
      ).toHaveLength(expectedItemsByCategoryOrder[category.displayOrder - 1]);
    }
  });

  it('clasifica 48 platos y 38 bebidas sin inventar otros tipos', () => {
    const countByType = new Map<CommercialItemType, number>();

    for (const item of COMMERCIAL_CATALOG_ITEMS) {
      countByType.set(item.type, (countByType.get(item.type) ?? 0) + 1);
    }

    expect(countByType.get(CommercialItemType.DISH)).toBe(48);
    expect(countByType.get(CommercialItemType.BEVERAGE)).toBe(38);
    expect(countByType.get(CommercialItemType.SERVICE)).toBeUndefined();
    expect(countByType.get(CommercialItemType.PROMOTION)).toBeUndefined();
    expect(countByType.get(CommercialItemType.EVENT)).toBeUndefined();
  });

  it('representa 69 precios base y 17 items mediante 27 variantes', () => {
    expect(
      COMMERCIAL_CATALOG_ITEMS.filter(({ basePrice }) => basePrice !== null),
    ).toHaveLength(69);
    expect(
      COMMERCIAL_CATALOG_ITEMS.filter(({ variants }) => variants.length > 0),
    ).toHaveLength(17);
    expect(
      COMMERCIAL_CATALOG_ITEMS.reduce(
        (total, catalogItem) => total + catalogItem.variants.length,
        0,
      ),
    ).toBe(27);
    expect(allPrices).toHaveLength(96);
  });

  it('usa strings monetarios no negativos con exactamente dos decimales', () => {
    for (const price of allPrices) {
      expect(price).toMatch(/^(0|[1-9]\d*)\.\d{2}$/);
      expect(Number(price)).toBeGreaterThanOrEqual(0);
    }
  });

  it('mantiene sourceKey únicos y referencias a categorías existentes', () => {
    const categoryKeys = COMMERCIAL_CATALOG_CATEGORIES.map(
      ({ sourceKey }) => sourceKey,
    );
    const itemKeys = COMMERCIAL_CATALOG_ITEMS.map(({ sourceKey }) => sourceKey);
    const validCategoryKeys = new Set(categoryKeys);

    expect(new Set(categoryKeys).size).toBe(categoryKeys.length);
    expect(new Set(itemKeys).size).toBe(itemKeys.length);

    for (const item of COMMERCIAL_CATALOG_ITEMS) {
      expect(validCategoryKeys.has(item.categorySourceKey)).toBe(true);
    }
  });

  it('conserva un nombre fuente y orden único dentro de cada categoría', () => {
    for (const category of COMMERCIAL_CATALOG_CATEGORIES) {
      expect(category.nameEs ?? category.nameEn).toBeTruthy();

      const items = COMMERCIAL_CATALOG_ITEMS.filter(
        ({ categorySourceKey }) => categorySourceKey === category.sourceKey,
      );
      const orders = items.map(({ displayOrder }) => displayOrder);

      expect(items.length).toBeGreaterThan(0);
      expect(new Set(orders).size).toBe(orders.length);
    }

    for (const item of COMMERCIAL_CATALOG_ITEMS) {
      expect(item.nameEs ?? item.nameEn).toBeTruthy();

      const variantNames = item.variants.map(({ nameEs, nameEn }) =>
        (nameEs ?? nameEn)?.toLocaleLowerCase('es-PE'),
      );

      expect(variantNames.every(Boolean)).toBe(true);
      expect(new Set(variantNames).size).toBe(variantNames.length);
    }
  });

  it('deja todos los elementos activos y en DRAFT', () => {
    for (const category of COMMERCIAL_CATALOG_CATEGORIES) {
      expect(category.isActive).toBe(true);
    }

    for (const item of COMMERCIAL_CATALOG_ITEMS) {
      expect(item.isActive).toBe(true);
      expect(item.approvalStatus).toBe(CommercialApprovalStatus.DRAFT);
      expect(item.variants.every(({ isActive }) => isActive)).toBe(true);
    }
  });

  it('no inventa imágenes, FAQs, horarios, detalles ni información interna', () => {
    for (const item of COMMERCIAL_CATALOG_ITEMS) {
      expect(item.images).toEqual([]);
      expect(item.faqs).toEqual([]);
      expect(item.schedules).toEqual([]);
      expect(item.promotionDetail).toBeNull();
      expect(item.eventDetail).toBeNull();
      expect(item.conditions).toBeNull();
      expect(item.internalNotes).toBeNull();
      expect(item.availabilityNote).toBeNull();
    }
  });

  it('aplica un único mecanismo de precio a cada fila de plato o bebida', () => {
    for (const item of COMMERCIAL_CATALOG_ITEMS) {
      expect((item.basePrice !== null) !== item.variants.length > 0).toBe(true);
    }
  });

  it('conserva las variantes reales de jugos y bebidas frías', () => {
    const orangeJuice = COMMERCIAL_CATALOG_ITEMS.find(
      ({ sourceKey }) => sourceKey === 'sabor-magico-p07-05',
    );
    const chichaMorada = COMMERCIAL_CATALOG_ITEMS.find(
      ({ sourceKey }) => sourceKey === 'sabor-magico-p08-01',
    );

    expect(orangeJuice?.variants).toEqual([
      expect.objectContaining({ nameEn: 'Without Milk', price: '14.00' }),
      expect.objectContaining({ nameEn: 'With Milk', price: '17.00' }),
    ]);
    expect(chichaMorada?.variants).toEqual([
      expect.objectContaining({ nameEn: 'JUG', price: '22.00' }),
      expect.objectContaining({ nameEn: 'GLASS', price: '12.00' }),
    ]);
  });

  it('mantiene las siete filas de vino y ambos Gran Tinto Tacama', () => {
    const wineCategory = COMMERCIAL_CATALOG_CATEGORIES.find(
      ({ nameEs }) => nameEs === 'VINOS',
    );
    const wines = COMMERCIAL_CATALOG_ITEMS.filter(
      ({ categorySourceKey }) => categorySourceKey === wineCategory?.sourceKey,
    );
    const granTinto = wines.filter(
      ({ nameEs }) => nameEs === 'GRAN TINTO TACAMA',
    );

    expect(wines).toHaveLength(7);
    expect(wines.every(({ variants }) => variants.length === 1)).toBe(true);
    expect(granTinto).toHaveLength(2);
    expect(granTinto.map(({ sourceKey }) => sourceKey)).toEqual([
      'sabor-magico-p08-21',
      'sabor-magico-p08-22',
    ]);
    expect(granTinto.map(({ descriptionEs }) => descriptionEs)).toEqual([
      '(750ml peruano)red',
      '(Peruano)red',
    ]);
  });

  it('preserva typos y traducciones de la fuente sin corregirlos', () => {
    expect(COMMERCIAL_CATALOG_CATEGORIES).toContainEqual(
      expect.objectContaining({ nameEn: 'DESERTS' }),
    );
    expect(COMMERCIAL_CATALOG_ITEMS).toContainEqual(
      expect.objectContaining({ nameEn: 'CREAM PUMKIN' }),
    );
    expect(COMMERCIAL_CATALOG_ITEMS).toContainEqual(
      expect.objectContaining({ nameEn: 'TROUT IN MUSHOOM SAUCE' }),
    );
    expect(COMMERCIAL_CATALOG_ITEMS).toContainEqual(
      expect.objectContaining({ nameEs: 'SPAGGETTI BOLOGNESA' }),
    );
    expect(COMMERCIAL_CATALOG_ITEMS).toContainEqual(
      expect.objectContaining({ nameEn: 'BEEF LASAGÑA' }),
    );
  });
});
