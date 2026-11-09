import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { merge, type CodePattern } from './config';

/** Виды писем из CodeKind в mail_code.proto (без UNSPECIFIED). */
export type MailKind = 'CODE_KIND_SIGN_UP' | 'CODE_KIND_MFA';
export const MAIL_KINDS: MailKind[] = ['CODE_KIND_SIGN_UP', 'CODE_KIND_MFA'];

export interface GrpcConfig {
  host: string;
  port: number;
  /** Верхний предел wait_seconds из запроса. */
  maxWaitSeconds: number;
  /** Как часто перепроверять ящики, пока письмо не пришло. */
  pollIntervalMs: number;
}
export interface ImapAccount {
  /** Адрес родителя: в логах и сообщениях об ошибках. */
  email: string;
  /** Логин IMAP; по умолчанию email. */
  user?: string;
  /** App-specific пароль Apple ID (account.apple.com → Вход и безопасность → Пароли приложений). */
  password: string;
  /** Прокси для этого аккаунта: socks5://… или http://…; пусто — напрямую. */
  proxy?: string;
}
export interface ImapConfig {
  host: string;
  port: number;
  accounts: ImapAccount[];
  /** Пауза перед повторным подключением после сетевой ошибки. После отказа во входе аккаунт не трогаем до перезапуска. */
  reconnectDelayMs: number;
}
export interface MailKindRule {
  /** Регулярка по отправителю (имя и адрес); пусто — любой. */
  from?: string;
  /** Регулярка по теме; пусто — любая. */
  subject?: string;
  /** Регулярка, которая обязана совпасть в теме или тексте письма. */
  mustContain?: string;
  /** Вырезание кода из темы и текста, по порядку, как code.patterns. */
  patterns: CodePattern[];
}
export interface BrowserFallbackConfig {
  /** Читать коды через браузер (профиль Dolphin основного сервиса), если родитель алиаса не читается по IMAP. */
  enabled: boolean;
  /** HTTP API основного сервиса; пусто — CODES_API_URL от окна приложения или http://127.0.0.1:8787. */
  apiUrl: string;
  /** Не чаще одного прохода по почте в браузере на алиас: каждый проход кликает по письмам. */
  pollIntervalMs: number;
}
export interface RegistryConfig {
  /**
   * База основного сервиса (родители и алиасы), чтобы искать письмо только в ящике родителя алиаса.
   * Пусто — CODES_DB от окна приложения или ./data/codes.db рядом с mail-code.json. Нет базы — поиск во всех ящиках.
   */
  dbFile: string;
}
export interface MailCodeConfig {
  grpc: GrpcConfig;
  imap: ImapConfig;
  browser: BrowserFallbackConfig;
  registry: RegistryConfig;
  /** Домены обслуживаемых ящиков; адрес с другим доменом — UNKNOWN_MAILBOX. */
  domains: string[];
  /** Письмо относится к виду, если подходит под его правило и не подходит под правило другого вида. */
  kinds: Record<MailKind, MailKindRule>;
}

/** Пароль-заглушка из примера mail-code.json. */
export const EXAMPLE_PASSWORD = 'xxxx-xxxx-xxxx-xxxx';

// Правила kinds — черновик до образцов писем GGPass: тему и отправителя уточнить по реальным письмам.
const SIX_DIGITS: CodePattern[] = [{ name: 'code-6', regex: '(?:code|код)[^0-9]{0,40}(\\d{6})(?!\\d)' }];

export const MAIL_CODE_DEFAULTS: MailCodeConfig = {
  grpc: { host: '0.0.0.0', port: 50051, maxWaitSeconds: 120, pollIntervalMs: 3000 },
  imap: { host: 'imap.mail.me.com', port: 993, accounts: [], reconnectDelayMs: 30000 },
  browser: { enabled: true, apiUrl: '', pollIntervalMs: 15000 },
  registry: { dbFile: '' },
  domains: ['icloud.com'],
  kinds: {
    CODE_KIND_SIGN_UP: { subject: 'verif|confirm|sign.?up|регистрац|подтвержд', patterns: SIX_DIGITS },
    CODE_KIND_MFA: { subject: '2fa|two.?factor|двухфактор|authenticat|log.?in|вход', patterns: SIX_DIGITS },
  },
};

export function loadMailCodeConfig(file = process.env.MAIL_CODE_CONFIG ?? 'mail-code.json'): MailCodeConfig {
  const p = path.resolve(file);
  if (!existsSync(p)) {
    throw new Error(`не найден ${p} — скопируйте mail-code.example.json в mail-code.json и впишите app-specific пароли родителей`);
  }
  const cfg = merge(structuredClone(MAIL_CODE_DEFAULTS), JSON.parse(readFileSync(p, 'utf8')));
  cfg.domains = cfg.domains.map(domain => domain.toLowerCase());
  for (const account of cfg.imap.accounts) {
    if (!account.email || !account.password) throw new Error('imap.accounts: у каждого аккаунта нужны email и password');
    // Иначе сервис стал бы входить в чужой ящик из примера.
    if (account.password === EXAMPLE_PASSWORD) throw new Error(`imap.accounts: у ${account.email} пароль из примера — впишите родителей и их app-specific пароли в ${p}`);
    account.email = account.email.toLowerCase();
  }
  if (!Number.isInteger(cfg.grpc.port) || cfg.grpc.maxWaitSeconds < 0 || cfg.grpc.pollIntervalMs < 100) {
    throw new Error('grpc: укажите port, maxWaitSeconds >= 0 и pollIntervalMs >= 100');
  }
  if (cfg.browser.pollIntervalMs < 1000) throw new Error('browser.pollIntervalMs: не меньше 1000');
  cfg.browser.apiUrl = (cfg.browser.apiUrl || process.env.CODES_API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const dbFile = cfg.registry.dbFile || process.env.CODES_DB || './data/codes.db';
  cfg.registry.dbFile = path.isAbsolute(dbFile) ? dbFile : path.join(path.dirname(p), dbFile);
  // Кривой regex в правилах вида письма молча ломал бы выдачу кодов: падаем сразу.
  for (const kind of MAIL_KINDS) {
    const rule = cfg.kinds[kind];
    for (const pattern of [rule.from, rule.subject, rule.mustContain, ...rule.patterns.flatMap(p => [p.mustContain, p.regex])]) {
      if (!pattern) continue;
      try { new RegExp(pattern, 'i'); } catch (e) { throw new Error(`kinds.${kind}: ${e instanceof Error ? e.message : e}`); }
    }
  }
  return cfg;
}
