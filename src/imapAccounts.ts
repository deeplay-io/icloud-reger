import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { merge, updateJsonFile } from './config';
import { EXAMPLE_PASSWORD, MAIL_CODE_DEFAULTS, type ImapAccount, type ImapConfig } from './mailCodeConfig';
import { Mailbox } from './mailboxes';

/**
 * IMAP-пароли родителей хранятся в mail-code.json (imap.accounts): его читает gRPC-сервис и сам подхватывает
 * изменения. Окно меняет там только запись своего родителя; пароль наружу не отдаётся, только «задан».
 */
export interface ImapAccountInfo {
  email: string;
  user: string;
  proxy: string;
  configured: boolean;
}

export type ImapState = 'connected' | 'auth' | 'error';
export interface ImapStatusEntry {
  state: ImapState;
  error: string;
  at: number;
}
/** Состояние ящиков, которое пишет работающий gRPC-сервис (imap-status.json рядом с mail-code.json). */
export interface ImapStatusFile {
  pid: number;
  updatedAt: number;
  accounts: Record<string, ImapStatusEntry>;
}

export function imapStatusPath(mailCodeFile: string): string {
  return path.join(path.dirname(path.resolve(mailCodeFile)), 'imap-status.json');
}

function readJson(file: string): any {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

const same = (account: { email?: unknown; user?: unknown }, parentEmail: string) =>
  [account.email, account.user].some(value => String(value ?? '').trim().toLowerCase() === parentEmail);

export function readImapAccounts(file: string): ImapAccountInfo[] {
  let raw: any;
  try { raw = readJson(file); } catch { return []; }
  const accounts: any[] = Array.isArray(raw?.imap?.accounts) ? raw.imap.accounts : [];
  return accounts.filter(a => a && a.email).map(a => ({
    email: String(a.email).toLowerCase(),
    user: String(a.user ?? ''),
    proxy: String(a.proxy ?? ''),
    configured: !!a.password && a.password !== EXAMPLE_PASSWORD,
  }));
}

/**
 * Пароли родителей для снимка сервису кодов в кластере. Файл не найден или не читается — исключение, а не пустой список:
 * снимок целиком заменяет прежний, и пустой список вывел бы сервис в кластере из всех ящиков.
 */
export function readImapCredentials(file: string): ImapAccount[] {
  if (!existsSync(file)) throw new Error(`не найден ${file}`);
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`${path.basename(file)} не читается: ${error instanceof Error ? error.message : error}`);
  }
  const accounts = raw?.imap?.accounts ?? [];
  if (!Array.isArray(accounts)) throw new Error(`${path.basename(file)}: imap.accounts — не массив`);
  // Повтор одного e-mail — как у gRPC-сервиса с файлом: действует последняя запись.
  const byEmail = new Map<string, ImapAccount>();
  for (const a of accounts) {
    if (!a || typeof a.email !== 'string' || typeof a.password !== 'string' || !a.password.trim() || a.password === EXAMPLE_PASSWORD) continue;
    const email = a.email.trim().toLowerCase();
    const user = String(a.user ?? '').trim();
    const proxy = String(a.proxy ?? '').trim();
    byEmail.delete(email);
    byEmail.set(email, { email, password: a.password.trim(), ...(user ? { user } : {}), ...(proxy ? { proxy } : {}) });
  }
  return [...byEmail.values()];
}

/** Ящик родителя: запись, где его e-mail указан как email или как логин (user). */
export function accountOf(accounts: ImapAccountInfo[], parentEmail: string): ImapAccountInfo | undefined {
  const email = parentEmail.toLowerCase();
  return accounts.find(account => account.configured && same(account, email)) ?? accounts.find(account => same(account, email));
}

/** Записывает пароль и прокси родителя; заглушки из примера убирает, остальные записи и поля файла не трогает. */
export function saveImapAccount(file: string, account: { email: string; password: string; proxy?: string }): void {
  const email = account.email.toLowerCase();
  updateJsonFile(file, raw => {
    if (!raw.imap || typeof raw.imap !== 'object') raw.imap = {};
    const list: any[] = (Array.isArray(raw.imap.accounts) ? raw.imap.accounts : []).filter((a: any) => a && a.password !== EXAMPLE_PASSWORD);
    const index = list.findIndex(a => same(a, email));
    const entry = { ...(index >= 0 ? list[index] : { email }), password: account.password, proxy: account.proxy ?? '' };
    if (index >= 0) list[index] = entry; else list.push(entry);
    raw.imap.accounts = list;
  });
}

export function removeImapAccount(file: string, parentEmail: string): void {
  const email = parentEmail.toLowerCase();
  updateJsonFile(file, raw => {
    if (Array.isArray(raw?.imap?.accounts)) raw.imap.accounts = raw.imap.accounts.filter((a: any) => !(a && same(a, email)));
  });
}

export class ImapLoginError extends Error {
  constructor(message: string, readonly authFailed: boolean) {
    super(message);
  }
}

/** Один пробный вход с теми же сервером и логином, что у gRPC-сервиса. Без повторов: частые отказы блокируют Apple ID. */
export async function checkImapLogin(file: string, account: ImapAccount): Promise<void> {
  let imap: ImapConfig;
  try { imap = merge(MAIL_CODE_DEFAULTS.imap, readJson(file).imap ?? {}); } catch (error) {
    throw new ImapLoginError(`mail-code.json не читается: ${error instanceof Error ? error.message : error}`, false);
  }
  const box = new Mailbox(account, imap, () => {});
  try {
    await box.open();
  } catch (error) {
    throw new ImapLoginError(error instanceof Error ? error.message : String(error), box.authFailed);
  } finally {
    await box.close();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Состояние ящиков от работающего gRPC-сервиса; null — сервис не запущен или ещё ничего не записал. */
export function readImapStatus(mailCodeFile: string): Record<string, ImapStatusEntry> | null {
  try {
    const status = readJson(imapStatusPath(mailCodeFile)) as Partial<ImapStatusFile>;
    if (!status.pid || !alive(status.pid)) return null;
    return status.accounts ?? {};
  } catch {
    return null;
  }
}
