import { ImapFlow, type FetchMessageObject } from 'imapflow';
import type { ImapAccount, ImapConfig, MailCodeConfig, MailKind } from './mailCodeConfig';
import { kindCode, parseMail, type ParsedMail } from './mailKinds';

const DAY_MS = 24 * 60 * 60 * 1000;

export type FindResult =
  | { status: 'found'; code: string; receivedAt: number; subject: string }
  /** Самое новое письмо нужного вида есть, но код из него не вырезан или вид неоднозначен. */
  | { status: 'unparsed'; receivedAt: number; subject: string }
  | { status: 'none' };

export interface Candidate {
  folder: string;
  uid: number;
  /** INTERNALDATE: когда письмо пришло на почтовый сервер. */
  receivedAt: number;
  subject: string;
  /** Папка + UIDVALIDITY + UID: однозначно определяет письмо для кэша. */
  key: string;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** INTERNALDATE хранится с точностью до секунды: письмо, пришедшее в ту же секунду, что sent_after, не теряем. */
export function receivedAfter(receivedAt: number, sentAfterMs: number): boolean {
  return receivedAt >= Math.floor(sentAfterMs / 1000) * 1000;
}

/** Получатели: To, Cc и заголовки доставки (если алиас был в скрытой копии). */
export function messageRecipients(msg: Pick<FetchMessageObject, 'envelope' | 'headers'>): string[] {
  const addresses = [...(msg.envelope?.to ?? []), ...(msg.envelope?.cc ?? [])].map(a => a.address ?? '');
  addresses.push(...(msg.headers?.toString('utf8').match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []));
  return addresses.filter(Boolean).map(a => a.toLowerCase());
}

/** Один ящик родителя: своё IMAP-подключение, только чтение (EXAMINE + BODY.PEEK — письма не помечаются прочитанными). */
export class Mailbox {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private folders: string[] = [];
  private retryAt = 0;
  private lastError = '';
  // Отказ во входе не повторяем до перезапуска: частые неудачные входы могут заблокировать Apple ID.
  private authError = '';
  private parsed = new Map<string, ParsedMail>();

  constructor(readonly account: ImapAccount, private readonly cfg: ImapConfig, private readonly log: (msg: string) => void) {}

  async open(): Promise<{ client: ImapFlow; folders: string[] }> {
    if (this.authError) throw new Error(this.authError);
    if (!this.client?.usable) {
      if (Date.now() < this.retryAt) throw new Error(this.lastError);
      this.connecting ??= this.connect().finally(() => { this.connecting = null; });
      await this.connecting;
    }
    return { client: this.client!, folders: this.folders };
  }

  private async connect(): Promise<ImapFlow> {
    const { email, user, password, proxy } = this.account;
    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: true,
      auth: { user: user || email, pass: password },
      proxy: proxy || undefined,
      logger: false,
    });
    client.on('error', error => this.log(`IMAP ${email}: ${message(error)}`));
    client.on('close', () => { if (this.client === client) this.client = null; });
    try {
      await client.connect();
      // GGPass может попасть в спам, поэтому кроме INBOX смотрим папку \Junk.
      const junk = (await client.list()).find(box => box.specialUse === '\\Junk');
      this.folders = junk ? ['INBOX', junk.path] : ['INBOX'];
      this.client = client;
      return client;
    } catch (error) {
      client.close();
      if ((error as { authenticationFailed?: boolean }).authenticationFailed) {
        this.authError = `IMAP ${email}: вход не принят. Проверьте логин и app-specific пароль в mail-code.json и перезапустите сервис.`;
        throw new Error(this.authError);
      }
      this.lastError = `IMAP ${email}: не удалось подключиться: ${message(error)}`;
      this.retryAt = Date.now() + this.cfg.reconnectDelayMs;
      throw new Error(this.lastError);
    }
  }

  /** Письма на адрес email, пришедшие не раньше sentAfterMs (0 — без фильтра по времени). */
  async candidates(email: string, sentAfterMs: number): Promise<Candidate[]> {
    const { client, folders } = await this.open();
    const found: Candidate[] = [];
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const uidValidity = client.mailbox ? client.mailbox.uidValidity : 0n;
        // SINCE сравнивает только даты, поэтому берём день с запасом и точно фильтруем по INTERNALDATE сами.
        const query = sentAfterMs > 0 ? { since: new Date(sentAfterMs - DAY_MS) } : { to: email };
        const uids = await client.search(query, { uid: true });
        if (!uids || !uids.length) continue;
        const fields = { uid: true, envelope: true, internalDate: true, headers: ['delivered-to', 'x-original-to'] };
        for await (const msg of client.fetch(uids, fields, { uid: true })) {
          const receivedAt = new Date(msg.internalDate ?? 0).getTime();
          if (!receivedAfter(receivedAt, sentAfterMs) || !messageRecipients(msg).includes(email)) continue;
          found.push({ folder, uid: msg.uid, receivedAt, subject: msg.envelope?.subject ?? '', key: `${folder}:${uidValidity}:${msg.uid}` });
        }
      } finally { lock.release(); }
    }
    return found;
  }

  async source(folder: string, uid: number): Promise<Buffer> {
    const { client } = await this.open();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`IMAP ${this.account.email}: письмо ${folder}/${uid} не найдено`);
      return msg.source;
    } finally { lock.release(); }
  }

  async read(candidate: Candidate): Promise<ParsedMail> {
    const cached = this.parsed.get(candidate.key);
    if (cached) return cached;
    const mail = await parseMail(await this.source(candidate.folder, candidate.uid));
    if (this.parsed.size >= 500) this.parsed.clear();
    this.parsed.set(candidate.key, mail);
    return mail;
  }

  async close(): Promise<void> {
    await this.client?.logout().catch(() => undefined);
    this.client = null;
  }
}

/** Все ящики родителей. Реестра алиасов в кластере пока нет, поэтому письмо ищется во всех ящиках сразу. */
export class Mailboxes {
  readonly boxes: Mailbox[];
  /** Ящики, которые при последнем поиске прочитались без ошибок: для их алиасов браузерный путь не нужен. */
  private healthy: string[] = [];

  constructor(private readonly cfg: MailCodeConfig, log: (msg: string) => void) {
    this.boxes = cfg.imap.accounts.map(account => new Mailbox(account, cfg.imap, log));
  }

  healthyEmails(): string[] {
    return this.healthy;
  }

  async find(email: string, kind: MailKind, sentAfterMs: number): Promise<FindResult> {
    if (!this.boxes.length) throw new Error('в mail-code.json не задан ни один IMAP-аккаунт');
    const settled = await Promise.allSettled(this.boxes.map(async box =>
      (await box.candidates(email, sentAfterMs)).map(candidate => ({ box, candidate }))));
    this.healthy = this.boxes.filter((_, i) => settled[i].status === 'fulfilled').map(box => box.account.email);
    const errors = settled.flatMap(r => r.status === 'rejected' ? [message(r.reason)] : []);
    const newestFirst = settled.flatMap(r => r.status === 'fulfilled' ? r.value : [])
      .sort((a, b) => b.candidate.receivedAt - a.candidate.receivedAt || b.candidate.uid - a.candidate.uid);
    for (const { box, candidate } of newestFirst) {
      const mail = await box.read(candidate);
      // Берём только самое новое письмо нужного вида: коды из старых GGPass уже не примет.
      // Подходит и под другой вид — не угадываем и к старым письмам не идём.
      const extracted = kindCode(mail, kind, this.cfg.kinds);
      if (extracted === undefined) continue;
      return extracted
        ? { status: 'found', code: extracted.code, receivedAt: candidate.receivedAt, subject: mail.subject }
        : { status: 'unparsed', receivedAt: candidate.receivedAt, subject: mail.subject };
    }
    // Письмо могло лежать в ящике, до которого не достучались: это не NOT_FOUND.
    if (errors.length) throw new Error(errors.join('; '));
    return { status: 'none' };
  }

  /** Подключает все ящики при старте, чтобы ошибки входа сразу были видны в логе. */
  async connectAll(): Promise<string[]> {
    const settled = await Promise.allSettled(this.boxes.map(box => box.open()));
    return settled.flatMap(r => r.status === 'rejected' ? [message(r.reason)] : []);
  }

  async close(): Promise<void> {
    await Promise.all(this.boxes.map(box => box.close()));
  }
}
