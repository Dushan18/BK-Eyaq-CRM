import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { EmailConfig } from './email.config';

export interface MailEnvelope {
  uid: bigint;
  subject: string | null;
  fromAddress: string | null;
  // RFC822.SIZE, checked before downloading anything.
  size: number | null;
  // INTERNALDATE: when the mail server received it (the Date header can be anything).
  receivedAt: Date | null;
}
export interface MailboxBatch {
  uidValidity: bigint;
  // UIDNEXT when the mailbox was opened: every message below it was visible to this read.
  // 0 when the server did not report it.
  uidNext: bigint;
  // False when `limit` cut the batch: more messages wait for the next read.
  complete: boolean;
  envelopes: MailEnvelope[];
  // Raw RFC 822 source, only for the envelopes `wanted` selected.
  sources: Map<bigint, Buffer>;
}
export interface MailboxReadRequest {
  // Where the previous read stopped; null on the first read or after a UIDVALIDITY change.
  cursor: { uidValidity: bigint; lastUid: bigint } | null;
  // First read: only messages received since this date.
  since: Date;
  limit: number;
  wanted: (envelope: MailEnvelope) => boolean;
}
// Read-only access to one mailbox. A test replaces it with an in-memory mailbox.
export abstract class MailboxReader {
  abstract read(request: MailboxReadRequest): Promise<MailboxBatch>;
}

const byUid = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

// Reads by UID, oldest first, without changing anything: the mailbox is opened with
// EXAMINE (readOnly) and bodies are fetched with BODY.PEEK, so messages stay unread in
// the webmail. Connects per read: a dropped connection never leaves stale state.
@Injectable()
export class ImapMailboxReader extends MailboxReader {
  constructor(private readonly config: EmailConfig) {
    super();
  }
  async read(request: MailboxReadRequest): Promise<MailboxBatch> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      // Without implicit TLS, STARTTLS is mandatory: never send the password in clear.
      ...(this.config.secure ? {} : { doSTARTTLS: true }),
      logger: false,
      // One short session per poll: no IDLE.
      disableAutoIdle: true,
      // The defaults (90 s to connect, 5 min of socket inactivity) would stall the poll.
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 60000,
      // Sources above the importer's size limit are never requested.
      maxResponseSize: 10 * 1024 * 1024,
    });
    // Without a listener, a socket error after connect would crash the process.
    client.on('error', () => undefined);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(this.config.mailbox, {
        readOnly: true,
      });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new Error('EMAIL_MAILBOX_UNAVAILABLE');
        const uidValidity = BigInt(mailbox.uidValidity);
        const uidNext =
          typeof mailbox.uidNext === 'number' ? BigInt(mailbox.uidNext) : 0n;
        // Collected first: no other IMAP command may run inside a fetch loop.
        let uids: bigint[] = [];
        if (!mailbox.exists) {
          // Empty mailbox: nothing to read.
        } else if (request.cursor?.uidValidity === uidValidity) {
          const from = request.cursor.lastUid + 1n;
          // UIDNEXT only grows when mail arrives: below it there is nothing new.
          if (!uidNext || uidNext > from)
            for await (const message of client.fetch(
              `${from.toString()}:*`,
              { uid: true },
              { uid: true },
            ))
              // "n:*" also returns the newest message when its UID is below n.
              if (BigInt(message.uid) >= from) uids.push(BigInt(message.uid));
        } else {
          const found = await client.search(
            { since: request.since },
            { uid: true },
          );
          // A refused SEARCH is not an empty mailbox: retry on the next poll.
          if (!Array.isArray(found)) throw new Error('EMAIL_SEARCH_FAILED');
          uids = found.map((uid) => BigInt(uid));
        }
        uids.sort(byUid);
        const complete = uids.length <= request.limit;
        uids = uids.slice(0, request.limit);
        const envelopes: MailEnvelope[] = [];
        const sources = new Map<bigint, Buffer>();
        if (!uids.length)
          return { uidValidity, uidNext, complete, envelopes, sources };
        // The server may push unsolicited FETCH rows (flag changes from the webmail) in the
        // middle of this command: only the requested UIDs, once each, are envelopes.
        const requested = new Set(uids);
        for await (const message of client.fetch(
          uids.map(String).join(','),
          { uid: true, envelope: true, size: true, internalDate: true },
          { uid: true },
        )) {
          // A flag update carries no envelope: it is not the answer for its UID.
          const uid =
            typeof message.uid === 'number' ? BigInt(message.uid) : null;
          if (uid === null || !message.envelope || !requested.delete(uid))
            continue;
          const from = message.envelope?.from?.[0]?.address;
          const received =
            message.internalDate instanceof Date &&
            Number.isFinite(message.internalDate.getTime())
              ? message.internalDate
              : null;
          envelopes.push({
            uid,
            subject: message.envelope?.subject ?? null,
            fromAddress: from ? from.toLowerCase() : null,
            size: typeof message.size === 'number' ? message.size : null,
            receivedAt: received,
          });
        }
        envelopes.sort((a, b) => byUid(a.uid, b.uid));
        for (const envelope of envelopes) {
          if (!request.wanted(envelope)) continue;
          const message = await client.fetchOne(
            envelope.uid.toString(),
            { source: true },
            { uid: true },
          );
          if (message && message.source)
            sources.set(envelope.uid, message.source);
        }
        return { uidValidity, uidNext, complete, envelopes, sources };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}
