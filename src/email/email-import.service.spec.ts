import { Logger } from '@nestjs/common';
import { EmailImportService, submittedByAccount } from './email-import.service';
import type { EmailConfig } from './email.config';

function service(read: jest.Mock) {
  const prisma = {
    mailboxCursor: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const config = {
    enabled: true,
    pollSeconds: 60,
    importSinceDays: 30,
    user: 'reservas@restaurante.test',
    mailbox: 'INBOX',
    reservationSenders: ['web@restaurante.test'],
    whatsappContact: false,
    hostingAccount: null,
  } as unknown as EmailConfig;
  return new EmailImportService(
    prisma as never,
    {} as never,
    config,
    { read },
    {} as never,
  );
}
const refused = (serverResponseCode?: string) =>
  Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    serverResponseCode,
  });
const MINUTE = 60 * 1000;

describe('EmailImportService: errores del buzón', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('una contraseña rechazada espera cada vez más antes de reintentar (cPanel bloquea la IP tras varios fallos)', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const read = jest.fn().mockRejectedValue(refused('AUTHENTICATIONFAILED'));
    const importer = service(read);
    importer.onModuleInit();
    await jest.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(29 * MINUTE);
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2 * MINUTE);
    expect(read).toHaveBeenCalledTimes(2);
    // Second refusal: two hours.
    await jest.advanceTimersByTimeAsync(110 * MINUTE);
    expect(read).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(12 * MINUTE);
    expect(read).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"code":"EMAIL_AUTH_FAILED"'),
    );
    await importer.onModuleDestroy();
  });

  it('un rechazo temporal del servidor ([UNAVAILABLE]) se reintenta a los 5 minutos', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const read = jest.fn().mockRejectedValue(refused('UNAVAILABLE'));
    const importer = service(read);
    importer.onModuleInit();
    await jest.advanceTimersByTimeAsync(5000);
    await jest.advanceTimersByTimeAsync(4 * MINUTE);
    expect(read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2 * MINUTE);
    expect(read).toHaveBeenCalledTimes(2);
    await importer.onModuleDestroy();
  });

  it('un fallo de red se reintenta en la siguiente lectura, sin registrar el mensaje del servidor', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const read = jest
      .fn()
      .mockRejectedValue(new Error('NO [ALERT] buzón reservas@x lleno'));
    const importer = service(read);
    importer.onModuleInit();
    await jest.advanceTimersByTimeAsync(5000);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ code: 'EMAIL_IMPORT_UNAVAILABLE', errorName: 'Error' }),
    );
    await importer.onModuleDestroy();
  });
});

describe('submittedByAccount: ¿salió del hosting de la web?', () => {
  // Received lines as the restaurant's server writes them, newest first.
  const lmtp =
    'Received: from bh-63.webhostbox.net\r\n    by bh-63.webhostbox.net with LMTP\r\n    id UGmMABnX42o8ZwsA/O2Vrg';
  const local =
    'Received: from sabormgic by bh-63.webhostbox.net with local (Exim 4.100.1)\r\n    (envelope-from <reservas@sabormagicorestaurant.com>)';
  const outside =
    'Received: from mail.evil.example ([203.0.113.9]:51234 helo=evil) by bh-63.webhostbox.net with esmtps (TLS1.3) (Exim 4.100.1)';

  it('acepta el aviso real de la web (PHP del hosting)', () => {
    expect(submittedByAccount([lmtp, local], 'sabormgic')).toBe(true);
    // Without the final LMTP hop (Exim delivering directly).
    expect(submittedByAccount([local], 'sabormgic')).toBe(true);
  });
  it('rechaza un correo de afuera aunque traiga una línea falsa debajo', () => {
    expect(submittedByAccount([lmtp, outside, local], 'sabormgic')).toBe(false);
  });
  it('rechaza otra cuenta del mismo servidor y un correo sin Received', () => {
    expect(
      submittedByAccount(
        [lmtp, local.replace('sabormgic', 'vecino')],
        'sabormgic',
      ),
    ).toBe(false);
    expect(submittedByAccount([], 'sabormgic')).toBe(false);
  });
});
