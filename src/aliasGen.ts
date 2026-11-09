import type { Config } from './config';
import { Db, ALIAS_MAXIMUM, ALIAS_HOURLY_LIMIT, ALIAS_WINDOW_MS } from './db';
import { createAlias } from './aliasCreate';

export type Log = (message: string) => void;
interface GeneratorDependencies {
  now?: () => number;
  random?: () => number;
  create?: typeof createAlias;
}

export function randomIntervalMs(minMinutes: number, maxMinutes: number, random = Math.random): number {
  return Math.round((minMinutes + Math.max(0, Math.min(1, random())) * (maxMinutes - minMinutes)) * 60000);
}

export class AliasGenerator {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private reported = '';
  private now: () => number;
  private random: () => number;
  private create: typeof createAlias;

  constructor(private cfg: Config, private db: Db, private log: Log, dependencies: GeneratorDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.create = dependencies.create ?? createAlias;
  }

  private delay(): number {
    return randomIntervalMs(this.cfg.generator.minIntervalMinutes, this.cfg.generator.maxIntervalMinutes, this.random);
  }

  private report(message: string): void {
    if (this.reported !== message) { this.log(message); this.reported = message; }
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped || !this.cfg.generator.enabled) return;
    this.running = true;
    try {
      const parent = this.db.activeParent();
      if (!parent) { this.report('авторегистрация: ожидаю выбора родителя'); return; }
      const limit = Math.min(ALIAS_MAXIMUM, parent.alias_limit);
      if (this.db.aliasCapacityUsed(parent.id) >= limit) {
        this.report(`авторегистрация: остановлена, ${parent.email} достиг лимита ${limit}`);
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
        this.report(`авторегистрация: ${parent.email}, следующее создание ${new Date(next).toISOString()} (не более ${ALIAS_HOURLY_LIMIT}/час)`);
        return;
      }
      if (!this.db.claimGeneratorRun(parent.id, now)) return;
      try {
        const name = this.db.nextAliasName(parent.id, this.cfg.generator.namePrefix || parent.email.split('@')[0]);
        const created = await this.create(this.cfg, this.db, name, { sequential: true });
        this.log(`авторегистрация: создан ${created.email}, родитель ${created.parent}, в базе ${this.db.countAliases(parent.id)}/${limit}`);
      } catch (error) {
        this.log(`авторегистрация: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        const completed = this.now();
        const nextRun = Math.max(completed + this.delay(), this.db.creationAllowedAt(parent.id, completed));
        this.db.setGeneratorSchedule(parent.id, nextRun);
        this.reported = '';
      }
    } finally { this.running = false; }
  }

  start(): void {
    const poll = async () => {
      try { await this.tick(); }
      catch (error) { this.log(`авторегистрация: ошибка планировщика: ${error instanceof Error ? error.message : String(error)}`); }
      if (!this.stopped) this.timer = setTimeout(poll, 1000);
    };
    void poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

export function startAliasGenerator(cfg: Config, db: Db, log: Log): AliasGenerator {
  const generator = new AliasGenerator(cfg, db, log);
  generator.start();
  return generator;
}
