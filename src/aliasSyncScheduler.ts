import type { Db, ParentRow } from './db';
import { AliasBusyError, ApiError } from './errors';

export interface AliasSyncResult {
  parent: string;
  found: number;
  added: number;
  removed: number;
  total: number;
}

export interface SyncStatus {
  state: 'never' | 'running' | 'ok' | 'error';
  /** Время последнего завершения (0 — ещё не было). */
  at: number;
  message: string;
}

export const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
export const SYNC_RETRY_MS = 2 * 60 * 1000;
const BUSY_RETRY_MS = 30 * 1000;
const POLL_MS = 30 * 1000;

/**
 * Держит алиасы каждого родителя в базе в соответствии с его списком iCloud (источник правды):
 * загружает после подключения браузера родителя, дальше раз в 6 часов. Так новая база на сервере
 * заполняется сама. Родителей без подключённого браузера пропускает; после ошибки повторяет через 2 минуты.
 */
export class AliasSyncScheduler {
  private nextAt = new Map<number, number>();
  private running = new Set<number>();
  private lastError = new Map<number, string>();
  private statuses = new Map<number, SyncStatus>();
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private db: Db,
    private sync: (parentId: number) => Promise<AliasSyncResult>,
    private log: (message: string) => void,
    private now: () => number = Date.now,
    private ready: (parentId: number) => boolean = () => true,
  ) {}

  status(parentId: number): SyncStatus {
    if (this.running.has(parentId)) return { ...(this.statuses.get(parentId) ?? { at: 0, message: '' }), state: 'running' };
    return this.statuses.get(parentId) ?? { state: 'never', at: 0, message: '' };
  }

  /** Загрузить при ближайшей возможности: после подключения профиля или его смены. */
  syncSoon(parentId: number): void {
    this.nextAt.delete(parentId);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(this.db.workingParents().map(parent => this.scheduled(parent)));
  }

  private async scheduled(parent: ParentRow): Promise<void> {
    if (this.running.has(parent.id) || !parent.profile || !this.ready(parent.id)) return;
    if (this.now() < (this.nextAt.get(parent.id) ?? 0)) return;
    await this.execute(parent).catch(() => undefined);
  }

  /** Загрузка по кнопке: результат и ошибка видны в строке родителя, как у загрузки по расписанию. */
  async runNow(parentId: number): Promise<AliasSyncResult> {
    const parent = this.db.parentById(parentId);
    if (!parent) throw new ApiError(404, 'Родитель не найден.');
    return this.execute(parent);
  }

  private async execute(parent: ParentRow): Promise<AliasSyncResult> {
    if (this.running.has(parent.id)) throw new ApiError(409, 'Загрузка алиасов этого родителя уже выполняется.');
    this.running.add(parent.id);
    const now = this.now();
    try {
      const r = await this.sync(parent.id);
      this.log(`[${r.parent}] алиасы iCloud: найдено ${r.found}, добавлено ${r.added}, удалено ${r.removed}, в базе ${r.total}`);
      this.lastError.delete(parent.id);
      this.statuses.set(parent.id, { state: 'ok', at: this.now(), message: `найдено ${r.found}, добавлено ${r.added}, удалено ${r.removed}` });
      this.nextAt.set(parent.id, now + SYNC_EVERY_MS);
      return r;
    } catch (error) {
      // Идёт создание алиаса или чтение почты в этом профиле: попробуем чуть позже, это не ошибка.
      if (error instanceof AliasBusyError) {
        this.nextAt.set(parent.id, now + BUSY_RETRY_MS);
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastError.get(parent.id)) this.log(`[${parent.email}] загрузка алиасов из iCloud: ${message} Повтор через ${SYNC_RETRY_MS / 60000} мин.`);
      this.lastError.set(parent.id, message);
      this.statuses.set(parent.id, { state: 'error', at: this.now(), message });
      this.nextAt.set(parent.id, now + SYNC_RETRY_MS);
      throw error;
    } finally { this.running.delete(parent.id); }
  }

  start(): void {
    const poll = () => {
      if (this.stopped) return;
      void this.tick();
      this.timer = setTimeout(poll, POLL_MS);
    };
    poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
