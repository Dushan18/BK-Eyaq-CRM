// The website's reservation notification ("Nueva reserva SM-20261029-B65A25 · ..."):
//   Código: SM-20261029-B65A25
//   Idioma del cliente: ES
//   Nombre: ... / Email: ... / WhatsApp: +33... / País: ...
//   Fecha: 29/10/2026 / Hora: 19:30 / Personas: 3
//   Preferencia: ... / Mensaje: ...
// Pure functions: no I/O, so the format can be tested with sample emails.
// Anyone can send an email with this subject, so every step is linear and bounded: no
// regular expression ever runs on unbounded input.

export const WEB_RESERVATION_SUBJECT = /^\s*nueva reserva\s+SM-/i;
const CODE = /\bSM-\d{8}-[A-Z0-9]{4,12}\b/i;
const EMAIL = /[^\s<>()[\]:;,"']+@[^\s<>()[\]:;,"']+\.[a-z]{2,}/i;
// A notice is a few KB: the rest of a longer body is ignored.
const MAX_BODY = 64 * 1024;
const MAX_LINE = 1000;
// Whole values only: "Sin gluten, por favor" is a real message.
const EMPTY =
  /^(sin (mensaje|preferencias?|comentarios?|observaciones?)( adicional(es)?)?|ningun[oa]?|nada|no|none|n\/a|-+)\.?$/i;
// Labels of the notice; a line with another label inside a message is part of it.
const LABELS = new Set([
  'codigo',
  'estado',
  'idioma del cliente',
  'nombre',
  'email',
  'correo',
  'whatsapp',
  'telefono',
  'pais',
  'fecha',
  'hora',
  'personas',
  'preferencia',
  'mensaje',
]);
// Fields the customer types in a text area: they may span several lines.
const MULTILINE = new Set(['preferencia', 'mensaje']);
const FOOTER = /^responde directamente/i;

export interface WebReservation {
  code: string;
  language: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  date: { year: number; month: number; day: number } | null;
  time: { hour: number; minute: number } | null;
  people: number | null;
  preference: string | null;
  message: string | null;
  // "Fecha: el sábado", "Personas: 2-3": values given but not understood, kept for staff.
  unparsed: string[];
}
export type WebReservationResult =
  | { ok: true; reservation: WebReservation }
  | { ok: false; errorCode: 'RESERVATION_CODE_MISSING' | 'CONTACT_MISSING' };

// PostgreSQL text cannot store U+0000, and other control characters are never part of
// a notice: drop them (keeps tab, line feed and carriage return).
export function stripControls(text: string) {
  let clean = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127)
      continue;
    clean += char;
  }
  return clean;
}

const key = (label: string) =>
  label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const clip = (value: string | undefined, max: number) => {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text && !EMPTY.test(text) ? text.slice(0, max) : null;
};
// A multi-line value: each line trimmed, blank lines at the ends dropped.
const clipBlock = (lines: string[] | undefined, max: number) => {
  if (!lines) return null;
  const kept = lines.map((line) => line.replace(/[ \t]+/g, ' ').trim());
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  while (kept.length && !kept[0]) kept.shift();
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  return text && !EMPTY.test(text) ? text.slice(0, max) : null;
};

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
  iexcl: '¡',
  iquest: '¿',
  middot: '·',
};
function decodeEntities(text: string) {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi,
    (entity, name: string) => {
      if (name[0] !== '#') return NAMED_ENTITIES[name] ?? entity;
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    },
  );
}
// Removes <script> and <style> elements by scanning, not with a backtracking regex.
function dropElements(html: string) {
  const lower = html.toLowerCase();
  let out = '';
  let from = 0;
  for (;;) {
    const script = lower.indexOf('<script', from);
    const style = lower.indexOf('<style', from);
    const start =
      script < 0 ? style : style < 0 ? script : Math.min(script, style);
    if (start < 0) return out + html.slice(from);
    out += html.slice(from, start);
    const tag = start === script ? '</script' : '</style';
    const end = lower.indexOf(tag, start);
    if (end < 0) return out;
    const close = lower.indexOf('>', end);
    if (close < 0) return out;
    from = close + 1;
  }
}

// HTML-only emails: keep the line structure the fields depend on.
export function htmlToText(html: string) {
  return decodeEntities(
    dropElements(html.slice(0, MAX_BODY))
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|tr|li|h\d|table)\s*>/gi, '\n')
      .replace(/<\s*\/\s*t[dh]\s*>/gi, ' ')
      .replace(/<[^<>]*>/g, ''),
  );
}

// "+51 987 654 321", "0033 6 12 34 56 78", "+51987654321 [https://wa.me/...]": the first
// phone-like token, digits and a leading "+" only ("00" becomes "+").
function phoneOf(value: string | undefined) {
  const token = value?.slice(0, 80).match(/\+?\d[\d\s().-]{4,24}\d/)?.[0];
  const digits = token?.replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
}
function dateOf(value: string) {
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec(value);
  if (local)
    return { day: +local[1], month: +local[2], year: +local[3] } as const;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[\sT]|$)/.exec(value);
  return iso
    ? ({ year: +iso[1], month: +iso[2], day: +iso[3] } as const)
    : null;
}
// 19:30, 19.30, 19h30, 7:30 pm, 7:30 p. m.; anything else is not a time.
function timeOf(value: string) {
  const match =
    /^(\d{1,2})[:.h](\d{2})(?::\d{2})?\s*(?:([ap])\.?\s?m\.?)?\s*(?:h|hrs?\.?)?$/i.exec(
      value,
    );
  if (!match) return null;
  let hour = +match[1];
  const minute = +match[2];
  const half = match[3]?.toLowerCase();
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === 'p' ? 12 : 0);
  }
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}
// "3", "3 personas": a lone number. "2-3" or "2 adultos y 2 niños" is not understood.
function peopleOf(value: string) {
  const match = /^(\d{1,4})(?:\s*(?:personas?|pax))?\.?$/i.exec(value);
  const count = match ? +match[1] : 0;
  return count >= 1 && count <= 1000 ? count : null;
}

export function parseWebReservation(
  subject: string | null,
  body: string,
): WebReservationResult {
  const fields = new Map<string, string>();
  const blocks = new Map<string, string[]>();
  // The text-area field receiving the lines that follow its label.
  let open: string[] | null = null;
  for (const raw of stripControls(body.slice(0, MAX_BODY)).split(/\r?\n/)) {
    if (raw.length > MAX_LINE) {
      open = null;
      continue;
    }
    const line = raw.trim();
    const colon = line.indexOf(':');
    const label = colon >= 2 && colon <= 40 ? key(line.slice(0, colon)) : '';
    // The first occurrence of a label wins; a repeated one inside a message is text.
    if (LABELS.has(label) && !fields.has(label)) {
      const value = line.slice(colon + 1).trim();
      fields.set(label, value);
      open = MULTILINE.has(label) ? [value] : null;
      if (open) blocks.set(label, open);
    } else if (FOOTER.test(line)) open = null;
    else open?.push(line);
  }
  const code = (fields.get('codigo')?.match(CODE) ??
    subject?.match(CODE))?.[0].toUpperCase();
  if (!code) return { ok: false, errorCode: 'RESERVATION_CODE_MISSING' };
  const email =
    (fields.get('email') ?? fields.get('correo'))
      ?.slice(0, 320)
      .match(EMAIL)?.[0] ?? null;
  const phone = phoneOf(fields.get('whatsapp') ?? fields.get('telefono'));
  if (!email && !phone) return { ok: false, errorCode: 'CONTACT_MISSING' };
  const unparsed: string[] = [];
  const read = <T>(
    label: string,
    title: string,
    parse: (value: string) => T | null,
  ) => {
    const value = clip(fields.get(label), 80);
    const parsed = value ? parse(value) : null;
    if (value && !parsed) unparsed.push(`${title}: ${value}`);
    return parsed;
  };
  return {
    ok: true,
    reservation: {
      code,
      language:
        clip(fields.get('idioma del cliente'), 10)?.toLowerCase() ?? null,
      name: clip(fields.get('nombre'), 100),
      email: email?.toLowerCase() ?? null,
      phone,
      country: clip(fields.get('pais'), 80),
      date: read('fecha', 'Fecha', dateOf),
      time: read('hora', 'Hora', timeOf),
      people: read('personas', 'Personas', peopleOf),
      preference: clipBlock(blocks.get('preferencia'), 2000),
      message: clipBlock(blocks.get('mensaje'), 2000),
      unparsed,
    },
  };
}
