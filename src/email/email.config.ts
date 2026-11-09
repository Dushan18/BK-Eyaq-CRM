import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { envFlag, envInteger, envValue } from '../common/env-values';

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Reads the restaurant mailbox over IMAP (read-only) to import the website's reservation
// notifications. Off by default; nothing is validated while it is off.
@Injectable()
export class EmailConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly mailbox: string;
  readonly pollSeconds: number;
  readonly importSinceDays: number;
  // Only emails From one of these addresses can create requests: anyone can send an
  // email with the same subject, and each request may cost a WhatsApp template.
  readonly reservationSenders: readonly string[];
  // The From header can be forged; the Received line the restaurant's own mail server adds
  // cannot. When set, a notice must come from this hosting account's local submission
  // ("Received: from <account> by <server> with local"), i.e. from the website's PHP.
  readonly hostingAccount: string | null;
  readonly whatsappContact: boolean;
  // Older notices are imported without writing to the customer: someone probably
  // handled them already (the first read after enabling this, or a long outage).
  readonly contactMaxHours: number;
  readonly template: string;
  readonly templateLanguages: readonly string[];
  readonly dailyTemplateLimit: number;
  constructor(private readonly config: ConfigService) {
    this.enabled = envFlag(config, 'EMAIL_ENABLED', false);
    const on = <T>(read: () => T, fallback: T) =>
      this.enabled ? read() : fallback;
    this.host = on(() => this.required('EMAIL_IMAP_HOST'), '');
    this.port = on(
      () => envInteger(config, 'EMAIL_IMAP_PORT', 993, 1, 65535),
      993,
    );
    this.secure = on(() => envFlag(config, 'EMAIL_IMAP_SECURE', true), true);
    this.user = on(() => this.required('EMAIL_USER').toLowerCase(), '');
    if (this.enabled) this.required('EMAIL_PASSWORD');
    this.mailbox = on(
      () => envValue(config, 'EMAIL_MAILBOX') ?? 'INBOX',
      'INBOX',
    );
    this.pollSeconds = on(
      () => envInteger(config, 'EMAIL_POLL_SECONDS', 60, 15, 3600),
      60,
    );
    this.importSinceDays = on(
      () => envInteger(config, 'EMAIL_IMPORT_SINCE_DAYS', 30, 1, 365),
      30,
    );
    this.reservationSenders = on(() => {
      const senders = this.required('WEB_RESERVATION_SENDERS')
        .split(',')
        .map((sender) => sender.trim().toLowerCase())
        .filter(Boolean);
      if (!senders.length || !senders.every((sender) => ADDRESS.test(sender)))
        throw new Error('WEB_RESERVATION_SENDERS debe listar correos válidos');
      return senders;
    }, []);
    this.hostingAccount = on(() => {
      const account = envValue(config, 'WEB_RESERVATION_HOSTING_ACCOUNT');
      if (account !== undefined && !/^[a-z0-9_.-]{1,32}$/i.test(account))
        throw new Error('WEB_RESERVATION_HOSTING_ACCOUNT inválida');
      return account ?? null;
    }, null);
    this.whatsappContact = on(
      () => envFlag(config, 'WEB_RESERVATION_WHATSAPP', false),
      false,
    );
    this.contactMaxHours = on(
      () => envInteger(config, 'WEB_RESERVATION_CONTACT_MAX_HOURS', 24, 1, 168),
      24,
    );
    this.template = on(
      () =>
        envValue(config, 'WEB_RESERVATION_TEMPLATE') ?? 'solicitud_reserva_web',
      'solicitud_reserva_web',
    );
    if (!/^[a-z0-9_]{1,512}$/.test(this.template))
      throw new Error('WEB_RESERVATION_TEMPLATE inválida');
    this.templateLanguages = on(
      () =>
        (envValue(config, 'WEB_RESERVATION_TEMPLATE_LANGUAGES') ?? 'es')
          .split(',')
          .map((language) => language.trim())
          .filter(Boolean),
      ['es'],
    );
    if (
      !this.templateLanguages.length ||
      !this.templateLanguages.every((language) =>
        /^[a-z]{2,3}(_[A-Z]{2})?$/.test(language),
      )
    )
      throw new Error(
        'WEB_RESERVATION_TEMPLATE_LANGUAGES debe listar códigos como es o en_US',
      );
    this.dailyTemplateLimit = on(
      () => envInteger(config, 'WEB_RESERVATION_DAILY_LIMIT', 50, 1, 1000),
      50,
    );
  }
  get password() {
    return envValue(this.config, 'EMAIL_PASSWORD') ?? '';
  }
  private required(key: string) {
    const value = envValue(this.config, key);
    if (value === undefined) throw new Error(`${key} requerida`);
    return value;
  }
}
