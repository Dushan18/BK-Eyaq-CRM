import {
  htmlToText,
  parseWebReservation,
  WEB_RESERVATION_SUBJECT,
} from './web-reservation.parser';

// Same layout as the website's notification; fictitious data.
const body = (fields: Record<string, string> = {}) =>
  [
    'NUEVA SOLICITUD DE RESERVA',
    `Código: ${fields.code ?? 'SM-20261029-B65A25'}`,
    'Estado: PENDIENTE DE CONFIRMACIÓN',
    `Idioma del cliente: ${fields.language ?? 'ES'}`,
    '',
    `Nombre: ${fields.name ?? 'Ana Prueba'}`,
    `Email: ${fields.email ?? 'ana.prueba@example.com'}`,
    `WhatsApp: ${fields.phone ?? '+33 6 12 34 56 78'}`,
    `País: ${fields.country ?? 'Francia'}`,
    '',
    `Fecha: ${fields.date ?? '29/10/2026'}`,
    `Hora: ${fields.time ?? '19:30'}`,
    `Personas: ${fields.people ?? '3'}`,
    `Preferencia: ${fields.preference ?? 'Mesa en el balcón'}`,
    `Mensaje: ${fields.message ?? 'Sin mensaje adicional'}`,
    '',
    'Responde directamente a este correo para confirmar o coordina por WhatsApp.',
  ].join('\r\n');
const subject = 'Nueva reserva SM-20261029-B65A25 · 2026-10-29 19:30';

describe('Correo de reserva de la web', () => {
  it('reconoce el asunto de una reserva y nada más', () => {
    expect(WEB_RESERVATION_SUBJECT.test(subject)).toBe(true);
    expect(WEB_RESERVATION_SUBJECT.test('RE: Nueva reserva SM-1')).toBe(false);
    expect(
      WEB_RESERVATION_SUBJECT.test(
        'Official Notice: Email Service Deactivation',
      ),
    ).toBe(false);
  });
  it('lee todos los campos del formulario', () => {
    expect(parseWebReservation(subject, body())).toEqual({
      ok: true,
      reservation: {
        code: 'SM-20261029-B65A25',
        language: 'es',
        name: 'Ana Prueba',
        email: 'ana.prueba@example.com',
        phone: '+33612345678',
        country: 'Francia',
        date: { year: 2026, month: 10, day: 29 },
        time: { hour: 19, minute: 30 },
        people: 3,
        preference: 'Mesa en el balcón',
        message: null,
        unparsed: [],
      },
    });
  });
  it('toma el código del asunto si el cuerpo no lo trae', () => {
    const result = parseWebReservation(subject, body({ code: '' }));
    expect(result).toMatchObject({
      ok: true,
      reservation: { code: 'SM-20261029-B65A25' },
    });
  });
  it.each(['Sin mensaje adicional', 'Ninguna', '-', 'N/A'])(
    '"%s" cuenta como vacío',
    (value) => {
      const result = parseWebReservation(
        subject,
        body({ message: value, preference: value }),
      );
      expect(result).toMatchObject({
        ok: true,
        reservation: { message: null, preference: null },
      });
    },
  );
  it('conserva el mensaje y extrae el correo de un enlace mailto', () => {
    const result = parseWebReservation(
      subject,
      body({
        message: 'Es un cumpleaños',
        email: 'ana.prueba@example.com <mailto:ana.prueba@example.com>',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      reservation: {
        message: 'Es un cumpleaños',
        email: 'ana.prueba@example.com',
      },
    });
  });
  it('deja sin fecha, hora o personas lo que no se entiende', () => {
    const result = parseWebReservation(
      subject,
      body({ date: 'mañana', time: 'noche', people: 'muchos' }),
    );
    expect(result).toMatchObject({
      ok: true,
      reservation: { date: null, time: null, people: null },
    });
  });
  it('rechaza un correo sin código o sin ningún contacto', () => {
    expect(parseWebReservation('Hola', body({ code: '' }))).toEqual({
      ok: false,
      errorCode: 'RESERVATION_CODE_MISSING',
    });
    expect(
      parseWebReservation(subject, body({ email: '', phone: '' })),
    ).toEqual({ ok: false, errorCode: 'CONTACT_MISSING' });
  });
  it.each([
    'Sin gluten, por favor',
    'Ninguna alergia, pero traemos torta',
    'No hay apuro',
  ])('"%s" es un mensaje real, no un vacío', (value) => {
    expect(
      parseWebReservation(subject, body({ message: value })),
    ).toMatchObject({ ok: true, reservation: { message: value } });
  });
  it('conserva las líneas siguientes del mensaje hasta el pie del correo', () => {
    const text = body({
      message:
        'Celebramos un cumpleaños.\r\nIMPORTANTE: alergia severa al maní\r\n\r\nGracias',
    });
    expect(parseWebReservation(subject, text)).toMatchObject({
      ok: true,
      reservation: {
        message:
          'Celebramos un cumpleaños.\nIMPORTANTE: alergia severa al maní\n\nGracias',
        preference: 'Mesa en el balcón',
      },
    });
  });
  it.each([
    ['19:30', { hour: 19, minute: 30 }],
    ['7:30 pm', { hour: 19, minute: 30 }],
    ['7:30 p. m.', { hour: 19, minute: 30 }],
    ['12:15 a. m.', { hour: 0, minute: 15 }],
    ['19h30', { hour: 19, minute: 30 }],
    ['19:30 hrs', { hour: 19, minute: 30 }],
  ])('entiende la hora "%s"', (time, expected) => {
    expect(parseWebReservation(subject, body({ time }))).toMatchObject({
      ok: true,
      reservation: { time: expected },
    });
  });
  it('guarda como texto lo que no entiende, sin inventar valores', () => {
    const result = parseWebReservation(
      subject,
      body({ time: '7:30 de la noche', people: '2 adultos y 2 niños' }),
    );
    expect(result).toMatchObject({
      ok: true,
      reservation: {
        time: null,
        people: null,
        unparsed: ['Hora: 7:30 de la noche', 'Personas: 2 adultos y 2 niños'],
      },
    });
  });
  it.each([
    ['+51 987 654 321 [https://wa.me/51987654321]', '+51987654321'],
    ['0033 6 12 34 56 78', '+33612345678'],
    ['987 654 321', '987654321'],
  ])('toma el número de WhatsApp de "%s"', (phone, expected) => {
    expect(parseWebReservation(subject, body({ phone }))).toMatchObject({
      ok: true,
      reservation: { phone: expected },
    });
  });
  it('quita caracteres nulos y de control', () => {
    expect(
      parseWebReservation(subject, body({ name: 'Ana\u0000 Prueba\u0007' })),
    ).toMatchObject({ ok: true, reservation: { name: 'Ana Prueba' } });
  });
  it('un cuerpo malicioso no bloquea el servidor', () => {
    const started = Date.now();
    const blank = ' '.repeat(1_000_000);
    parseWebReservation(
      subject,
      `${body()}\n${blank}\nEmail: ${'a'.repeat(200_000)}`,
    );
    parseWebReservation(subject, `${blank}x`);
    htmlToText('<style'.repeat(100_000));
    htmlToText(`<${' '.repeat(500_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('lee una tabla HTML con entidades', () => {
    const rows = [
      ['C&oacute;digo:', 'SM-20261029-B65A25'],
      ['Nombre:', 'Mar&iacute;a O&#x27;Connor'],
      ['WhatsApp:', '<a href="https://wa.me/51987654321">+51 987 654 321</a>'],
      ['Pa&iacute;s:', 'Per&uacute;'],
    ]
      .map(
        ([label, value]) =>
          `<tr><td><b>${label}</b></td><td>${value}</td></tr>`,
      )
      .join('');
    expect(
      parseWebReservation(subject, htmlToText(`<table>${rows}</table>`)),
    ).toMatchObject({
      ok: true,
      reservation: {
        name: "María O'Connor",
        phone: '+51987654321',
        country: 'Perú',
      },
    });
  });
  it('lee también la versión HTML del correo', () => {
    const html = body()
      .split('\r\n')
      .map((line) => `<p>${line.replace('Mesa', 'Mesa&nbsp;')}</p>`)
      .join('');
    const result = parseWebReservation(subject, htmlToText(html));
    expect(result).toMatchObject({
      ok: true,
      reservation: {
        code: 'SM-20261029-B65A25',
        people: 3,
        preference: 'Mesa en el balcón',
      },
    });
  });
});
