import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AliasRateLimitError, ApiError } from './errors';
import { nextAliasName } from './aliasNames';

export const ALIAS_HOURLY_LIMIT = 5;
export const ALIAS_MAXIMUM = 750;
export const ALIAS_WINDOW_MS = 60 * 60 * 1000;

export interface ParentRow {
  id: number;
  email: string;
  status: 'active' | 'exhausted';
  alias_limit: number;
  created_at: string;
}

export interface AliasRow {
  id: number;
  email: string;
  name: string;
  parent_id: number;
  created_at: string;
}

export class Db {
  private d: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    this.d = new Database(file);
    this.d.pragma('journal_mode = WAL');
    this.d.exec(`
      CREATE TABLE IF NOT EXISTS parents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        alias_limit INTEGER NOT NULL DEFAULT 750,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        parent_id INTEGER NOT NULL REFERENCES parents(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_aliases_parent ON aliases(parent_id);
      CREATE TABLE IF NOT EXISTS seen_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias_email TEXT NOT NULL,
        msg_ref TEXT NOT NULL,
        code TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_seen ON seen_codes(alias_email, msg_ref);
      CREATE TABLE IF NOT EXISTS alias_creation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER NOT NULL REFERENCES parents(id),
        email TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        confirmed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_alias_creation_window ON alias_creation_events(parent_id, requested_at);
      CREATE TABLE IF NOT EXISTS alias_generator_schedule (
        parent_id INTEGER PRIMARY KEY REFERENCES parents(id),
        next_run_at INTEGER NOT NULL
      );
    `);
  }

  upsertParent(email: string, aliasLimit: number): ParentRow {
    const e = email.toLowerCase();
    this.d
      .prepare(
        `INSERT INTO parents (email, alias_limit) VALUES (?, ?)
         ON CONFLICT(email) DO UPDATE SET alias_limit = excluded.alias_limit`,
      )
      .run(e, aliasLimit);
    return this.d.prepare(`SELECT * FROM parents WHERE email = ?`).get(e) as ParentRow;
  }

  /** Включает родителя и помечает всех прежних активных исчерпанными (ротация). */
  setActiveParent(email: string, aliasLimit: number): ParentRow {
    const p = this.upsertParent(email, aliasLimit);
    this.d.prepare(`UPDATE parents SET status = 'exhausted' WHERE status = 'active' AND id != ?`).run(p.id);
    this.d.prepare(`UPDATE parents SET status = 'active' WHERE id = ?`).run(p.id);
    return this.d.prepare(`SELECT * FROM parents WHERE id = ?`).get(p.id) as ParentRow;
  }

  activeParent(): ParentRow | undefined {
    return (this.d.prepare(`SELECT * FROM parents WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get() as ParentRow) ?? undefined;
  }

  creationAttempts(parentId: number, now = Date.now()): number[] {
    return (this.d.prepare('SELECT requested_at FROM alias_creation_events WHERE parent_id = ? AND requested_at > ? ORDER BY requested_at ASC')
      .all(parentId, now - ALIAS_WINDOW_MS) as { requested_at: number }[]).map(row => row.requested_at);
  }

  hasCreationEvents(parentId: number): boolean {
    return !!this.d.prepare('SELECT 1 FROM alias_creation_events WHERE parent_id = ? LIMIT 1').get(parentId);
  }

  creationAllowedAt(parentId: number, now = Date.now()): number {
    const attempts = this.creationAttempts(parentId, now);
    return attempts.length < ALIAS_HOURLY_LIMIT ? now : attempts[attempts.length - ALIAS_HOURLY_LIMIT] + ALIAS_WINDOW_MS;
  }

  creationsThisHour(parentId: number, now = Date.now()): number {
    // Novosibirsk (UTC+7) shares whole-hour boundaries with UTC.
    const start = Math.floor(now / ALIAS_WINDOW_MS) * ALIAS_WINDOW_MS;
    // Late confirmations (via import) belong to the hour the request was sent.
    return (this.d.prepare(`SELECT COUNT(*) AS count FROM alias_creation_events
      WHERE parent_id = ? AND confirmed_at IS NOT NULL AND requested_at >= ? AND requested_at <= ?`)
      .get(parentId, start, now) as { count: number }).count;
  }

  reserveAliasCreation(parentId: number, email: string, now = Date.now()): number {
    return this.d.transaction(() => {
      const parent = this.activeParent();
      if (parent?.id !== parentId) throw new ApiError(409, 'Родитель изменился. Создание отменено.');
      if (this.aliasCapacityUsed(parentId) >= Math.min(ALIAS_MAXIMUM, parent.alias_limit)) {
        throw new ApiError(409, 'Достигнут лимит алиасов родителя, включая неподтверждённые создания. Выполните загрузку из iCloud.');
      }
      const allowed = this.creationAllowedAt(parentId, now);
      if (allowed > now) throw new AliasRateLimitError(allowed);
      return Number(this.d.prepare('INSERT INTO alias_creation_events (parent_id,email,requested_at) VALUES (?,?,?)')
        .run(parentId, email.toLowerCase(), now).lastInsertRowid);
    }).immediate();
  }

  aliasCapacityUsed(parentId: number): number {
    const outstanding = (this.d.prepare(`SELECT COUNT(*) AS n FROM alias_creation_events e
      WHERE e.parent_id = ? AND e.confirmed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM aliases a WHERE a.email = e.email)`).get(parentId) as { n: number }).n;
    return this.countAliases(parentId) + outstanding;
  }

  confirmAliasCreation(eventId: number, now = Date.now()): void {
    this.d.prepare('UPDATE alias_creation_events SET confirmed_at = ? WHERE id = ?').run(now, eventId);
  }

  generatorNextRun(parentId: number): number | null {
    const row = this.d.prepare('SELECT next_run_at FROM alias_generator_schedule WHERE parent_id = ?').get(parentId) as { next_run_at: number } | undefined;
    return row?.next_run_at ?? null;
  }

  ensureGeneratorSchedule(parentId: number, nextRunAt: number): void {
    this.d.prepare('INSERT OR IGNORE INTO alias_generator_schedule (parent_id,next_run_at) VALUES (?,?)').run(parentId, nextRunAt);
  }

  setGeneratorSchedule(parentId: number, nextRunAt: number): void {
    this.d.prepare(`INSERT INTO alias_generator_schedule (parent_id,next_run_at) VALUES (?,?)
      ON CONFLICT(parent_id) DO UPDATE SET next_run_at = excluded.next_run_at`).run(parentId, nextRunAt);
  }

  claimGeneratorRun(parentId: number, now: number): boolean {
    return this.d.prepare('UPDATE alias_generator_schedule SET next_run_at = ? WHERE parent_id = ? AND next_run_at <= ?')
      .run(now + 10 * 60 * 1000, parentId, now).changes === 1;
  }

  parentById(id: number): ParentRow | undefined {
    return (this.d.prepare(`SELECT * FROM parents WHERE id = ?`).get(id) as ParentRow) ?? undefined;
  }

  markExhausted(id: number): void {
    this.d.prepare(`UPDATE parents SET status = 'exhausted' WHERE id = ?`).run(id);
  }

  countAliases(parentId: number): number {
    return (this.d.prepare(`SELECT COUNT(*) AS c FROM aliases WHERE parent_id = ?`).get(parentId) as { c: number }).c;
  }

  countAllAliases(): number {
    return (this.d.prepare(`SELECT COUNT(*) AS c FROM aliases`).get() as { c: number }).c;
  }

  addAlias(parentId: number, email: string, name: string): void {
    this.d
      .prepare(`INSERT OR IGNORE INTO aliases (email, name, parent_id) VALUES (?, ?, ?)`)
      .run(email.toLowerCase(), name, parentId);
  }

  /**
   * Reconciles the parent's local aliases with a complete snapshot of its active iCloud list:
   * adds new addresses, updates labels and removes addresses that are no longer in the list.
   */
  importAliases(parentId: number, aliases: { email: string; name: string }[]): { added: number; removed: number } {
    return this.d.transaction(() => {
      if (this.activeParent()?.id !== parentId) throw new Error('Родитель изменился во время загрузки. Повторите загрузку.');
      let added = 0;
      for (const alias of aliases) {
        const existing = this.findAlias(alias.email);
        if (existing && existing.parent_id !== parentId) {
          throw new Error(`Алиас ${alias.email} уже привязан к другому родителю. Импорт отменён.`);
        }
        this.d.prepare('UPDATE alias_creation_events SET confirmed_at = COALESCE(confirmed_at, ?) WHERE parent_id = ? AND email = ?')
          .run(Date.now(), parentId, alias.email.toLowerCase());
        if (!existing) {
          this.addAlias(parentId, alias.email, alias.name);
          added++;
        } else if (existing.name !== alias.name) {
          this.d.prepare('UPDATE aliases SET name = ? WHERE id = ?').run(alias.name, existing.id);
        }
      }
      const online = new Set(aliases.map(alias => alias.email.toLowerCase()));
      const stale = (this.d.prepare('SELECT id, email FROM aliases WHERE parent_id = ?').all(parentId) as { id: number; email: string }[])
        .filter(row => !online.has(row.email.toLowerCase()));
      const remove = this.d.prepare('DELETE FROM aliases WHERE id = ?');
      for (const row of stale) remove.run(row.id);
      return { added, removed: stale.length };
    })();
  }

  findAlias(email: string): AliasRow | undefined {
    return (this.d.prepare(`SELECT * FROM aliases WHERE email = ?`).get(email.toLowerCase()) as AliasRow) ?? undefined;
  }

  aliasEmails(parentId: number): Set<string> {
    const rows = this.d.prepare(`SELECT email FROM aliases WHERE parent_id = ?`).all(parentId) as { email: string }[];
    return new Set(rows.map((r) => r.email.toLowerCase()));
  }

  nextAliasName(parentId: number, prefix: string): string {
    const rows = this.d.prepare('SELECT name FROM aliases WHERE parent_id = ?').all(parentId) as { name: string }[];
    return nextAliasName(rows.map(row => row.name), prefix);
  }

  listAliases(): AliasRow[] {
    return this.d.prepare(`SELECT * FROM aliases ORDER BY id DESC`).all() as AliasRow[];
  }

  listParents(): ParentRow[] {
    return this.d.prepare(`SELECT * FROM parents ORDER BY id DESC`).all() as ParentRow[];
  }

  recordCode(aliasEmail: string, msgRef: string, code: string): void {
    this.d
      .prepare(`INSERT OR IGNORE INTO seen_codes (alias_email, msg_ref, code) VALUES (?, ?, ?)`)
      .run(aliasEmail.toLowerCase(), msgRef, code);
  }

  seenRefs(aliasEmail: string): Set<string> {
    const rows = this.d
      .prepare(`SELECT msg_ref FROM seen_codes WHERE alias_email = ?`)
      .all(aliasEmail.toLowerCase()) as { msg_ref: string }[];
    return new Set(rows.map((r) => r.msg_ref));
  }

  close(): void {
    this.d.close();
  }
}
