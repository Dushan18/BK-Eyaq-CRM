import type { ConfigService } from '@nestjs/config';
import { EmailConfig } from './email.config';

// Reads only these values: ConfigService would give priority to process.env.
const env = (values: Record<string, string>) =>
  new EmailConfig({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
const enabled = (extra: Record<string, string> = {}) =>
  env({
    EMAIL_ENABLED: 'true',
    EMAIL_IMAP_HOST: 'mail.restaurante.test',
    EMAIL_USER: 'Reservas@Restaurante.test',
    EMAIL_PASSWORD: 'secreta',
    WEB_RESERVATION_SENDERS: 'Web@Restaurante.test, otra@restaurante.test',
    ...extra,
  });

describe('Configuración del correo', () => {
  it('apagada por defecto y sin validar nada', () => {
    const config = env({
      EMAIL_IMAP_PORT: 'abc',
      WEB_RESERVATION_SENDERS: 'x',
    });
    expect(config).toMatchObject({
      enabled: false,
      port: 993,
      whatsappContact: false,
      reservationSenders: [],
    });
  });
  it('activada, con valores por defecto y correos en minúscula', () => {
    expect(enabled()).toMatchObject({
      enabled: true,
      host: 'mail.restaurante.test',
      port: 993,
      secure: true,
      user: 'reservas@restaurante.test',
      mailbox: 'INBOX',
      pollSeconds: 60,
      importSinceDays: 30,
      reservationSenders: ['web@restaurante.test', 'otra@restaurante.test'],
      whatsappContact: false,
      template: 'solicitud_reserva_web',
      templateLanguages: ['es'],
      dailyTemplateLimit: 50,
      contactMaxHours: 24,
      hostingAccount: null,
    });
    expect(enabled().password).toBe('secreta');
  });
  it.each([
    'EMAIL_IMAP_HOST',
    'EMAIL_USER',
    'EMAIL_PASSWORD',
    'WEB_RESERVATION_SENDERS',
  ])('activada exige %s', (key) => {
    expect(() => enabled({ [key]: '' })).toThrow(`${key} requerida`);
  });
  it.each([
    [{ EMAIL_ENABLED: 'TRUE' }, 'EMAIL_ENABLED debe ser true o false'],
    [{ WEB_RESERVATION_WHATSAPP: '1' }, 'WEB_RESERVATION_WHATSAPP debe ser'],
    [{ EMAIL_POLL_SECONDS: '5' }, 'EMAIL_POLL_SECONDS fuera de rango'],
    [
      { WEB_RESERVATION_CONTACT_MAX_HOURS: '0' },
      'WEB_RESERVATION_CONTACT_MAX_HOURS fuera de rango',
    ],
    [{ WEB_RESERVATION_SENDERS: 'no-es-correo' }, 'correos válidos'],
    [{ WEB_RESERVATION_TEMPLATE: 'Con Espacios' }, 'TEMPLATE inválida'],
    [
      { WEB_RESERVATION_HOSTING_ACCOUNT: 'cuenta con espacios' },
      'WEB_RESERVATION_HOSTING_ACCOUNT inválida',
    ],
    [{ WEB_RESERVATION_TEMPLATE_LANGUAGES: 'español' }, 'códigos como es'],
  ])('rechaza configuración inválida %o', (extra, message) => {
    expect(() => enabled(extra)).toThrow(message);
  });
  it('lee la cuenta del hosting que envía los avisos', () => {
    expect(
      enabled({ WEB_RESERVATION_HOSTING_ACCOUNT: 'sabormgic' }).hostingAccount,
    ).toBe('sabormgic');
  });
  it('acepta varios idiomas de plantilla', () => {
    expect(
      enabled({ WEB_RESERVATION_TEMPLATE_LANGUAGES: 'es, en_US' })
        .templateLanguages,
    ).toEqual(['es', 'en_US']);
  });
});
