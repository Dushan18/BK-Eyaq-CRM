import { normalizeContact } from './contact-normalization';

describe('Normalización de contactos', () => {
  it.each(['+51 987 654 321', '+51987654321', '+51 (987) 654-321'])(
    'normaliza %s',
    (phone) => {
      expect(normalizeContact({ phone }).normalizedPhone).toBe('+51987654321');
    },
  );
  it('normaliza un número nacional con país explícito', () => {
    expect(
      normalizeContact({ phone: '987654321', phoneCountry: 'PE' })
        .normalizedPhone,
    ).toBe('+51987654321');
  });
  it('normaliza código de país sin + únicamente con contexto explícito', () => {
    expect(
      normalizeContact({ phone: '51987654321', phoneCountry: 'PE' })
        .normalizedPhone,
    ).toBe('+51987654321');
  });
  it('conserva el original ambiguo si hay email', () => {
    expect(
      normalizeContact({ phone: '987 654 321', email: ' JUAN@EXAMPLE.COM ' }),
    ).toMatchObject({
      phone: '987 654 321',
      normalizedPhone: null,
      normalizedEmail: 'juan@example.com',
    });
  });
  it.each([
    {},
    { phone: '987654321' },
    { phone: '51987654321' },
    { phone: '' },
    { email: '' },
    { email: 'not-email' },
    { phone: '+999123456789' },
    { phone: '+51987654321 ext 123' },
    { phoneCountry: 'PE', email: 'a@example.com' },
    { phone: '987654321', phoneCountry: 'ZZ' },
  ])('rechaza identidad inválida %j', (input) => {
    expect(() => normalizeContact(input)).toThrow();
  });
});
