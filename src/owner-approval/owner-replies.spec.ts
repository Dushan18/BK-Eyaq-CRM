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

describe('M9.2: «CAMBIO RES-…» del texto temporal', () => {
  it('CAMBIO seguido del código es proponer un cambio', () => {
    expect(readOwnerReply('cambio res-2026-000043', false)).toEqual({
      intents: ['PROPOSE'],
      codes: ['RES-2026-000043'],
    });
    expect(
      readOwnerReply('Cambio  RES-2026-000043 por favor', false).intents,
    ).toEqual(['PROPOSE']);
  });
  it('la palabra cambio sin código sigue siendo el detalle de la propuesta', () => {
    expect(readOwnerReply('Cambio a las 21:00 para 6', false)).toEqual({
      intents: [],
      codes: [],
    });
    expect(
      readOwnerReply('el cambio es para RES-2026-000043 a las 21:00', false)
        .intents,
    ).toEqual([]);
  });
  it('un botón sigue valiendo solo por su etiqueta exacta', () => {
    expect(readOwnerReply('CAMBIO RES-2026-000043', true).intents).toEqual([]);
  });
  it('CAMBIO con otra decisión es ambiguo', () => {
    expect(
      readOwnerReply('ACEPTAR o CAMBIO RES-2026-000043', false).intents.sort(),
    ).toEqual(['ACCEPT', 'PROPOSE']);
  });
});

describe('M9.2: respuestas cortas con «Responder» (ACEPTO, RECHAZO, CAMBIO)', () => {
  it.each([
    ['Acepto', 'ACCEPT'],
    ['ACEPTO.', 'ACCEPT'],
    ['¡acepto!', 'ACCEPT'],
    ['Aceptar 👍', 'ACCEPT'],
    ['Rechazo', 'REJECT'],
    ['rechazar', 'REJECT'],
    ['Cambio', 'PROPOSE'],
    ['  cambio  ', 'PROPOSE'],
  ])('«%s» solo es una decisión (%s), sin código', (content, intent) => {
    expect(readOwnerReply(content, false)).toEqual({
      intents: [intent],
      codes: [],
    });
  });
  it('con el código siguen valiendo, también las formas cortas', () => {
    expect(readOwnerReply('Acepto RES-2026-000043', false)).toEqual({
      intents: ['ACCEPT'],
      codes: ['RES-2026-000043'],
    });
    expect(readOwnerReply('rechazo res-2026-000043', false).intents).toEqual([
      'REJECT',
    ]);
  });
  it.each([
    'Acepto si es a las 9',
    'No acepto',
    'Cambio a las 21:00 para 6',
    'Rechazo esa hora, mejor a las 8',
    'Gracias',
  ])('dentro de una frase no decide nada: «%s»', (content) => {
    expect(readOwnerReply(content, false).intents).toEqual([]);
  });
  it('un botón sigue valiendo solo por su etiqueta exacta', () => {
    expect(readOwnerReply('Acepto', true).intents).toEqual([]);
    expect(readOwnerReply('Cambio', true).intents).toEqual([]);
  });
  it('las aclaraciones explican cómo usar «Responder»', () => {
    expect(ownerTexts.needCode).toContain('«Responder»');
    expect(ownerTexts.needCode).toContain('ACEPTO, RECHAZO o CAMBIO');
    expect(ownerTexts.notARequest).toContain('«Responder»');
  });
});
