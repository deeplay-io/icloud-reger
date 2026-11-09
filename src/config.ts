import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validAliasPrefix } from './aliasNames';

export interface ApiConfig { host: string; port: number }
export interface DbConfig { file: string }
export interface DebugConfig { dir: string }
export interface BrowserConfig {
  cdpUrl: string;
  hideMyEmailUrl: string;
  mailUrl: string;
  hideMyEmailTabHint: string;
  mailTabHint: string;
  connectTimeoutMs: number;
  actionTimeoutMs: number;
}
export interface GeneratorConfig {
  enabled: boolean;
  namePrefix: string;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
}
export interface CodePattern {
  name: string;
  /** Регулярка, которая обязана совпасть в теле письма, иначе паттерн пропускается. */
  mustContain?: string;
  /** Регулярка; кодом считается capture group 1 (или весь match). */
  regex: string;
}
export interface CodeSelectors {
  messageItem: string;
  body: string;
  subject?: string;
  closeMessage?: string;
}
export interface CodeConfig {
  freshnessMinutes: number;
  maxMessagesToScan: number;
  selectors: CodeSelectors;
  patterns: CodePattern[];
}
export interface ParentConfig {
  email: string;
  aliasLimit: number;
}

export interface Config {
  api: ApiConfig;
  db: DbConfig;
  debug: DebugConfig;
  browser: BrowserConfig;
  parent: ParentConfig;
  generator: GeneratorConfig;
  code: CodeConfig;
}

export const DEFAULTS: Config = {
  api: { host: '127.0.0.1', port: 8787 },
  db: { file: './data/codes.db' },
  debug: { dir: './debug' },
  browser: {
    cdpUrl: 'http://127.0.0.1:9222',
    hideMyEmailUrl: 'https://account.apple.com/manage?section=hide_my_email',
    mailUrl: 'https://www.icloud.com/mail/',
    hideMyEmailTabHint: 'hide_my_email',
    mailTabHint: 'icloud.com/mail',
    connectTimeoutMs: 15000,
    actionTimeoutMs: 30000,
  },
  parent: { email: '', aliasLimit: 750 },
  generator: {
    enabled: true,
    namePrefix: '',
    minIntervalMinutes: 8,
    maxIntervalMinutes: 16,
  },
  code: {
    freshnessMinutes: 15,
    maxMessagesToScan: 10,
    selectors: {
      messageItem: '.thread-list-item[role="treeitem"]',
      body: '.mail-message-defaults',
      subject: '.thread-subject',
    },
    patterns: [
      { name: 'kod-digit', regex: 'код[^0-9]{0,12}(\\d{4,6})' },
      { name: 'code-digit', regex: 'code[^0-9]{0,12}(\\d{4,6})' },
      { name: 'verify-digit', mustContain: 'верификац|код|code|verif|one-time|otp|password', regex: '\\b(\\d{4,6})\\b' },
      { name: 'any-digit4', mustContain: 'код|code|верификац|one-time|otp', regex: '\\b(\\d{4})\\b' },
    ],
  },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || over === undefined) return base;
  if (!isObj(over)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const bv = (base as Record<string, unknown>)[k];
    out[k] = isObj(bv) ? merge(bv, v) : v;
  }
  return out as T;
}

export function loadConfig(file = process.env.CONFIG_FILE ?? 'config.json'): Config {
  const p = path.resolve(file);
  if (!existsSync(p)) {
    throw new Error(`не найден ${p} — скопируйте config.example.json в config.json и заполните`);
  }
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const cfg = merge(DEFAULTS, raw);
  if (cfg.generator.namePrefix && !validAliasPrefix(cfg.generator.namePrefix)) throw new Error('generator.namePrefix: введите имя без @icloud.com');
  // Относительные пути — относительно папки, где лежит config.json
  // (в пакетированном GUI это папка userData, в dev — корень проекта).
  const baseDir = path.dirname(p);
  if (!path.isAbsolute(cfg.db.file)) cfg.db.file = path.join(baseDir, cfg.db.file);
  if (!path.isAbsolute(cfg.debug.dir)) cfg.debug.dir = path.join(baseDir, cfg.debug.dir);
  if (!cfg.parent.email) {
    throw new Error('config: parent.email обязателен — e-mail родительской iCloud-учётки');
  }
  if (!Number.isFinite(cfg.generator.minIntervalMinutes) || !Number.isFinite(cfg.generator.maxIntervalMinutes)
    || cfg.generator.minIntervalMinutes < 1 || cfg.generator.maxIntervalMinutes < cfg.generator.minIntervalMinutes) {
    throw new Error('generator: укажите интервалы minIntervalMinutes >= 1 и maxIntervalMinutes >= minIntervalMinutes');
  }
  if (!cfg.code.selectors.messageItem) {
    console.warn('[config] code.selectors.messageItem пуст — чтение кодов будет падать до тех пор, пока не выставите селектор (см. debug/ дампы)');
  }
  return cfg;
}

export function saveParentEmail(file: string, email: string): void {
  updateConfig(file, raw => { raw.parent = { ...raw.parent, email }; });
}

export function saveGeneratorPrefix(file: string, namePrefix: string): void {
  updateConfig(file, raw => { raw.generator = { ...raw.generator, namePrefix }; });
}

export function saveGeneratorEnabled(file: string, enabled: boolean): void {
  updateConfig(file, raw => { raw.generator = { ...raw.generator, enabled }; });
}

function updateConfig(file: string, update: (raw: any) => void): void {
  const target = path.resolve(file);
  const raw = JSON.parse(readFileSync(target, 'utf8'));
  update(raw);
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
