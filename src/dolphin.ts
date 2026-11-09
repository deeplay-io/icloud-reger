import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

const DOLPHIN_API = 'http://127.0.0.1:3001';
const DOLPHIN_EXE = 'Dolphin Anty.exe';

/** Минимум fetch, который нужен для локального API Dolphin и CDP; в тестах подменяется. */
export type Request = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class DolphinError extends Error {
  constructor(message: string, readonly code = '') {
    super(message);
  }
}

export async function findDolphinExe(customPath?: string): Promise<string | null> {
  const candidates: string[] = [];
  if (customPath) candidates.push(customPath);
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) candidates.push(path.join(base, 'Dolphin Anty', DOLPHIN_EXE));
  }
  if (process.env.LOCALAPPDATA) {
    for (const dir of ['dolphin_anty', 'Dolphin Anty']) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', dir, DOLPHIN_EXE));
  }
  for (const file of candidates) {
    try {
      if ((await stat(file)).isFile()) return file;
    } catch { /* следующая папка */ }
  }
  return null;
}

export function dolphinRunning(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq ' + DOLPHIN_EXE, '/NH', '/FO', 'CSV'], { windowsHide: true }, (error, stdout) => {
      resolve(!error && String(stdout).toLowerCase().includes('"' + DOLPHIN_EXE.toLowerCase() + '"'));
    });
  });
}

// Dolphin Anty — Electron-приложение: унаследованные ELECTRON_* (например, ELECTRON_RUN_AS_NODE, с которым работает
// сам сервис) запустили бы его как голый Node без окна и API. Отдельным процессом, чтобы он пережил сервис.
export function launchDolphin(exe: string): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ELECTRON_/i.test(key)));
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { cwd: path.dirname(exe), env, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

// Любой HTTP-ответ (даже 401/404) значит, что локальный API поднят; не поднят — только сетевая ошибка или таймаут.
async function apiReachable(request: Request): Promise<boolean> {
  try {
    await request(DOLPHIN_API + '/v1.0/browser_profiles', { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

export interface EnsureApiOptions {
  dolphinPath?: string;
  onStatus?: (text: string) => void;
  findExe?: (customPath?: string) => Promise<string | null>;
  isRunning?: () => Promise<boolean>;
  launch?: (exe: string) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: Sleep;
  now?: () => number;
}

/** coldStart: Dolphin ещё не был готов и после ответа API какое-то время может входить в аккаунт. */
export async function ensureDolphinApi(request: Request = fetch, {
  dolphinPath,
  onStatus = () => {},
  findExe = findDolphinExe,
  isRunning = dolphinRunning,
  launch = launchDolphin,
  timeoutMs = 90000,
  intervalMs = 1000,
  sleep = realSleep,
  now = Date.now,
}: EnsureApiOptions = {}): Promise<{ launched: boolean; coldStart: boolean }> {
  if (await apiReachable(request)) return { launched: false, coldStart: false };
  let launched = false;
  if (await isRunning()) {
    onStatus('Dolphin Anty запускается, жду готовности…');
  } else {
    const exe = await findExe(dolphinPath);
    if (!exe) {
      throw new DolphinError('Dolphin Anty не запущен и не найден в стандартных папках. Запустите его вручную или укажите путь к «' + DOLPHIN_EXE + '» в browser.dolphinPath (config.json).');
    }
    onStatus('Dolphin Anty не запущен — запускаю…');
    try {
      await launch(exe);
    } catch (e) {
      throw new DolphinError('Не удалось запустить Dolphin Anty (' + exe + '): ' + (e instanceof Error ? e.message : e));
    }
    launched = true;
    onStatus('Dolphin Anty запущен, жду готовности…');
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    if (await apiReachable(request)) return { launched, coldStart: true };
  }
  throw new DolphinError('Dolphin Anty не ответил на ' + DOLPHIN_API + ' за ' + Math.round(timeoutMs / 1000) + ' с. Проверьте, что вход в аккаунт Dolphin выполнен, и повторите подключение.');
}

/** Порт CDP, который Dolphin записал при запуске профиля с автоматизацией. */
export async function savedEndpoint(id: string): Promise<{ port: number; endpoint: string } | null> {
  if (!process.env.APPDATA) return null;
  try {
    const file = path.join(process.env.APPDATA, 'dolphin_anty', 'browser_profiles', id, 'data_dir', 'DevToolsActivePort');
    const [port, endpoint] = (await readFile(file, 'utf8')).trim().split(/\r?\n/);
    return { port: Number(port), endpoint };
  } catch {
    return null;
  }
}

export const PROFILE_REQUIRES_RESTART = 'PROFILE_REQUIRES_RESTART';

function restartRequired(): DolphinError {
  return new DolphinError('Профиль уже открыт без доступного порта автоматизации. Нажмите «Перезапустить профиль»: окно этого профиля закроется и откроется заново.', PROFILE_REQUIRES_RESTART);
}

export interface ConnectOptions {
  restart?: boolean;
  readEndpoint?: typeof savedEndpoint;
  ensureApi?: (request: Request, options: { dolphinPath?: string; onStatus?: (text: string) => void }) => Promise<{ launched: boolean; coldStart: boolean }>;
  dolphinPath?: string;
  onStatus?: (text: string) => void;
  coldStartRetryMs?: number;
  sleep?: Sleep;
  now?: () => number;
}

/**
 * Адрес CDP профиля Dolphin: живой порт открытого профиля, иначе запуск профиля с автоматизацией
 * (закрытый профиль при этом откроется). Профиль, открытый без автоматизации, перезапускается только при restart.
 */
export async function connectProfile(profileId: string, request: Request = fetch, {
  restart = false,
  readEndpoint = savedEndpoint,
  ensureApi = ensureDolphinApi,
  dolphinPath,
  onStatus = () => {},
  coldStartRetryMs = 60000,
  sleep = realSleep,
  now = Date.now,
}: ConnectOptions = {}): Promise<{ profileId: string; cdpUrl: string }> {
  const id = String(profileId ?? '').trim();
  if (!/^\d+$/.test(id)) throw new DolphinError('Введите числовой ID профиля Dolphin Anty.');
  const baseUrl = DOLPHIN_API + '/v1.0/browser_profiles/' + id;
  if (!restart) {
    const saved = await readEndpoint(id);
    if (saved && Number.isInteger(saved.port) && saved.port > 0 && saved.port <= 65535 && saved.endpoint?.startsWith('/devtools/browser/')) {
      const cdpUrl = 'http://127.0.0.1:' + saved.port;
      try {
        const response = await request(cdpUrl + '/json/version', { signal: AbortSignal.timeout(3000) });
        const version = await response.json();
        if (response.ok && new URL(version.webSocketDebuggerUrl).pathname === saved.endpoint.trim()) {
          return { profileId: id, cdpUrl };
        }
      } catch { /* Устаревший файл порта: просим Dolphin запустить профиль. */ }
    }
  }
  const { coldStart } = await ensureApi(request, { dolphinPath, onStatus });
  if (restart) {
    const stopped = await request(baseUrl + '/stop', { signal: AbortSignal.timeout(60000) });
    const result = await stopped.json();
    if (!stopped.ok || result.success === false) {
      throw new DolphinError('Не удалось остановить профиль: ' + (result.message || result.error || ('HTTP ' + stopped.status)));
    }
  }
  if (coldStart) onStatus('Dolphin Anty готов, открываю профиль ' + id + '…');
  // Сразу после запуска Dolphin /start может падать, пока он входит в аккаунт
  // (видели вживую: 500 "Subscription load discarded: the API token changed during the request").
  const retryUntil = coldStart ? now() + coldStartRetryMs : 0;
  let response;
  let data;
  for (let attempt = 0; ; attempt++) {
    response = await request(baseUrl + '/start?automation=1', { signal: AbortSignal.timeout(60000) });
    data = await response.json().catch(() => ({}));
    if (/already\s+running/i.test(String(data.message || data.error || ''))) {
      if (restart && attempt < 10) {
        await sleep(1000);
        continue;
      }
      throw restartRequired();
    }
    if ((!response.ok || data.success === false) && now() < retryUntil) {
      onStatus('Dolphin Anty ещё загружается, повторяю открытие профиля…');
      await sleep(2000);
      continue;
    }
    if (response.status === 401) {
      throw new DolphinError('Dolphin Anty требует авторизацию локального API. Авторизуйте его через API-токен Dolphin и повторите подключение.');
    }
    break;
  }
  if (!response.ok || data.success === false) {
    throw new DolphinError('Dolphin Anty: ' + (data.message || data.error || ('HTTP ' + response.status)));
  }
  const port = Number(data.automation?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DolphinError('Dolphin не вернул порт автоматизации. Если профиль уже открыт, закройте его в Dolphin и повторите подключение.');
  }
  const cdpUrl = 'http://127.0.0.1:' + port;
  const version = await request(cdpUrl + '/json/version', { signal: AbortSignal.timeout(10000) });
  if (!version.ok || !(await version.json()).webSocketDebuggerUrl) {
    throw new DolphinError('Профиль запущен, но подключение к браузеру пока недоступно. Повторите подключение.');
  }
  return { profileId: id, cdpUrl };
}
