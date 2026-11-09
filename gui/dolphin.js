const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const DOLPHIN_API = 'http://127.0.0.1:3001';
const DOLPHIN_EXE = 'Dolphin Anty.exe';

async function findDolphinExe(customPath) {
  const candidates = [];
  if (customPath) candidates.push(customPath);
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) candidates.push(path.join(base, 'Dolphin Anty', DOLPHIN_EXE));
  }
  if (process.env.LOCALAPPDATA) {
    for (const dir of ['dolphin_anty', 'Dolphin Anty']) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', dir, DOLPHIN_EXE));
  }
  for (const file of candidates) {
    try {
      if ((await fs.stat(file)).isFile()) return file;
    } catch { /* try the next location */ }
  }
  return null;
}

function dolphinRunning() {
  return new Promise(resolve => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq ' + DOLPHIN_EXE, '/NH', '/FO', 'CSV'], { windowsHide: true }, (error, stdout) => {
      resolve(!error && String(stdout).toLowerCase().includes('"' + DOLPHIN_EXE.toLowerCase() + '"'));
    });
  });
}

// Dolphin Anty is an Electron app: inherited ELECTRON_* variables (e.g. ELECTRON_RUN_AS_NODE) would make it
// start as plain Node without a window or API. Detached, so it keeps running after this app closes.
function launchDolphin(exe) {
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

// Any HTTP answer (even 401/404) means the local API is up; only network errors and timeouts mean it is not.
async function apiReachable(request) {
  try {
    await request(DOLPHIN_API + '/v1.0/browser_profiles', { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function ensureDolphinApi(request = fetch, {
  dolphinPath,
  onStatus = () => {},
  findExe = findDolphinExe,
  isRunning = dolphinRunning,
  launch = launchDolphin,
  timeoutMs = 90000,
  intervalMs = 1000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  // coldStart: Dolphin was not ready yet, so it may still be logging in for a while after the API answers.
  if (await apiReachable(request)) return { launched: false, coldStart: false };
  let launched = false;
  if (await isRunning()) {
    onStatus('Dolphin Anty запускается, жду готовности…');
  } else {
    const exe = await findExe(dolphinPath);
    if (!exe) {
      throw new Error('Dolphin Anty не запущен и не найден в стандартных папках. Запустите его вручную или укажите путь к «' + DOLPHIN_EXE + '» в browser.dolphinPath (config.json).');
    }
    onStatus('Dolphin Anty не запущен — запускаю…');
    try {
      await launch(exe);
    } catch (e) {
      throw new Error('Не удалось запустить Dolphin Anty (' + exe + '): ' + (e.message || e));
    }
    launched = true;
    onStatus('Dolphin Anty запущен, жду готовности…');
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    if (await apiReachable(request)) return { launched, coldStart: true };
  }
  throw new Error('Dolphin Anty не ответил на ' + DOLPHIN_API + ' за ' + Math.round(timeoutMs / 1000) + ' с. Проверьте, что вход в аккаунт Dolphin выполнен, и повторите подключение.');
}

async function savedEndpoint(id) {
  if (!process.env.APPDATA) return null;
  try {
    const file = path.join(process.env.APPDATA, 'dolphin_anty', 'browser_profiles', id, 'data_dir', 'DevToolsActivePort');
    const [port, endpoint] = (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/);
    return { port: Number(port), endpoint };
  } catch {
    return null;
  }
}

function restartRequired() {
  const error = new Error('Профиль уже открыт без доступного порта автоматизации. Нажмите «Перезапустить профиль и подключить»: окно этого профиля закроется и откроется заново.');
  error.code = 'PROFILE_REQUIRES_RESTART';
  return error;
}

async function connectProfile(profileId, request = fetch, {
  restart = false,
  readEndpoint = savedEndpoint,
  ensureApi = ensureDolphinApi,
  dolphinPath,
  onStatus = () => {},
  coldStartRetryMs = 60000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const id = String(profileId ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Введите числовой ID профиля Dolphin Anty.');
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
      } catch { /* Stale port file: ask Dolphin to start the profile. */ }
    }
  }
  const { coldStart } = await ensureApi(request, { dolphinPath, onStatus });
  if (restart) {
    const stopped = await request(baseUrl + '/stop', { signal: AbortSignal.timeout(60000) });
    const result = await stopped.json();
    if (!stopped.ok || result.success === false) {
      throw new Error('Не удалось остановить профиль: ' + (result.message || result.error || ('HTTP ' + stopped.status)));
    }
  }
  if (coldStart) onStatus('Dolphin Anty готов, открываю профиль ' + id + '…');
  // Right after Dolphin starts, /start can fail while it is still logging in
  // (seen live: 500 "Subscription load discarded: the API token changed during the request").
  const retryUntil = coldStart ? now() + coldStartRetryMs : 0;
  let response;
  let data;
  for (let attempt = 0; ; attempt++) {
    response = await request(
      baseUrl + '/start?automation=1',
      { signal: AbortSignal.timeout(60000) },
    );
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
      throw new Error('Dolphin Anty требует авторизацию локального API. Авторизуйте его через API-токен Dolphin и повторите подключение.');
    }
    break;
  }
  if (!response.ok || data.success === false) {
    throw new Error('Dolphin Anty: ' + (data.message || data.error || ('HTTP ' + response.status)));
  }
  const port = Number(data.automation?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Dolphin не вернул порт автоматизации. Если профиль уже открыт, закройте его в Dolphin и повторите подключение.');
  }
  const cdpUrl = 'http://127.0.0.1:' + port;
  const version = await request(cdpUrl + '/json/version', { signal: AbortSignal.timeout(10000) });
  if (!version.ok || !(await version.json()).webSocketDebuggerUrl) {
    throw new Error('Профиль запущен, но подключение к браузеру пока недоступно. Повторите подключение.');
  }
  return { profileId: id, cdpUrl };
}

module.exports = { connectProfile, ensureDolphinApi, findDolphinExe, dolphinRunning, launchDolphin };
