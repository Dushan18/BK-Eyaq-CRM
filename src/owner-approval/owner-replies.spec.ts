import { ownerTexts, readOwnerReply } from './owner-replies.service';

jest.mock('../database/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('M9.2: lectura de la respuesta del propietario', () => {
  it.each([
    ['Aceptar', 'ACCEPT'],
    ['Rechazar', 'REJECT'],
    ['Proponer cambio', 'PROPOSE'],
    ['  aceptar ', 'ACCEPT'],
  ])('botón «%s» → %s', (content, intent) => {
    expect(readOwnerReply(content, true)).toEqual({
      intents: [intent],
      codes: [],
    });
  });
  it('un botón solo vale con su texto exacto', () => {
    expect(readOwnerReply('Sí, continuar', true).intents).toEqual([]);
    expect(readOwnerReply('Aceptar RES-2026-000001', true).intents).toEqual([]);
  });
  it('en texto escrito reconoce decisiones y códigos, sin tildes ni mayúsculas', () => {
    expect(readOwnerReply('acepto: ACEPTAR res-2026-000043', false)).toEqual({
      intents: ['ACCEPT'],
      codes: ['RES-2026-000043'],
    });
    expect(
      readOwnerReply('Quiero MODIFICAR la RES-2026-000043', false).intents,
    ).toEqual(['PROPOSE']);
  });
  it('no confunde palabras parecidas ni inventa decisiones', () => {
    expect(readOwnerReply('Aceptaría si fuera a las 9', false).intents).toEqual(
      [],
    );
    expect(readOwnerReply('Gracias', false)).toEqual({
      intents: [],
      codes: [],
    });
  });
  it('detecta varias decisiones o varios códigos (ambiguo)', () => {
    expect(
      readOwnerReply('ACEPTAR o RECHAZAR RES-2026-000001', false).intents,
    ).toHaveLength(2);
    expect(
      readOwnerReply('ACEPTAR RES-2026-000001 y RES-2026-000002', false).codes,
    ).toHaveLength(2);
    // The same code twice is still one request.
    expect(
      readOwnerReply('ACEPTAR RES-2026-000001 (RES-2026-000001)', false).codes,
    ).toEqual(['RES-2026-000001']);
  });
  it('los textos al propietario nunca hablan como si fueran para el cliente', () => {
    expect(ownerTexts.accepted('RES-2026-000001', 'R-2026-000009')).toContain(
      'R-2026-000009',
    );
    expect(ownerTexts.needCode).toContain('RES-2026-000043');
    expect(ownerTexts.already('RES-2026-000001', 'ACCEPTED')).toContain(
      'ya está aceptada',
    );
  });
});
