import type { Config } from './config';
import { type Db, type ParentRow, ALIAS_MAXIMUM, ALIAS_HOURLY_LIMIT, ALIAS_WINDOW_MS } from './db';
import type { CreatedAlias } from './aliasCreate';

export type Log = (message: string) => void;

/**
 * off — выключена у родителя; full — достигнут лимит алиасов; waiting-browser — время подошло, но браузер родителя
 * не подключён; scheduled — ждёт времени следующего создания; creating — создание идёт.
 */
export type GeneratorState = 'archived' | 'off' | 'full' | 'waiting-browser' | 'scheduled' | 'creating';

export interface LastAttempt {
  at: number;
  ok: boolean;
  message: string;
}

export interface GeneratorDependencies {
  /** Создаёт у родителя алиас со следующей по номеру меткой. */
  create: (parentId: number) => Promise<CreatedAlias>;
  /** Подключён ли браузер родителя: без него создание не начинается и расписание не тратится. */
  ready?: (parentId: number) => boolean;
  now?: () => number;
  random?: () => number;
}

export function randomIntervalMs(minMinutes: number, maxMinutes: number, random = Math.random): number {
  return Math.round((minMinutes + Math.max(0, Math.min(1, random())) * (maxMinutes - minMinutes)) * 60000);
}

export function aliasLimitOf(parent: Pick<ParentRow, 'alias_limit'>): number {
  return Math.min(ALIAS_MAXIMUM, parent.alias_limit);
}

/** После долгой паузы не создаём сразу при включении: следующее создание — через обычный интервал. */
export function rescheduleAfterPause(cfg: Config, db: Db, parentId: number, now = Date.now(), random = Math.random): void {
  const next = db.generatorNextRun(parentId);
  if (next === null || next >= now) return;
  db.setGeneratorSchedule(parentId, Math.max(now + randomIntervalMs(cfg.generator.minIntervalMinutes, cfg.generator.maxIntervalMinutes, random), db.creationAllowedAt(parentId, now)));
}

/**
 * Авторегистрация у всех родителей с включённым переключателем. У каждого своё расписание (8–16 мин),
 * свой лимит 5 запросов за 60 минут и 750 алиасов; создания у разных родителей идут независимо и параллельно.
 */
export class AliasGenerator {
  private running = new Set<number>();
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private reported = new Map<number, string>();
  private last = new Map<number, LastAttempt>();
  private now: () => number;
  private random: () => number;
  private create: GeneratorDependencies['create'];
  private ready: (parentId: number) => boolean;

  constructor(private cfg: Config, private db: Db, private log: Log, dependencies: GeneratorDependencies) {
    this.create = dependencies.create;
    this.ready = dependencies.ready ?? (() => true);
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
  }

  private delay(): number {
    return randomIntervalMs(this.cfg.generator.minIntervalMinutes, this.cfg.generator.maxIntervalMinutes, this.random);
  }

  private report(parent: ParentRow, message: string): void {
    if (this.reported.get(parent.id) !== message) {
      this.log(`[${parent.email}] авторегистрация: ${message}`);
      this.reported.set(parent.id, message);
    }
  }

  state(parent: ParentRow): GeneratorState {
    if (parent.archived) return 'archived';
    if (!parent.generator_enabled) return 'off';
    if (this.running.has(parent.id)) return 'creating';
    if (this.db.aliasCapacityUsed(parent.id) >= aliasLimitOf(parent)) return 'full';
    const next = this.db.generatorNextRun(parent.id);
    if (next !== null && next <= this.now() && !this.ready(parent.id)) return 'waiting-browser';
    return 'scheduled';
  }

  lastAttempt(parentId: number): LastAttempt | null {
    return this.last.get(parentId) ?? null;
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(this.db.workingParents().filter(parent => parent.generator_enabled).map(parent => this.tickParent(parent)));
  }

  private async tickParent(parent: ParentRow): Promise<void> {
    if (this.running.has(parent.id) || this.stopped) return;
    this.running.add(parent.id);
    try {
      const limit = aliasLimitOf(parent);
      if (this.db.aliasCapacityUsed(parent.id) >= limit) {
        this.report(parent, `остановлена: достигнут лимит ${limit} алиасов. Коды этого родителя по-прежнему читаются.`);
        return;
      }
      const now = this.now();
      let next = this.db.generatorNextRun(parent.id);
      if (next === null) {
        // Новая база или новый для неё родитель: создания с другой машины за последний час не видны,
        // поэтому первое — не раньше чем через час, чтобы не превысить лимит Apple.
        const unknownHistory = !this.db.hasCreationEvents(parent.id);
        this.db.ensureGeneratorSchedule(parent.id, Math.max(now + this.delay(), this.db.creationAllowedAt(parent.id, now), unknownHistory ? now + ALIAS_WINDOW_MS : 0));
        next = this.db.generatorNextRun(parent.id)!;
      }
      const allowed = this.db.creationAllowedAt(parent.id, now);
      if (allowed > now && allowed > next) {
        next = allowed + Math.round(this.random() * 60000);
        this.db.setGeneratorSchedule(parent.id, next);
      }
      if (next > now) {
        this.report(parent, `следующее создание ${new Date(next).toISOString()} (не более ${ALIAS_HOURLY_LIMIT}/час)`);
        return;
      }
      if (!this.ready(parent.id)) {
        this.report(parent, 'ждёт подключения браузера родителя');
        return;
      }
      if (!this.db.claimGeneratorRun(parent.id, now)) return;
      try {
        const created = await this.create(parent.id);
        this.last.set(parent.id, { at: this.now(), ok: true, message: `создан ${created.email}` });
        this.log(`[${parent.email}] авторегистрация: создан ${created.email}, в базе ${this.db.countAliases(parent.id)}/${limit}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.last.set(parent.id, { at: this.now(), ok: false, message });
        this.log(`[${parent.email}] авторегистрация: ${message}`);
      } finally {
        const completed = this.now();
        this.db.setGeneratorSchedule(parent.id, Math.max(completed + this.delay(), this.db.creationAllowedAt(parent.id, completed)));
        this.reported.delete(parent.id);
      }
    } catch (error) {
      this.report(parent, `ошибка планировщика: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.running.delete(parent.id); }
  }

  start(): void {
    // Не ждём tick: создание у одного родителя идёт до минуты, остальные проверяются каждую секунду.
    const poll = () => {
      if (this.stopped) return;
      void this.tick();
      this.timer = setTimeout(poll, 1000);
    };
    poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
