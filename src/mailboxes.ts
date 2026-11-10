import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import type { ImapAccount, ImapConfig, MailCodeConfig, MailKind } from './mailCodeConfig';
import { kindCode, parseMail, type ParsedMail } from './mailKinds';
import type { ImapState, ImapStatusEntry } from './imapAccounts';

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
  // Отказ во входе не повторяем, пока не сменится пароль: частые неудачные входы могут заблокировать Apple ID.
  private authError = '';
  private parsed = new Map<string, ParsedMail>();

  constructor(
    readonly account: ImapAccount,
    private readonly cfg: ImapConfig,
    private readonly log: (msg: string) => void,
    private readonly onState: (state: ImapState, error: string) => void = () => {},
  ) {}

  get authFailed(): boolean {
    return !!this.authError;
  }

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
      connectionTimeout: 30000,
    });
    client.on('error', error => this.log(`IMAP ${email}: ${message(error)}`));
    client.on('close', () => { if (this.client === client) this.client = null; });
    try {
      await client.connect();
      // GGPass может попасть в спам, поэтому кроме INBOX смотрим папку \Junk.
      const junk = (await client.list()).find(box => box.specialUse === '\\Junk');
      this.folders = junk ? ['INBOX', junk.path] : ['INBOX'];
      this.client = client;
      this.onState('connected', '');
      return client;
    } catch (error) {
      client.close();
      if ((error as { authenticationFailed?: boolean }).authenticationFailed) {
        this.authError = `IMAP ${email}: вход не принят. Проверьте app-specific пароль (вкладка «Родители» или mail-code.json).`;
        this.onState('auth', this.authError);
        throw new Error(this.authError);
      }
      this.lastError = `IMAP ${email}: не удалось подключиться: ${message(error)}`;
      this.retryAt = Date.now() + this.cfg.reconnectDelayMs;
      this.onState('error', this.lastError);
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

/** Родитель алиаса по базе основного сервиса; null — алиас неизвестен или база недоступна. */
export interface AliasOwner {
  parentOf(alias: string): string | null;
}

export interface MailboxesOptions {
  registry?: AliasOwner;
  /** Куда писать состояние ящиков для окна (imap-status.json); пусто — не писать. */
  statusFile?: string;
}

const sameAccount = (a: ImapAccount, b: ImapAccount) => (a.user ?? '') === (b.user ?? '') && a.password === b.password && (a.proxy ?? '') === (b.proxy ?? '');

/**
 * Ящики родителей. Если основной сервис знает родителя алиаса, письмо ищется только в его ящике;
 * алиас неизвестен (или у родителя нет своего ящика в списке) — во всех ящиках сразу.
 */
export class Mailboxes {
  private byEmail = new Map<string, Mailbox>();
  /** Ящики, прочитанные без ошибок при последнем поиске этого алиаса: для них браузерный путь не нужен. */
  private healthy = new Map<string, string[]>();
  private status: Record<string, ImapStatusEntry> = {};
  private statusTimer: NodeJS.Timeout | undefined;

  constructor(private readonly cfg: MailCodeConfig, private readonly log: (msg: string) => void, private readonly options: MailboxesOptions = {}) {
    for (const account of cfg.imap.accounts) this.add(account);
  }

  get boxes(): Mailbox[] {
    return [...this.byEmail.values()];
  }

  size(): number {
    return this.byEmail.size;
  }

  private add(account: ImapAccount): void {
    const box = new Mailbox(account, this.cfg.imap, this.log, (state, error) => {
      // Ящик уже заменён (сменился пароль): его состояние больше не показываем.
      if (this.byEmail.get(account.email) !== box) return;
      this.status[account.email] = { state, error, at: Date.now() };
      this.writeStatus();
    });
    this.byEmail.set(account.email, box);
  }

  /**
   * Новый список аккаунтов из mail-code.json без перезапуска: новые ящики добавляются, удалённые закрываются,
   * ящик со сменившимся паролем, логином или прокси создаётся заново (в том числе после отказа во входе).
   */
  reload(accounts: ImapAccount[]): { added: string[]; changed: string[]; removed: string[] } {
    const result = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
    const next = new Map(accounts.map(account => [account.email, account]));
    for (const [email, box] of [...this.byEmail]) {
      const account = next.get(email);
      if (account && sameAccount(account, box.account)) continue;
      this.byEmail.delete(email);
      delete this.status[email];
      void box.close();
      (account ? result.changed : result.removed).push(email);
    }
    for (const account of accounts) {
      if (this.byEmail.has(account.email)) continue;
      this.add(account);
      if (!result.changed.includes(account.email)) result.added.push(account.email);
    }
    this.writeStatus();
    return result;
  }

  healthyEmails(email: string): string[] {
    return this.healthy.get(email) ?? [];
  }

  /** Состояние ящиков, в которые уже пробовали войти (то же, что пишется в imap-status.json). */
  statusSnapshot(): Record<string, ImapStatusEntry> {
    return { ...this.status };
  }

  /** Ящики, в которых искать письмо на алиас. */
  private targets(email: string): Mailbox[] {
    const owner = this.options.registry?.parentOf(email);
    if (owner) {
      const own = this.boxes.find(box => box.account.email === owner || box.account.user?.toLowerCase() === owner);
      if (own) return [own];
    }
    return this.boxes;
  }

  async find(email: string, kind: MailKind, sentAfterMs: number): Promise<FindResult> {
    const boxes = this.targets(email);
    if (!boxes.length) throw new Error('в mail-code.json не задан ни один IMAP-аккаунт');
    const settled = await Promise.allSettled(boxes.map(async box =>
      (await box.candidates(email, sentAfterMs)).map(candidate => ({ box, candidate }))));
    if (this.healthy.size >= 1000) this.healthy.clear();
    this.healthy.set(email, boxes.filter((_, i) => settled[i].status === 'fulfilled').map(box => box.account.email));
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

  /** Подключает ящики (все или перечисленные), чтобы ошибки входа сразу были видны в логе и в окне. */
  async connectAll(emails?: string[]): Promise<string[]> {
    const boxes = emails ? this.boxes.filter(box => emails.includes(box.account.email)) : this.boxes;
    const settled = await Promise.allSettled(boxes.map(box => box.open()));
    return settled.flatMap(r => r.status === 'rejected' ? [message(r.reason)] : []);
  }

  private writeStatus(): void {
    const file = this.options.statusFile;
    if (!file || this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ pid: process.pid, updatedAt: Date.now(), accounts: this.status }, null, 2));
        renameSync(temporary, file);
      } catch (error) {
        rmSync(temporary, { force: true });
        this.log(`не удалось записать ${file}: ${message(error)}`);
      }
    }, 200);
    this.statusTimer.unref();
  }

  async close(): Promise<void> {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.options.statusFile) rmSync(this.options.statusFile, { force: true });
    await Promise.all(this.boxes.map(box => box.close()));
  }
}
