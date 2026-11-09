import type { Db } from './db';
import { AliasBusyError } from './errors';

export interface AliasSyncResult {
  parent: string;
  found: number;
  added: number;
  removed: number;
  total: number;
}

export const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
export const SYNC_RETRY_MS = 2 * 60 * 1000;
const BUSY_RETRY_MS = 30 * 1000;
const POLL_MS = 30 * 1000;

/**
 * Держит алиасы активного родителя в базе в соответствии со списком iCloud (источник правды):
 * загружает при старте и смене родителя, дальше раз в 6 часов. Так новая база на сервере
 * заполняется сама. Пока браузер не подключён, повторяет каждые 2 минуты.
 */
export class AliasSyncScheduler {
  private parentId = 0;
  private nextAt = 0;
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private lastError = '';

  constructor(
    private db: Db,
    private sync: () => Promise<AliasSyncResult>,
    private log: (message: string) => void,
    private now: () => number = Date.now,
  ) {}

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    const parent = this.db.activeParent();
    if (!parent) return;
    const now = this.now();
    if (parent.id === this.parentId && now < this.nextAt) return;
    this.running = true;
    this.parentId = parent.id;
    try {
      const r = await this.sync();
      this.log(`Алиасы iCloud: ${r.parent}: найдено ${r.found}, добавлено ${r.added}, удалено ${r.removed}, в базе ${r.total}`);
      this.lastError = '';
      this.nextAt = now + SYNC_EVERY_MS;
    } catch (error) {
      // Идёт создание алиаса: оно само сверяет список, просто попробуем чуть позже.
      if (error instanceof AliasBusyError) {
        this.nextAt = now + BUSY_RETRY_MS;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastError) this.log(`Загрузка алиасов из iCloud: ${message} Повтор каждые ${SYNC_RETRY_MS / 60000} мин.`);
      this.lastError = message;
      this.nextAt = now + SYNC_RETRY_MS;
    } finally { this.running = false; }
  }

  start(): void {
    const poll = async () => {
      await this.tick();
      if (!this.stopped) this.timer = setTimeout(poll, POLL_MS);
    };
    void poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
