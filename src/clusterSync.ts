import type { ClusterConfig } from './config';
import type { Db } from './db';
import { readImapCredentials, type ImapStatusEntry } from './imapAccounts';
import { snapshotVersion, type Snapshot, type SnapshotStatus } from './snapshot';

/** Что окно знает о сервисе кодов в кластере. */
export interface ClusterState {
  url: string;
  /** null — ещё ни разу не обращались. */
  ok: boolean | null;
  error: string;
  /** Когда сервис в кластере последний раз ответил. */
  at: number | null;
  /** Когда последний раз отправлен снимок. */
  pushedAt: number | null;
  /** Состояние ящиков от сервиса в кластере; null — он не ответил. */
  accounts: Record<string, ImapStatusEntry> | null;
}

/** Снимок для сервиса в кластере: пароли из mail-code.json (их вводят в окне) и родители всех алиасов из базы. */
export function buildSnapshot(db: Pick<Db, 'aliasParents'>, mailCodeFile: string): Snapshot {
  const accounts = readImapCredentials(mailCodeFile);
  const aliases: Record<string, string> = {};
  for (const row of db.aliasParents()) aliases[row.email] = row.parent;
  return { accounts, aliases };
}

const REQUEST_TIMEOUT_MS = 30_000;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * Держит у сервиса кодов в кластере актуальный снимок. Раз в intervalMs спрашивает GET /status:
 * версия не совпала (снимок изменился или сервис перезапущен и снимка у него нет) — отправляет PUT /snapshot.
 * Соединение исходящее, так что входящие правила на Windows-сервере не нужны.
 */
export class ClusterSync {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private reported = '';
  private state: ClusterState;

  constructor(
    private readonly cfg: ClusterConfig,
    private readonly build: () => Snapshot,
    private readonly log: (message: string) => void,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.state = { url: cfg.url, ok: null, error: '', at: null, pushedAt: null, accounts: null };
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Пароль сохранён или удалён: отправить сразу, не дожидаясь очередной сверки. */
  pushSoon(): void {
    void this.tick();
  }

  status(): ClusterState {
    return { ...this.state };
  }

  /** Одна сверка; вызовы во время сверки сливаются в одну следующую. */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.tick();
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    // Не прочитали пароли или базу — снимок не отправляем: неполный снимок вывел бы сервис из ящиков.
    let snapshot: Snapshot | null = null;
    let buildError = '';
    try { snapshot = this.build(); } catch (error) { buildError = `снимок не собран и не отправлен: ${message(error)}`; }
    try {
      let remote = await this.request('GET', '/status');
      if (snapshot) {
        const version = snapshotVersion(snapshot);
        if (remote.version !== version) {
          const restarted = remote.version === null;
          remote = await this.request('PUT', '/snapshot', { version, ...snapshot });
          this.state.pushedAt = this.now();
          this.log(`кластер: снимок отправлен — ящиков ${snapshot.accounts.length}, алиасов ${Object.keys(snapshot.aliases).length}` +
            (restarted ? ' (у сервиса в кластере снимка ещё не было)' : ''));
        }
      }
      this.state = { ...this.state, ok: !buildError, error: buildError, at: this.now(), accounts: remote.accounts };
    } catch (error) {
      const text = `сервис кодов в кластере (${this.cfg.url}) недоступен: ${message(error)}`;
      this.state = { ...this.state, ok: false, error: buildError ? `${buildError}; ${text}` : text, accounts: null };
    }
    if (this.state.error !== this.reported) {
      this.log(this.state.error ? `кластер: ${this.state.error}` : 'кластер: связь есть, снимок актуален');
      this.reported = this.state.error;
    }
  }

  private async request(method: 'GET' | 'PUT', route: string, body?: object): Promise<SnapshotStatus> {
    const send = () => this.fetchFn(this.cfg.url + route, {
      method,
      headers: { authorization: `Bearer ${this.cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let res: Response;
    try {
      res = await send();
    } catch (error) {
      // Под перезапустился — сохранённое соединение уже закрыто: один повтор по новому (оба запроса можно повторять).
      // Тайм-аут не повторяем, чтобы не ждать вдвое дольше.
      if (!(error instanceof TypeError)) throw error;
      res = await send();
    }
    const data = await res.json().catch(() => null) as (Partial<SnapshotStatus> & { error?: string }) | null;
    if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status}${data?.error ? ` — ${data.error}` : ''}`);
    if (!data || typeof data !== 'object' || !('version' in data) || typeof data.accounts !== 'object' || data.accounts === null) {
      throw new Error(`${method} ${route}: ответ не от сервиса кодов (проверьте cluster.url)`);
    }
    return { version: data.version ?? null, receivedAt: data.receivedAt ?? null, accounts: data.accounts };
  }
}
