import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ImapAccount, SnapshotConfig } from './mailCodeConfig';
import type { AliasOwner, Mailboxes } from './mailboxes';
import type { ImapStatusEntry } from './imapAccounts';

/**
 * Снимок, который приложение на Windows отправляет сервису кодов в кластере: ящики родителей
 * (IMAP-пароли вводятся в окне) и родитель каждого алиаса (для поиска письма только в его ящике).
 * Каждый снимок полный: принятый снимок целиком заменяет прежний.
 */
export interface Snapshot {
  accounts: ImapAccount[];
  /** Алиас → e-mail родителя. */
  aliases: Record<string, string>;
}

/** Что сервис в кластере отвечает на GET /status и PUT /snapshot. */
export interface SnapshotStatus {
  /** Версия принятого снимка; null — после запуска снимка ещё не было. */
  version: string | null;
  receivedAt: number | null;
  /** Состояние ящиков по e-mail аккаунта. */
  accounts: Record<string, ImapStatusEntry>;
}

/** Версию считает отправитель: по ней видно, что у сервиса в кластере уже этот снимок (или он перезапущен и снимка нет). */
export function snapshotVersion(snapshot: Snapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROXY_RE = /^(socks[45]?|https?):\/\/\S+$/i;

export class SnapshotError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Проверяет тело PUT /snapshot. Пароли в тексте ошибок не попадают. */
export function parseSnapshot(body: unknown): { version: string; snapshot: Snapshot } {
  const raw = body as { version?: unknown; accounts?: unknown; aliases?: unknown } | null;
  if (!raw || typeof raw !== 'object') throw new SnapshotError('тело: JSON-объект { version, accounts, aliases }');
  const version = str(raw.version);
  if (!version || version.length > 200) throw new SnapshotError('version: непустая строка');
  if (!Array.isArray(raw.accounts)) throw new SnapshotError('accounts: массив');
  const accounts: ImapAccount[] = [];
  for (const [i, item] of raw.accounts.entries()) {
    const a = item as Record<string, unknown> | null;
    const email = str(a?.email).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new SnapshotError(`accounts[${i}].email: e-mail родителя`);
    if (accounts.some(account => account.email === email)) throw new SnapshotError(`accounts[${i}]: ${email} повторяется`);
    if (typeof a?.password !== 'string' || !a.password.trim()) throw new SnapshotError(`accounts[${i}] (${email}): нет пароля`);
    const user = str(a.user);
    const proxy = str(a.proxy);
    if (proxy && !PROXY_RE.test(proxy)) throw new SnapshotError(`accounts[${i}] (${email}).proxy: socks5://… или http://…`);
    accounts.push({ email, password: a.password.trim(), ...(user ? { user } : {}), ...(proxy ? { proxy } : {}) });
  }
  if (!raw.aliases || typeof raw.aliases !== 'object' || Array.isArray(raw.aliases)) throw new SnapshotError('aliases: объект { алиас: родитель }');
  const aliases: Record<string, string> = {};
  for (const [alias, parent] of Object.entries(raw.aliases)) {
    const a = alias.trim().toLowerCase();
    const p = str(parent).toLowerCase();
    if (!EMAIL_RE.test(a) || !EMAIL_RE.test(p)) throw new SnapshotError(`aliases: «${alias}» → «${String(parent)}» — нужны два e-mail`);
    aliases[a] = p;
  }
  return { version, snapshot: { accounts, aliases } };
}

/** Родитель алиаса по последнему снимку; пока снимка нет — null, и письмо ищется во всех ящиках. */
export class SnapshotRegistry implements AliasOwner {
  private owners = new Map<string, string>();

  parentOf(alias: string): string | null {
    return this.owners.get(alias.trim().toLowerCase()) ?? null;
  }

  replace(aliases: Record<string, string>): void {
    this.owners = new Map(Object.entries(aliases));
  }

  get size(): number {
    return this.owners.size;
  }
}

export interface SnapshotTarget {
  mailboxes: Pick<Mailboxes, 'reload' | 'connectAll' | 'statusSnapshot' | 'size'>;
  registry: SnapshotRegistry;
  log: (message: string) => void;
  now?: () => number;
}

/** Принимает снимки и отдаёт состояние ящиков. Хранит только последнюю версию: пароли живут в Mailboxes. */
export class SnapshotReceiver {
  private version: string | null = null;
  private receivedAt: number | null = null;

  constructor(private readonly target: SnapshotTarget) {}

  get received(): boolean {
    return this.version !== null;
  }

  status(): SnapshotStatus {
    return { version: this.version, receivedAt: this.receivedAt, accounts: this.target.mailboxes.statusSnapshot() };
  }

  apply(version: string, snapshot: Snapshot): SnapshotStatus {
    const { mailboxes, registry, log } = this.target;
    const first = !this.received;
    const changes = mailboxes.reload(snapshot.accounts);
    registry.replace(snapshot.aliases);
    this.version = version;
    this.receivedAt = (this.target.now ?? Date.now)();
    const list = (emails: string[]) => emails.join(', ') || '—';
    const changed = changes.added.length || changes.changed.length || changes.removed.length;
    log(`снимок от приложения ${first ? 'получен' : 'обновлён'}: ящиков ${mailboxes.size()}, алиасов ${registry.size}` +
      (changed ? ` — ящики добавлены: ${list(changes.added)}; изменены: ${list(changes.changed)}; удалены: ${list(changes.removed)}` : ''));
    const touched = [...changes.added, ...changes.changed];
    if (touched.length) {
      void mailboxes.connectAll(touched).then(errors => {
        for (const error of errors) log(error);
      });
    }
    return this.status();
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? '';
  // Сравниваем хэши: одинаковая длина для timingSafeEqual и никакой зависимости времени от совпавшего префикса.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return !!given && timingSafeEqual(digest(given), digest(token));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes) { reject(new SnapshotError(`снимок больше snapshot.maxBytes (${maxBytes} байт)`, 413)); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new SnapshotError(`снимок больше snapshot.maxBytes (${maxBytes} байт)`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new SnapshotError('тело: некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * HTTP для приложения на Windows (через ingress): PUT /snapshot — новый снимок, GET /status — что принято и как ящики.
 * GET /healthz без авторизации — для проверок ingress. Остальное — 404.
 */
export async function startSnapshotServer(cfg: SnapshotConfig, receiver: SnapshotReceiver, log: (message: string) => void): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const route = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && route === '/healthz') { send(res, 200, { ok: true }); return; }
    if (!['/status', '/snapshot'].includes(route)) { send(res, 404, { error: 'нет такого пути' }); return; }
    if (!tokenMatches(req.headers.authorization, cfg.token)) {
      log(`снимок: отказ ${req.method} ${route} с ${req.socket.remoteAddress ?? '?'} — неверный токен`);
      send(res, 401, { error: 'неверный токен: cluster.token в config.json приложения должен совпадать с SNAPSHOT_TOKEN' });
      return;
    }
    if (req.method === 'GET' && route === '/status') { send(res, 200, receiver.status()); return; }
    if (req.method !== 'PUT' || route !== '/snapshot') { send(res, 405, { error: 'GET /status или PUT /snapshot' }); return; }
    readBody(req, cfg.maxBytes).then(body => {
      const { version, snapshot } = parseSnapshot(body);
      send(res, 200, receiver.apply(version, snapshot));
    }).catch(error => {
      const status = error instanceof SnapshotError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      log(`снимок не принят (${status}): ${message}`);
      if (!res.headersSent) send(res, status, { error: message });
    });
  });
  // Снимок с тысячами алиасов идёт не мгновенно, но зависшее соединение держать незачем.
  server.requestTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); });
  });
  return { server, port: (server.address() as AddressInfo).port };
}
