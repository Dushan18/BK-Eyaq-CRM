import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PutRestaurantConfigDto } from '../dto/put-restaurant-config.dto';
import { OwnerApprovalConfig } from './owner-approval.config';
import {
  ownerTemplate,
  type OwnerTemplateSource,
} from './owner-approval.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

const source = (
  extra: Partial<OwnerTemplateSource> = {},
): OwnerTemplateSource => ({
  code: 'RES-2026-000010',
  externalReference: null,
  sourceChannel: 'WHATSAPP',
  // 20/11/2026 19:30 in Lima.
  reservationAt: new Date('2026-11-21T00:30:00.000Z'),
  numberOfPeople: 4,
  specialRequirements: 'Mesa junto a la ventana',
  comments: null,
  customer: {
    firstName: 'Lucía',
    lastName: 'Rojas',
    phone: '+51 987 654 321',
    normalizedPhone: '+51987654321',
  },
  commercialItem: { nameEs: 'Menú degustación', nameEn: 'Tasting menu' },
  ...extra,
});

describe('M9.1: plantilla para el propietario', () => {
  it('8 parámetros en el orden de la plantilla, con fecha y hora de Lima', () => {
    const { parameters, content } = ownerTemplate(source(), 'America/Lima');
    expect(parameters).toEqual([
      'RES-2026-000010',
      'Lucía Rojas (+51 987 654 321)',
      'viernes 20/11/2026',
      '19:30',
      '4',
      'Menú degustación',
      'Mesa junto a la ventana',
      'WhatsApp',
    ]);
    expect(content.split('\n')).toEqual([
      'Nueva solicitud de reserva RES-2026-000010',
      'Cliente: Lucía Rojas (+51 987 654 321)',
      'Fecha: viernes 20/11/2026',
      'Hora: 19:30',
      'Personas: 4',
      'Servicio: Menú degustación',
      'Observaciones: Mesa junto a la ventana',
      'Origen: WhatsApp',
      'Elige una opción. Con «Proponer cambio», escribe luego la nueva fecha, hora o personas.',
    ]);
  });
  it('las notas internas del CRM no llegan al propietario; vacíos como «-»', () => {
    const { parameters } = ownerTemplate(
      source({
        specialRequirements: null,
        comments:
          'Es un cumpleaños\nCRM: no se le escribió por WhatsApp\n\nPaís: Perú',
        commercialItem: null,
        customer: {
          firstName: null,
          lastName: null,
          phone: null,
          normalizedPhone: null,
        },
        sourceChannel: 'WEBSITE',
        externalReference: 'SM-20261110-9E49B1',
      }),
      'America/Lima',
    );
    expect(parameters[1]).toBe('Sin nombre');
    expect(parameters[5]).toBe('-');
    expect(parameters[6]).toBe('Es un cumpleaños · País: Perú');
    expect(parameters[7]).toBe('Página web (SM-20261110-9E49B1)');
    const empty = ownerTemplate(
      source({ specialRequirements: null, comments: 'CRM: solo nota interna' }),
      'America/Lima',
    );
    expect(empty.parameters[6]).toBe('-');
  });
  it('recorta textos largos y quita saltos de línea (Meta no los admite en parámetros)', () => {
    const { parameters } = ownerTemplate(
      source({ specialRequirements: `Línea 1\n\tLínea 2 ${'x'.repeat(400)}` }),
      'America/Lima',
    );
    expect(parameters[6]).not.toMatch(/[\n\t]/);
    expect(parameters[6]).toHaveLength(250);
    expect(parameters[6].endsWith('…')).toBe(true);
  });
});

describe('M9.1: configuración', () => {
  const config = (values: Record<string, string>) =>
    new OwnerApprovalConfig({
      get: (key: string) => values[key],
    } as unknown as ConfigService);
  it('apagada por defecto, con la plantilla y el idioma sugeridos', () => {
    expect(config({})).toMatchObject({
      enabled: false,
      template: 'aprobacion_reserva_propietario',
      language: 'es',
      maxAgeHours: 24,
      pollSeconds: 15,
    });
  });
  it.each([
    [{ OWNER_APPROVAL_TEMPLATE: 'Con Mayúsculas' }, 'OWNER_APPROVAL_TEMPLATE'],
    [
      { OWNER_APPROVAL_TEMPLATE_LANGUAGE: 'spanish' },
      'OWNER_APPROVAL_TEMPLATE_LANGUAGE',
    ],
    [{ OWNER_APPROVAL_MAX_AGE_HOURS: '0' }, 'OWNER_APPROVAL_MAX_AGE_HOURS'],
    [{ OWNER_APPROVAL_POLL_SECONDS: '1' }, 'OWNER_APPROVAL_POLL_SECONDS'],
  ])('encendida valida %j', (values, key) => {
    expect(() => config({ OWNER_APPROVAL_ENABLED: 'true', ...values })).toThrow(
      key,
    );
  });
  it('un interruptor ambiguo es un error, no «apagado»', () => {
    expect(() => config({ OWNER_APPROVAL_ENABLED: 'yes' })).toThrow(
      'OWNER_APPROVAL_ENABLED debe ser true o false',
    );
  });
});

describe('M9.3: plantillas de aviso al cliente', () => {
  const config = (values: Record<string, string>) =>
    new OwnerApprovalConfig({
      get: (key: string) => values[key],
    } as unknown as ConfigService);
  it('apagadas por defecto, con los nombres sugeridos', () => {
    expect(config({})).toMatchObject({
      decisionTemplatesEnabled: false,
      decisionTemplates: {
        ACCEPTED: 'reserva_aprobada',
        REJECTED: 'reserva_no_aprobada',
        MODIFICATION_REQUESTED: 'reserva_cambio_propuesto',
      },
      decisionTemplateLanguage: 'es',
    });
  });
  it('apagadas no validan nada; encendidas validan nombres e idioma', () => {
    expect(() =>
      config({ CUSTOMER_DECISION_TEMPLATE_ACCEPTED: 'Con Mayúsculas' }),
    ).not.toThrow();
    expect(() =>
      config({
        CUSTOMER_DECISION_TEMPLATES_ENABLED: 'true',
        CUSTOMER_DECISION_TEMPLATE_REJECTED: 'no válida',
      }),
    ).toThrow('CUSTOMER_DECISION_TEMPLATE_');
    expect(() =>
      config({
        CUSTOMER_DECISION_TEMPLATES_ENABLED: 'true',
        CUSTOMER_DECISION_TEMPLATE_LANGUAGE: 'spanish',
      }),
    ).toThrow('CUSTOMER_DECISION_TEMPLATE_LANGUAGE');
    expect(() => config({ CUSTOMER_DECISION_TEMPLATES_ENABLED: 'si' })).toThrow(
      'CUSTOMER_DECISION_TEMPLATES_ENABLED debe ser true o false',
    );
  });
});

describe('M9.1: ownerWhatsappNumber en PUT /restaurant-config', () => {
  const errorsOf = async (ownerWhatsappNumber: unknown) =>
    (
      await validate(
        plainToInstance(PutRestaurantConfigDto, { ownerWhatsappNumber }),
      )
    ).filter((error) => error.property === 'ownerWhatsappNumber');
  it.each([undefined, null, '+51987000111', ' +51987000111 '])(
    'acepta %p',
    async (value) => {
      expect(await errorsOf(value)).toEqual([]);
    },
  );
  it.each(['987000111', '+051987000111', '+51 987 000 111', 5])(
    'rechaza %p',
    async (value) => {
      expect(await errorsOf(value)).not.toEqual([]);
    },
  );
});
