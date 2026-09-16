import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ContactChannel } from '../../generated/prisma/enums';
import {
  CreateCustomerDto,
  CustomerQueryDto,
  UpdateCustomerDto,
} from './customer.dto';

const options = { whitelist: true, forbidNonWhitelisted: true };
describe('Customer DTOs', () => {
  it('normaliza email y nombres', async () => {
    const dto = plainToInstance(CreateCustomerDto, {
      email: ' JUAN@EXAMPLE.COM ',
      firstName: ' Juan ',
      sourceChannel: 'EMAIL',
    });
    expect(await validate(dto, options)).toEqual([]);
    expect(dto.email).toBe('juan@example.com');
    expect(dto.firstName).toBe('Juan');
  });
  it.each([
    { normalizedEmail: 'test@example.com' },
    { normalizedPhone: '+51987654321' },
    { status: 'CONFIRMED' },
    { firstContactAt: '2020-01-01' },
    { lastContactAt: '2020-01-01' },
    { email: 'bad' },
    { sourceChannel: 'INVALID' },
    { firstName: '' },
    { firstName: ' ' },
    { phone: 123 },
  ])('rechaza campos inválidos %j', async (bad) => {
    const dto = plainToInstance(CreateCustomerDto, {
      email: 'juan@example.com',
      sourceChannel: ContactChannel.EMAIL,
      ...bad,
    });
    expect((await validate(dto, options)).length).toBeGreaterThan(0);
  });
  it('PATCH permite null para limpiar opcionales', async () => {
    const dto = plainToInstance(UpdateCustomerDto, {
      phone: null,
      firstName: null,
    });
    expect(await validate(dto, options)).toEqual([]);
  });
  it('no permite channel null en PATCH', async () => {
    expect(
      (
        await validate(
          plainToInstance(UpdateCustomerDto, { sourceChannel: null }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('paginación tiene defaults y transforma strings', async () => {
    expect(plainToInstance(CustomerQueryDto, {})).toMatchObject({
      page: 1,
      limit: 20,
    });
    const dto = plainToInstance(CustomerQueryDto, {
      page: '2',
      limit: '10',
      status: 'NEW',
    });
    expect(await validate(dto, options)).toEqual([]);
    expect(dto.page).toBe(2);
  });
  it.each([
    { page: 0 },
    { page: 1.5 },
    { limit: 101 },
    { limit: null },
    { channel: 'SMS' },
    { commercialItemId: 'UUID' },
  ])('rechaza query %j', async (query) => {
    expect(
      (await validate(plainToInstance(CustomerQueryDto, query), options))
        .length,
    ).toBeGreaterThan(0);
  });
});
