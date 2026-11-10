import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AliasRateLimitError, ApiError } from './errors';
import { nextAliasName } from './aliasNames';

export const ALIAS_HOURLY_LIMIT = 5;
export const ALIAS_MAXIMUM = 750;
export const ALIAS_WINDOW_MS = 60 * 60 * 1000;

/** Пример из config.example.json: такой родитель не настоящий. */
export const PLACEHOLDER_PARENT = 'parent@icloud.com';

export interface ParentRow {
  id: number;
  email: string;
  alias_limit: number;
  created_at: string;
  /** ID профиля Dolphin Anty или адрес CDP (http://127.0.0.1:9222); пусто — браузер не задан. */
  profile: string;
  generator_enabled: number;
  /** Основа метки для авторегистрации; пусто — начало e-mail родителя. */
  name_prefix: string;
  /** Отключён: сервис не держит его профиль, не загружает и не создаёт алиасы. Коды по IMAP читаются. */
  archived: number;
}

export interface ParentSettings {
  profile?: string;
  generatorEnabled?: boolean;
  namePrefix?: string;
  archived?: boolean;
  aliasLimit?: number;
}

export interface AliasListRow extends AliasRow {
  parent: string;
}

/** Основа метки авторегистрации: своя у родителя, иначе начало его e-mail. */
export function namePrefixOf(parent: Pick<ParentRow, 'email' | 'name_prefix'>): string {
  return parent.name_prefix || parent.email.split('@')[0];
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
    this.migrate();
  }

  /**
   * Если база обновлена со схемы с одним активным родителем: id того, кто был активным.
   * Ему переносятся профиль и настройки авторегистрации из config.json (см. initializeParents).
   */
  legacyActiveParentId: number | null = null;

  private migrate(): void {
    const version = this.d.pragma('user_version', { simple: true }) as number;
    if (version < 1) {
      this.d.transaction(() => {
        const columns = new Set((this.d.prepare('PRAGMA table_info(parents)').all() as { name: string }[]).map(c => c.name));
        const add = (name: string, definition: string) => { if (!columns.has(name)) this.d.exec(`ALTER TABLE parents ADD COLUMN ${name} ${definition}`); };
        add('profile', "TEXT NOT NULL DEFAULT ''");
        add('generator_enabled', 'INTEGER NOT NULL DEFAULT 0');
        add('name_prefix', "TEXT NOT NULL DEFAULT ''");
        add('archived', 'INTEGER NOT NULL DEFAULT 0');
        const active = this.d.prepare(`SELECT id FROM parents WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get() as { id: number } | undefined;
        this.legacyActiveParentId = active?.id ?? null;
        // Родитель-заглушка из примера конфига без алиасов — не настоящий: убираем его из работы.
        this.d.prepare(`UPDATE parents SET archived = 1 WHERE email = ? AND NOT EXISTS (SELECT 1 FROM aliases WHERE parent_id = parents.id)`).run(PLACEHOLDER_PARENT);
        this.d.pragma('user_version = 1');
      })();
    }
  }

  addParent(email: string, settings: ParentSettings = {}): ParentRow {
    const e = email.trim().toLowerCase();
    if (this.parentByEmail(e)) throw new ApiError(409, `Родитель ${e} уже есть в списке.`);
    const id = Number(this.d.prepare('INSERT INTO parents (email, alias_limit) VALUES (?, ?)').run(e, settings.aliasLimit ?? ALIAS_MAXIMUM).lastInsertRowid);
    return this.updateParent(id, settings);
  }

  updateParent(id: number, settings: ParentSettings): ParentRow {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); };
    if (settings.profile !== undefined) set('profile', settings.profile.trim());
    if (settings.generatorEnabled !== undefined) set('generator_enabled', settings.generatorEnabled ? 1 : 0);
    if (settings.namePrefix !== undefined) set('name_prefix', settings.namePrefix.trim());
    if (settings.archived !== undefined) set('archived', settings.archived ? 1 : 0);
    if (settings.aliasLimit !== undefined) set('alias_limit', settings.aliasLimit);
    if (sets.length) this.d.prepare(`UPDATE parents SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    const parent = this.parentById(id);
    if (!parent) throw new ApiError(404, 'Родитель не найден.');
    return parent;
  }

  /** Удаляет родителя, добавленного по ошибке: без алиасов и без созданий за последний час. */
  deleteParent(id: number, now = Date.now()): void {
    this.d.transaction(() => {
      if (this.countAliases(id) > 0) throw new ApiError(409, 'У родителя есть алиасы: его можно только отключить.');
      if (this.creationAttempts(id, now).length) throw new ApiError(409, 'У родителя недавно создавались алиасы: удалить можно через час, а пока — отключить.');
      this.d.prepare('DELETE FROM alias_generator_schedule WHERE parent_id = ?').run(id);
      this.d.prepare('DELETE FROM alias_creation_events WHERE parent_id = ?').run(id);
      this.d.prepare('DELETE FROM parents WHERE id = ?').run(id);
    })();
  }

  parentByEmail(email: string): ParentRow | undefined {
    return (this.d.prepare('SELECT * FROM parents WHERE email = ?').get(email.trim().toLowerCase()) as ParentRow) ?? undefined;
  }

  /** Родители в работе (не отключённые). */
  workingParents(): ParentRow[] {
    return this.d.prepare('SELECT * FROM parents WHERE archived = 0 ORDER BY id').all() as ParentRow[];
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
      const parent = this.parentById(parentId);
      if (!parent || parent.archived) throw new ApiError(409, 'Родитель отключён. Создание отменено.');
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
      if (!this.parentById(parentId)) throw new Error('Родитель удалён во время загрузки.');
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

  /** Родитель каждого алиаса, по алфавиту алиасов: для снимка сервису кодов в кластере. */
  aliasParents(): { email: string; parent: string }[] {
    return this.d.prepare('SELECT a.email, p.email AS parent FROM aliases a JOIN parents p ON p.id = a.parent_id ORDER BY a.email')
      .all() as { email: string; parent: string }[];
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

  /** WHERE для выборок алиасов (таблица a): parentId и q — часть адреса или метки. */
  private aliasFilter(filter: { parentId?: number; q?: string }): { clause: string; values: unknown[] } {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.parentId) { where.push('a.parent_id = ?'); values.push(filter.parentId); }
    const q = filter.q?.trim().toLowerCase();
    if (q) { where.push("(instr(a.email, ?) > 0 OR instr(lower(a.name), ?) > 0)"); values.push(q, q); }
    return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', values };
  }

  /** Алиасы с e-mail родителя, новые сверху; parentId и q (часть адреса или метки) сужают выборку. */
  listAliases(filter: { parentId?: number; q?: string; limit?: number; offset?: number } = {}): { total: number; rows: AliasListRow[] } {
    const { clause, values } = this.aliasFilter(filter);
    const total = (this.d.prepare(`SELECT COUNT(*) AS n FROM aliases a ${clause}`).get(...values) as { n: number }).n;
    const page = filter.limit ? ' LIMIT ? OFFSET ?' : '';
    const rows = this.d.prepare(`SELECT a.*, p.email AS parent FROM aliases a JOIN parents p ON p.id = a.parent_id ${clause} ORDER BY a.id DESC${page}`)
      .all(...values, ...(filter.limit ? [filter.limit, filter.offset ?? 0] : [])) as AliasListRow[];
    return { total, rows };
  }

  /** Выгрузка: алиасы всех родителей, отключённых тоже, по родителю и внутри по адресу. Фильтр — как у listAliases. */
  exportAliases(filter: { parentId?: number; q?: string } = {}): { email: string; name: string; parent: string }[] {
    const { clause, values } = this.aliasFilter(filter);
    return this.d.prepare(`SELECT a.email, a.name, p.email AS parent FROM aliases a JOIN parents p ON p.id = a.parent_id ${clause} ORDER BY p.email, a.email`)
      .all(...values) as { email: string; name: string; parent: string }[];
  }

  /** Сначала родители в работе, затем отключённые; внутри — в порядке добавления. */
  listParents(): ParentRow[] {
    return this.d.prepare(`SELECT * FROM parents ORDER BY archived, id`).all() as ParentRow[];
  }

  aliasCounts(): Map<number, number> {
    const rows = this.d.prepare('SELECT parent_id, COUNT(*) AS n FROM aliases GROUP BY parent_id').all() as { parent_id: number; n: number }[];
    return new Map(rows.map(row => [row.parent_id, row.n]));
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
