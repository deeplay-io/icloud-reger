const { app, BrowserWindow, clipboard, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');

let win = null;
const logBuffer = [];

// dev: корень проекта; packaged: resources/app (asar: false)
function appRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
}

// dev: файлы в корне проекта; packaged: в userData, чтобы обновление приложения их не затирало
function userDir() {
  return app.isPackaged ? app.getPath('userData') : appRoot();
}

function userFile(name, example) {
  const dir = userDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) {
    const source = path.join(appRoot(), example);
    if (fs.existsSync(source)) fs.copyFileSync(source, p);
  }
  return p;
}

const configPath = () => userFile('config.json', 'config.example.json');
const mailCodeConfigPath = () => userFile('mail-code.json', 'mail-code.example.json');

function readConfig(file = configPath()) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// База основного сервиса: gRPC-сервис читает из неё родителя алиаса, чтобы искать письмо только в его ящике.
function readDbFile() {
  const file = configPath();
  try {
    const db = (readConfig(file).db || {}).file || './data/codes.db';
    return path.isAbsolute(db) ? db : path.join(path.dirname(file), db);
  } catch {
    return path.join(userDir(), 'data', 'codes.db');
  }
}

function readApiPort() {
  try {
    return (readConfig().api || {}).port || 8787;
  } catch {
    return 8787;
  }
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function pushLog(line) {
  line = String(line).trimEnd();
  if (!line) return;
  logBuffer.push(line);
  if (logBuffer.length > 2000) logBuffer.splice(0, 1000);
  send('svc-log', line);
}

// Установленное приложение запускает сервисы своим же exe в режиме Node: системный Node.js на сервере не нужен,
// а better-sqlite3 electron-builder собирает как раз под Electron.
function nodeRuntime() {
  if (app.isPackaged) return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const localNode = path.join(appRoot(), '.runtime', 'node_modules', 'node-win-x64', 'bin', 'node.exe');
  return { command: fs.existsSync(localNode) ? localNode : 'node', env: {} };
}

// Антивирус с проверкой защищённых соединений (Kaspersky и т. п.) подменяет сертификат imap.mail.me.com своим,
// корень которого лежит только в хранилище Windows. Node сервисов (у Electron 31 нет --use-system-ca) ему
// не доверяет: «self-signed certificate in certificate chain». Выгружаем корни Windows в PEM и отдаём сервисам
// через NODE_EXTRA_CA_CERTS — к встроенным корням Node они добавляются, а не заменяют их.
const SYSTEM_CA_SCRIPT = 'Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root | Sort-Object Thumbprint -Unique | '
  + 'ForEach-Object { "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($_.RawData, \'InsertLineBreaks\') + "`n-----END CERTIFICATE-----" }';
let systemCa = null;

function systemCaFile() {
  if (process.platform !== 'win32' || process.env.NODE_EXTRA_CA_CERTS) return Promise.resolve(null);
  systemCa ??= new Promise((resolve) => {
    const file = path.join(app.getPath('userData'), 'system-ca.pem');
    let settled = false;
    // Без PEM сервисы всё равно запускаются; следующий запуск сервиса попробует выгрузить снова.
    const failed = (why) => {
      if (settled) return;
      settled = true;
      pushLog('сертификаты Windows не выгружены, сервисы доверяют только встроенным корням Node: ' + why);
      setImmediate(() => { systemCa = null; });
      resolve(null);
    };
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SYSTEM_CA_SCRIPT], { windowsHide: true });
    } catch (e) {
      return failed(e.message);
    }
    const timer = setTimeout(() => proc.kill(), 20000);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); failed(e.message); });
    // 'close', а не 'exit': к нему stdout уже дочитан до конца.
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      const count = (out.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
      if (code !== 0 || !count) return failed(err.trim().split(/\r?\n/)[0] || 'PowerShell завершился с кодом ' + code);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, out.replace(/\r\n/g, '\n'), 'utf8');
      } catch (e) {
        return failed(e.message);
      }
      settled = true;
      pushLog('сертификаты Windows для сервисов: ' + count + ' корневых → ' + file);
      resolve(file);
    });
  });
  return systemCa;
}

function waitExit(proc, ms) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    proc.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

/** Дочерний процесс сервиса: запуск с проверкой порта, лог в общее окно, остановка с ожиданием выхода. */
function createService({ name, title, logPrefix, script, configFile, configEnv, address, extraEnv = () => ({}) }) {
  let child = null;
  let starting = false;
  const notify = () => send(name + '-state', !!child);

  function spawnChild(file, caFile) {
    const runtime = nodeRuntime();
    const env = Object.assign({}, process.env, runtime.env, caFile ? { NODE_EXTRA_CA_CERTS: caFile } : {}, extraEnv(), { [configEnv]: file });
    const proc = spawn(runtime.command, [path.join(appRoot(), 'dist', script)], { cwd: appRoot(), env, windowsHide: true });
    child = proc;
    const output = (d) => String(d).split(/\r?\n/).forEach((line) => line.trim() && pushLog(logPrefix + line));
    proc.stdout.on('data', output);
    proc.stderr.on('data', output);
    proc.on('exit', (code) => {
      pushLog('— ' + title + ' завершился (код ' + code + ') —');
      if (child === proc) child = null;
      notify();
    });
    proc.on('error', (e) => {
      pushLog('не удалось запустить ' + title + ': ' + e.message + (app.isPackaged ? '' : ' (установлен ли Node.js 20+ в PATH?)'));
      if (child === proc) child = null;
      notify();
    });
    pushLog('— ' + title + ' запускается —');
    return { ok: true };
  }

  return {
    running: () => !!child,
    async start() {
      if (child || starting) return { ok: false, error: title + ' уже запущен или запускается' };
      starting = true;
      try {
        const file = configFile();
        const { host, port, key } = address(readConfig(file));
        await new Promise((resolve, reject) => {
          const probe = net.createServer();
          probe.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE'
            ? `Порт ${host}:${port} занят другим процессом. Остановите другую копию сервиса или измените ${key} в ${path.basename(file)}.`
            : e.message)));
          probe.listen(port, host, () => probe.close(resolve));
        });
        return spawnChild(file, await systemCaFile());
      } catch (e) {
        pushLog(e.message);
        return { ok: false, error: e.message };
      } finally {
        starting = false;
        notify();
      }
    },
    async stop() {
      const proc = child;
      if (!proc) return { ok: false, error: title + ' не запущен' };
      child = null;
      try { proc.kill(); } catch { /* ignore */ }
      pushLog('— ' + title + ' остановлен —');
      notify();
      return { ok: await waitExit(proc, 5000) };
    },
  };
}

const services = {
  svc: createService({
    name: 'svc',
    title: 'сервис',
    logPrefix: '',
    script: 'index.js',
    configFile: configPath,
    configEnv: 'CONFIG_FILE',
    address: (cfg) => ({ host: cfg.api?.host || '127.0.0.1', port: cfg.api?.port || 8787, key: 'api.port' }),
    // IMAP-пароли родителей, введённые в окне, сервис записывает в mail-code.json для gRPC-сервиса.
    extraEnv: () => ({ MAIL_CODE_CONFIG: mailCodeConfigPath() }),
  }),
  grpc: createService({
    name: 'grpc',
    title: 'gRPC-сервис',
    logPrefix: '[gRPC] ',
    script: 'mailCodeMain.js',
    configFile: mailCodeConfigPath,
    configEnv: 'MAIL_CODE_CONFIG',
    address: (cfg) => ({ host: cfg.grpc?.host || '0.0.0.0', port: cfg.grpc?.port || 50051, key: 'grpc.port' }),
    // Запасной путь чтения кодов идёт через браузер HTTP-сервиса этого же окна; база — для адресного поиска по ящикам.
    extraEnv: () => ({ CODES_API_URL: 'http://127.0.0.1:' + readApiPort(), CODES_DB: readDbFile() }),
  }),
};

for (const [name, service] of Object.entries(services)) {
  ipcMain.handle(name + ':start', () => service.start());
  ipcMain.handle(name + ':stop', () => service.stop());
  ipcMain.handle(name + ':state', () => ({ running: service.running() }));
}
ipcMain.handle('svc:logs', () => logBuffer.slice(-500));
ipcMain.handle('config:path', () => configPath());
ipcMain.handle('config:open', () => shell.openPath(configPath()));
ipcMain.handle('mail-config:open', () => shell.openPath(mailCodeConfigPath()));
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

// Раздел «Подключение»: по каким адресам машины клиент достучится до gRPC.
ipcMain.handle('net:info', () => {
  let grpc = {};
  try { grpc = readConfig(path.join(userDir(), 'mail-code.json')).grpc || {}; } catch { /* файла ещё нет: значения по умолчанию */ }
  // VPN и виртуальные адаптеры в конец: первым идёт адрес, который подставляется в пример grpcurl.
  const virtual = (name) => /vpn|vethernet|virtual|vmware|wsl|hyper-v|tap|tun|tailscale|zerotier|hamachi|amnezia|wireguard/i.test(name);
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || [])
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => ({ name, address: a.address })))
    .sort((a, b) => virtual(a.name) - virtual(b.name));
  return { host: grpc.host || '0.0.0.0', port: grpc.port || 50051, running: services.grpc.running(), addresses };
});
ipcMain.handle('net:public-ip', async () => {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { ok: true, address: (await res.text()).trim() };
  } catch (e) {
    return { ok: false, error: 'Не удалось узнать внешний IP: ' + (e.message || String(e)) };
  }
});
ipcMain.handle('api:proxy', async (_e, { method = 'GET', path: p = '/', body } = {}) => {
  const port = readApiPort();
  try {
    const res = await fetch('http://127.0.0.1:' + port + p, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data };
  } catch (e) {
    return { status: 0, body: { error: 'API недоступен (http://127.0.0.1:' + port + '): ' + e.message } };
  }
});

// Обновления: релизы приватного репозитория, скачиваются сами, ставятся только по кнопке.
const UPDATE_FEED = { provider: 'github', owner: 'deeplay-io', repo: 'icloud-reger', private: true };
const CHECK_EVERY_MS = 60 * 60 * 1000;
let update = { status: 'off' };

function setUpdate(state) {
  update = { version: app.getVersion(), ...state };
  send('update-state', update);
}

function updateError(e) {
  const text = String(e?.message || e).split('\n')[0].slice(0, 300);
  return /\b(401|403|404)\b/.test(text)
    ? 'GitHub не отдал релизы: проверьте update.token в config.json (доступ на чтение к deeplay-io/icloud-reger, срок действия). ' + text
    : text;
}

function setupUpdates() {
  if (!app.isPackaged) return setUpdate({ status: 'off' });
  // Токен только на чтение репозитория лежит в config.json на сервере, а не в установщике.
  let token = '';
  try { token = readConfig().update?.token || ''; } catch { /* config.json покажет ошибку при запуске сервиса */ }
  if (!token) return setUpdate({ status: 'no-token' });
  autoUpdater.setFeedURL({ ...UPDATE_FEED, token });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'latest' }));
  autoUpdater.on('update-available', (info) => setUpdate({ status: 'downloading', next: info.version }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', next: update.next, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => setUpdate({ status: 'ready', next: info.version }));
  autoUpdater.on('error', (e) => {
    const error = updateError(e);
    pushLog('обновление: ' + error);
    setUpdate({ status: 'error', error });
  });
  const check = () => { if (update.status !== 'ready') autoUpdater.checkForUpdates().catch(() => { /* придёт в 'error' */ }); };
  check();
  setInterval(check, CHECK_EVERY_MS);
}

// После обновления поднимаем те сервисы, что работали до него.
const restartFile = () => path.join(app.getPath('userData'), 'restart-services.json');

function restoreServices() {
  let names = [];
  try { names = JSON.parse(fs.readFileSync(restartFile(), 'utf8')); } catch { return; }
  fs.rmSync(restartFile(), { force: true });
  for (const name of names) if (services[name]) services[name].start();
}

let installing = false;
ipcMain.handle('update:state', () => update);
ipcMain.handle('update:install', async () => {
  if (update.status !== 'ready') return { ok: false, error: 'обновление ещё не скачано' };
  if (installing) return { ok: false, error: 'обновление уже устанавливается' };
  installing = true;
  const running = Object.keys(services).filter((name) => services[name].running());
  fs.writeFileSync(restartFile(), JSON.stringify(running), 'utf8');
  // Работающие сервисы держат открытыми файлы приложения (asar: false), и установщик не сможет их заменить.
  const stopped = await Promise.all(running.map((name) => services[name].stop()));
  if (stopped.some((r) => !r.ok)) {
    installing = false;
    return { ok: false, error: 'Сервис не остановился за 5 секунд. Закройте приложение и запустите снова.' };
  }
  pushLog('— устанавливаю обновление ' + update.next + ' —');
  autoUpdater.quitAndInstall(true, true);
  return { ok: true };
});

function createWindow() {
  win = new BrowserWindow({
    width: 1150,
    height: 780,
    minWidth: 440,
    minHeight: 480,
    title: 'ICloud Codes',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  restoreServices();
  setupUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const service of Object.values(services)) service.stop();
  if (process.platform !== 'darwin') app.quit();
});
