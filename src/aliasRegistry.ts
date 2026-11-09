import type Database from 'better-sqlite3';
import type { AliasOwner } from './mailboxes';

const RETRY_MS = 30 * 1000;

/**
 * Родитель алиаса по базе основного сервиса — для gRPC-сервиса, чтобы искать письмо только в ящике этого родителя.
 * База открывается только на чтение и лениво; нет базы или таблиц (основной сервис ещё не запускался) — null,
 * и письмо ищется во всех ящиках, как без реестра. Повторная попытка открыть — не чаще раза в 30 секунд.
 */
export class AliasRegistry implements AliasOwner {
  private db: Database.Database | null = null;
  private statement: Database.Statement | null = null;
  private retryAt = 0;
  private reported = '';

  constructor(private readonly file: string, private readonly log: (message: string) => void, private readonly now: () => number = Date.now) {}

  parentOf(alias: string): string | null {
    const statement = this.open();
    if (!statement) return null;
    try {
      const row = statement.get(alias.trim().toLowerCase()) as { email: string } | undefined;
      return row?.email ?? null;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /** Открывает базу сразу (при старте), чтобы в логе было видно, работает ли адресный поиск. */
  check(): boolean {
    return this.open() !== null;
  }

  private open(): Database.Statement | null {
    if (this.statement) return this.statement;
    if (this.now() < this.retryAt) return null;
    try {
      // Нативный модуль грузится здесь, а не при старте: если он не подходит к среде запуска
      // (другая версия Node), gRPC работает дальше и ищет во всех ящиках.
      const open = require('better-sqlite3') as typeof Database;
      this.db = new open(this.file, { readonly: true, fileMustExist: true });
      this.statement = this.db.prepare('SELECT p.email FROM aliases a JOIN parents p ON p.id = a.parent_id WHERE a.email = ?');
      this.log(`реестр алиасов: ${this.file} — письмо ищется в ящике родителя алиаса`);
      this.reported = '';
      return this.statement;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  private fail(error: unknown): void {
    this.close();
    this.retryAt = this.now() + RETRY_MS;
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.reported) this.log(`реестр алиасов недоступен (${this.file}): ${message}. Письмо ищется во всех ящиках.`);
    this.reported = message;
  }

  close(): void {
    try { this.db?.close(); } catch { /* уже закрыта */ }
    this.db = null;
    this.statement = null;
  }
}
