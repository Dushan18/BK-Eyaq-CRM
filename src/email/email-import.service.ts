import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { simpleParser } from 'mailparser';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { MessagingTransactionService } from '../messaging/messaging-transaction.service';
import { EmailConfig } from './email.config';
import { MailboxReader, type MailEnvelope } from './mailbox-reader';
import {
  htmlToText,
  parseWebReservation,
  stripControls,
  WEB_RESERVATION_SUBJECT,
} from './web-reservation.parser';
import {
  ImportDeferredError,
  WebReservationService,
  type EmailMeta,
  type ImportInput,
} from './web-reservation.service';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BATCH_SIZE = 100;
// A reservation notice is a few KB: anything this big is not one and is never downloaded.
export const MAX_EMAIL_BYTES = 256 * 1024;
// After this many failed polls on the same email, it is recorded as failed and skipped,
// so one email that can never be stored does not stop every later one.
const MAX_ATTEMPTS = 5;
// cPanel (cPHulk) blocks the server's IP after a few failed logins: a rejected login is
// retried later and later. A temporary refusal ([UNAVAILABLE]) is retried sooner.
const AUTH_BACKOFF_MS = [30, 120, 360].map((minutes) => minutes * MINUTE_MS);
const AUTH_UNAVAILABLE_MS = 5 * MINUTE_MS;
const isReservation = (envelope: MailEnvelope) =>
  WEB_RESERVATION_SUBJECT.test(envelope.subject ?? '');
const tooLarge = (envelope: MailEnvelope) =>
  envelope.size !== null && envelope.size > MAX_EMAIL_BYTES;
const clean = (value: string | null | undefined, max: number) =>
  value ? stripControls(value).slice(0, max) || null : null;
// Header dates are whatever the sender wrote: keep only plausible ones.
const plausible = (date: Date | null | undefined) => {
  const time = date?.getTime();
  return time !== undefined &&
    Number.isFinite(time) &&
    time >= Date.UTC(2000, 0, 1) &&
    time <= Date.now() + DAY_MS
    ? date!
    : null;
};

// True when the restaurant's own mail server received the email from this hosting
// account's local submission (the website's PHP). Received lines are newest first: the
// first one that is not the final delivery into the mailbox (Dovecot LMTP/LDA) is the
// server accepting the message, and a sender cannot forge it; forged lines can only
// appear below it.
export function submittedByAccount(received: string[], account: string) {
  const hop = received
    .map((line) =>
      line
        .slice(0, 2000)
        .replace(/^received:/i, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((line) => !/\bwith (lmtp|lda)\b/i.test(line));
  const name = account.replace(/\./g, '\\.');
  return (
    !!hop && new RegExp(`^from ${name} by \\S+ with local\\b`, 'i').test(hop)
  );
}

// Polls the mailbox and imports the website's reservation emails, oldest first. The cursor
// advances in the same transaction as each import, so a failure retries that email on the
// next poll and never skips or duplicates it. Other emails are not downloaded.
@Injectable()
export class EmailImportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailImportService.name);
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private pausedUntil = 0;
  private authFailures = 0;
  // Consecutive failed polls on the email that blocks the batch.
  private failing = { key: '', count: 0 };
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: MessagingTransactionService,
    private readonly config: EmailConfig,
    private readonly reader: MailboxReader,
    private readonly reservations: WebReservationService,
  ) {}
  onModuleInit() {
    if (!this.config.enabled) return;
    if (this.config.whatsappContact && !this.config.hostingAccount)
      this.logger.warn(
        JSON.stringify({
          code: 'EMAIL_SENDER_UNVERIFIED',
          action:
            'Sin WEB_RESERVATION_HOSTING_ACCOUNT, un correo con el remitente falsificado puede hacer que se envíen plantillas de WhatsApp',
        }),
      );
    this.timer = setInterval(() => this.tick(), this.config.pollSeconds * 1000);
    this.timer.unref();
    // A first read shortly after startup, without delaying it.
    this.first = setTimeout(() => this.tick(), 5000);
    this.first.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    await this.running;
  }
  private tick() {
    if (this.running || this.stopped || Date.now() < this.pausedUntil) return;
    this.running = this.runOnce()
      .then(() => {
        this.authFailures = 0;
      })
      .catch((error: unknown) => this.failed(error))
      .finally(() => {
        this.running = undefined;
      });
  }
  private failed(error: unknown) {
    const auth = error as {
      authenticationFailed?: unknown;
      serverResponseCode?: unknown;
    };
    if (error instanceof Error && auth.authenticationFailed === true) {
      const code =
        typeof auth.serverResponseCode === 'string'
          ? auth.serverResponseCode.slice(0, 40)
          : null;
      const wait =
        code === 'UNAVAILABLE'
          ? AUTH_UNAVAILABLE_MS
          : AUTH_BACKOFF_MS[
              Math.min(this.authFailures++, AUTH_BACKOFF_MS.length - 1)
            ];
      this.pausedUntil = Date.now() + wait;
      this.logger.error(
        JSON.stringify({
          code: 'EMAIL_AUTH_FAILED',
          serverResponseCode: code,
          retryInMinutes: wait / MINUTE_MS,
          action:
            'El servidor rechazó el acceso al correo: revisa EMAIL_USER y EMAIL_PASSWORD y reinicia el backend (cPanel bloquea la IP tras varios intentos fallidos)',
        }),
      );
      return;
    }
    // Never the error message: IMAP errors may echo the account or server reply.
    this.logger.warn(
      JSON.stringify({
        code:
          error instanceof ImportDeferredError
            ? 'EMAIL_IMPORT_DEFERRED'
            : 'EMAIL_IMPORT_UNAVAILABLE',
        errorName: error instanceof Error ? error.name : 'Unknown',
      }),
    );
  }
  get mailbox() {
    return `${this.config.user}:${this.config.mailbox}`.slice(0, 320);
  }
  private allowed(envelope: MailEnvelope) {
    return (
      !!envelope.fromAddress &&
      this.config.reservationSenders.includes(envelope.fromAddress)
    );
  }

  async runOnce() {
    const mailbox = this.mailbox;
    const cursor = await this.prisma.mailboxCursor.findUnique({
      where: { mailbox },
    });
    const batch = await this.reader.read({
      cursor: cursor
        ? { uidValidity: cursor.uidValidity, lastUid: cursor.lastUid }
        : null,
      since: new Date(Date.now() - this.config.importSinceDays * DAY_MS),
      limit: BATCH_SIZE,
      // Other senders and oversized emails are never downloaded or parsed.
      wanted: (envelope) =>
        isReservation(envelope) &&
        this.allowed(envelope) &&
        !tooLarge(envelope),
    });
    if (cursor && cursor.uidValidity !== batch.uidValidity)
      this.logger.warn(JSON.stringify({ code: 'EMAIL_UIDVALIDITY_CHANGED' }));
    let lastUid = 0n;
    for (const envelope of batch.envelopes) {
      lastUid = envelope.uid;
      if (!isReservation(envelope)) continue;
      const meta: EmailMeta = {
        mailbox,
        uidValidity: batch.uidValidity,
        uid: envelope.uid,
        messageId: null,
        fromAddress: clean(envelope.fromAddress, 320),
        subject: clean(envelope.subject, 998),
        sentAt: null,
        receivedAt: plausible(envelope.receivedAt),
        fromHostingAccount: null,
      };
      const result: ImportInput = !this.allowed(envelope)
        ? { ok: false, errorCode: 'SENDER_NOT_ALLOWED' }
        : tooLarge(envelope)
          ? { ok: false, errorCode: 'EMAIL_TOO_LARGE' }
          : await this.read(batch.sources.get(envelope.uid), meta);
      const email = await this.importOne(meta, result);
      this.logger.log(
        JSON.stringify({
          code: 'EMAIL_WEB_RESERVATION',
          uid: envelope.uid.toString(),
          inboundEmailId: email.id,
          status: email.status,
          errorCode: email.errorCode,
          contactError: email.contactError,
          externalReference: email.externalReference,
        }),
      );
    }
    // Caught up: everything below UIDNEXT was seen (older mail outside the first read's
    // date range included), so the next read starts after it.
    const caughtUp = batch.uidNext > 0n ? batch.uidNext - 1n : 0n;
    const target = batch.complete && caughtUp > lastUid ? caughtUp : lastUid;
    await this.transactions.run((tx) =>
      this.advance(tx, mailbox, batch.uidValidity, target),
    );
  }

  // One email: its record and the cursor advance commit together. Reading the same UID
  // again (cursor moved back, two instances) returns the existing record. An email that
  // keeps failing is recorded as EMAIL_UNSTORABLE after MAX_ATTEMPTS polls; a missing
  // restaurant configuration (ImportDeferredError) is retried without limit.
  private async importOne(meta: EmailMeta, result: ImportInput) {
    const key = `${meta.mailbox}:${meta.uidValidity}:${meta.uid}`;
    const store = (tx: Prisma.TransactionClient, input: ImportInput) =>
      this.reservations.import(tx, meta, input);
    try {
      const email = await this.transactions.run(async (tx) => {
        const existing = await tx.inboundEmail.findUnique({
          where: {
            mailbox_uidValidity_uid: {
              mailbox: meta.mailbox,
              uidValidity: meta.uidValidity,
              uid: meta.uid,
            },
          },
        });
        const row = existing ?? (await store(tx, result));
        await this.advance(tx, meta.mailbox, meta.uidValidity, meta.uid);
        return row;
      });
      this.failing = { key: '', count: 0 };
      return email;
    } catch (error) {
      if (error instanceof ImportDeferredError) throw error;
      const count = this.failing.key === key ? this.failing.count + 1 : 1;
      this.failing = { key, count };
      if (count < MAX_ATTEMPTS) throw error;
      this.logger.error(
        JSON.stringify({
          code: 'EMAIL_UNSTORABLE',
          uid: meta.uid.toString(),
          errorName: error instanceof Error ? error.name : 'Unknown',
        }),
      );
      // Only the identifiers: whatever made it fail is not written again.
      Object.assign(meta, {
        messageId: null,
        fromAddress: null,
        subject: null,
        sentAt: null,
      });
      const email = await this.transactions.run(async (tx) => {
        const row = await store(tx, {
          ok: false,
          errorCode: 'EMAIL_UNSTORABLE',
        });
        await this.advance(tx, meta.mailbox, meta.uidValidity, meta.uid);
        return row;
      });
      this.failing = { key: '', count: 0 };
      return email;
    }
  }

  // Parses the raw email; the subject, sender and Message-ID come from the parsed
  // headers when available.
  private async read(
    source: Buffer | undefined,
    meta: EmailMeta,
  ): Promise<ImportInput> {
    if (!source) return { ok: false, errorCode: 'EMAIL_UNREADABLE' };
    try {
      // Our own HTML conversion: mailparser's wraps lines and appends link targets.
      const parsed = await simpleParser(source, {
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipImageLinks: true,
      });
      meta.subject = clean(parsed.subject, 998) ?? meta.subject;
      meta.fromAddress =
        clean(parsed.from?.value[0]?.address?.toLowerCase(), 320) ??
        meta.fromAddress;
      meta.messageId = clean(parsed.messageId, 998);
      meta.sentAt = plausible(parsed.date);
      if (this.config.hostingAccount)
        meta.fromHostingAccount = submittedByAccount(
          parsed.headerLines
            .filter((header) => header.key === 'received')
            .map((header) => header.line),
          this.config.hostingAccount,
        );
      const body =
        parsed.text?.trim() ||
        (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '');
      return parseWebReservation(meta.subject, body);
    } catch {
      return { ok: false, errorCode: 'EMAIL_UNREADABLE' };
    }
  }
  // Only moves forward, except when the mailbox has a new UIDVALIDITY.
  private async advance(
    tx: Prisma.TransactionClient,
    mailbox: string,
    uidValidity: bigint,
    uid: bigint,
  ) {
    const current = await tx.mailboxCursor.findUnique({ where: { mailbox } });
    if (
      current &&
      current.uidValidity === uidValidity &&
      current.lastUid >= uid
    )
      return;
    await tx.mailboxCursor.upsert({
      where: { mailbox },
      create: { mailbox, uidValidity, lastUid: uid },
      update: { uidValidity, lastUid: uid },
    });
  }
}
