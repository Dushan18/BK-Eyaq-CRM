import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import {
  CommercialApprovalStatus,
  CommercialItemType,
  DayOfWeek,
} from '../../generated/prisma/enums';
import {
  CreateCommercialCategoryDto,
  UpdateCommercialCategoryStatusDto,
} from './commercial-category.dto';
import {
  CommercialItemQueryDto,
  CreateCommercialItemDto,
  UpdateCommercialItemApprovalDto,
  UpdateCommercialItemDto,
  UpdateCommercialItemStatusDto,
} from './commercial-item.dto';
import {
  CommercialItemImageDto,
  CommercialItemScheduleDto,
} from './commercial-item-resource.dto';

describe('DTOs comerciales', () => {
  const categoryId = '11111111-1111-4111-8111-111111111111';

  const validItemInput = () => ({
    categoryId,
    type: CommercialItemType.DISH,
    nameEs: 'Lomo saltado',
    basePrice: '49.90',
  });

  const hasErrorFor = (errors: ValidationError[], property: string): boolean =>
    errors.some((error) => error.property === property);

  describe('nombres e identidad', () => {
    it('permite que una categoría llegue al servicio sin nombres', async () => {
      const dto = plainToInstance(CreateCommercialCategoryDto, {});

      await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it('permite que un item llegue al servicio sin nombres', async () => {
      const dto = plainToInstance(CreateCommercialItemDto, {
        categoryId,
        type: CommercialItemType.DISH,
        basePrice: '10.00',
      });

      await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it('rechaza categoryId y type inválidos', async () => {
      const dto = plainToInstance(CreateCommercialItemDto, {
        ...validItemInput(),
        categoryId: 'categoria-1',
        type: 'PRODUCTO_INVENTADO',
      });

      const errors = await validate(dto);

      expect(hasErrorFor(errors, 'categoryId')).toBe(true);
      expect(hasErrorFor(errors, 'type')).toBe(true);
    });

    it('no permite editar type, estado ni aprobación en el DTO general', async () => {
      const dto = plainToInstance(UpdateCommercialItemDto, {
        nameEs: 'Nombre actualizado',
        type: CommercialItemType.EVENT,
        isActive: false,
        approvalStatus: CommercialApprovalStatus.APPROVED,
      });

      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

      expect(hasErrorFor(errors, 'type')).toBe(true);
      expect(hasErrorFor(errors, 'isActive')).toBe(true);
      expect(hasErrorFor(errors, 'approvalStatus')).toBe(true);
    });
  });

  describe('dinero y recursos anidados', () => {
    it.each(['0', '12', '12.5', '49.90', '99999999.99'])(
      'acepta el importe string válido %s',
      async (basePrice) => {
        const dto = plainToInstance(CreateCommercialItemDto, {
          ...validItemInput(),
          basePrice,
        });

        await expect(validate(dto)).resolves.toHaveLength(0);
      },
    );

    it.each([
      ['number', 12.5],
      ['negativo', '-1.00'],
      ['más de dos decimales', '1.234'],
      ['fuera de Decimal(10,2)', '100000000.00'],
    ])('rechaza un importe %s', async (_case, basePrice) => {
      const dto = plainToInstance(CreateCommercialItemDto, {
        ...validItemInput(),
        basePrice,
      });

      const errors = await validate(dto);

      expect(hasErrorFor(errors, 'basePrice')).toBe(true);
    });

    it('transforma y valida los recursos anidados', async () => {
      const dto = plainToInstance(CreateCommercialItemDto, {
        ...validItemInput(),
        variants: [
          {
            nameEs: '  Porción grande  ',
            price: '59.90',
          },
        ],
        images: [
          {
            url: 'https://example.com/lomo.png',
            isPrimary: true,
          },
        ],
      });

      await expect(validate(dto)).resolves.toHaveLength(0);
      expect(dto.variants?.[0].nameEs).toBe('Porción grande');
      expect(dto.images?.[0]).toBeInstanceOf(CommercialItemImageDto);
      expect(dto.images?.[0].isPrimary).toBe(true);
    });

    it('detecta errores dentro de recursos anidados', async () => {
      const dto = plainToInstance(CreateCommercialItemDto, {
        ...validItemInput(),
        variants: [
          {
            nameEs: 'Grande',
            price: '20.999',
          },
        ],
      });

      const errors = await validate(dto);

      expect(hasErrorFor(errors, 'variants')).toBe(true);
      expect(
        errors.find((error) => error.property === 'variants')?.children,
      ).not.toHaveLength(0);
    });

    it('valida URL e isPrimary sin convertir strings a boolean', async () => {
      const validImage = plainToInstance(CommercialItemImageDto, {
        url: '  https://example.com/menu.png  ',
        isPrimary: true,
      });
      const invalidImage = plainToInstance(CommercialItemImageDto, {
        url: 'ftp://example.com/menu.png',
        isPrimary: 'true',
      });

      await expect(validate(validImage)).resolves.toHaveLength(0);
      expect(validImage.url).toBe('https://example.com/menu.png');

      const errors = await validate(invalidImage);
      expect(hasErrorFor(errors, 'url')).toBe(true);
      expect(hasErrorFor(errors, 'isPrimary')).toBe(true);
    });
  });

  describe('horarios comerciales', () => {
    it('acepta un horario que cruza la medianoche', async () => {
      const dto = plainToInstance(CommercialItemScheduleDto, {
        dayOfWeek: DayOfWeek.FRIDAY,
        isAvailable: true,
        startTime: '18:00',
        endTime: '02:00',
      });

      await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it.each([
      ['horas iguales', { startTime: '18:00', endTime: '18:00' }],
      ['sin inicio', { endTime: '02:00' }],
      ['sin fin', { startTime: '18:00' }],
    ])('rechaza un horario disponible %s', async (_case, times) => {
      const dto = plainToInstance(CommercialItemScheduleDto, {
        dayOfWeek: DayOfWeek.FRIDAY,
        isAvailable: true,
        ...times,
      });

      const errors = await validate(dto);

      expect(hasErrorFor(errors, 'isAvailable')).toBe(true);
    });

    it('rechaza días duplicados en los horarios anidados', async () => {
      const dto = plainToInstance(CreateCommercialItemDto, {
        ...validItemInput(),
        schedules: [
          {
            dayOfWeek: DayOfWeek.MONDAY,
            isAvailable: false,
          },
          {
            dayOfWeek: DayOfWeek.MONDAY,
            isAvailable: false,
          },
        ],
      });

      const errors = await validate(dto);

      expect(hasErrorFor(errors, 'schedules')).toBe(true);
    });
  });

  describe('query', () => {
    it('aplica los valores predeterminados', async () => {
      const dto = plainToInstance(CommercialItemQueryDto, {});

      await expect(validate(dto)).resolves.toHaveLength(0);
      expect(dto).toMatchObject({
        page: 1,
        limit: 20,
        sort: 'createdAt',
        order: 'desc',
      });
    });

    it('transforma números y booleanos válidos de query string', async () => {
      const dto = plainToInstance(CommercialItemQueryDto, {
        page: '2',
        limit: '50',
        isActive: 'false',
        type: CommercialItemType.BEVERAGE,
        approvalStatus: CommercialApprovalStatus.DRAFT,
        sort: 'name',
        order: 'asc',
      });

      await expect(validate(dto)).resolves.toHaveLength(0);
      expect(dto).toMatchObject({
        page: 2,
        limit: 50,
        isActive: false,
        sort: 'name',
        order: 'asc',
      });
    });

    it('rechaza booleano inválido, limit mayor a 100 y sort no permitido', async () => {
      const dto = plainToInstance(CommercialItemQueryDto, {
        isActive: 'no',
        limit: '101',
        sort: 'price',
      });

      const errors = await validate(dto);

      expect(hasErrorFor(errors, 'isActive')).toBe(true);
      expect(hasErrorFor(errors, 'limit')).toBe(true);
      expect(hasErrorFor(errors, 'sort')).toBe(true);
    });
  });

  describe('estado y aprobación', () => {
    it('acepta los DTOs dedicados con valores válidos', async () => {
      const categoryStatus = plainToInstance(
        UpdateCommercialCategoryStatusDto,
        { isActive: false },
      );
      const itemStatus = plainToInstance(UpdateCommercialItemStatusDto, {
        isActive: true,
      });
      const approval = plainToInstance(UpdateCommercialItemApprovalDto, {
        approvalStatus: CommercialApprovalStatus.APPROVED,
      });

      await expect(validate(categoryStatus)).resolves.toHaveLength(0);
      await expect(validate(itemStatus)).resolves.toHaveLength(0);
      await expect(validate(approval)).resolves.toHaveLength(0);
    });

    it('rechaza estados y aprobaciones arbitrarios', async () => {
      const status = plainToInstance(UpdateCommercialItemStatusDto, {
        isActive: 'false',
      });
      const approval = plainToInstance(UpdateCommercialItemApprovalDto, {
        approvalStatus: 'PUBLISHED',
      });

      expect(hasErrorFor(await validate(status), 'isActive')).toBe(true);
      expect(hasErrorFor(await validate(approval), 'approvalStatus')).toBe(
        true,
      );
    });
  });
});
