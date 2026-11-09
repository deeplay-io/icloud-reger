const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { connectProfile } = require('./dolphin');

let win = null;
let child = null;
const logBuffer = [];

// dev: корень проекта; packaged: resources/app (asar: false)
function appRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
}

function configPath() {
  if (!app.isPackaged) {
    const p = path.join(appRoot(), 'config.json');
    if (!fs.existsSync(p)) {
      fs.copyFileSync(path.join(appRoot(), 'config.example.json'), p);
    }
    return p;
  }
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'config.json');
  if (!fs.existsSync(p)) {
    const example = path.join(appRoot(), 'config.example.json');
    if (fs.existsSync(example)) fs.copyFileSync(example, p);
  }
  return p;
}

function readApiPort() {
  try {
    return (JSON.parse(fs.readFileSync(configPath(), 'utf8')).api || {}).port || 8787;
  } catch {
    return 8787;
  }
}

function pushLog(line) {
  line = String(line).trimEnd();
  if (!line) return;
  logBuffer.push(line);
  if (logBuffer.length > 2000) logBuffer.splice(0, 1000);
  if (win && !win.isDestroyed()) win.webContents.send('svc-log', line);
}

let startingService = false;
async function startChild() {
  if (child || startingService) return { ok: false, error: 'сервис уже запущен или запускается' };
  startingService = true;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const port = cfg.api?.port || 8787;
    const host = cfg.api?.host || '127.0.0.1';
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE'
        ? `Порт ${host}:${port} занят другим процессом. Остановите другую копию сервиса или измените api.port в config.json.`
        : e.message)));
      probe.listen(port, host, () => probe.close(resolve));
    });
    return spawnChild();
  } catch (e) {
    pushLog(e.message);
    return { ok: false, error: e.message };
  } finally {
    startingService = false;
  }
}

function spawnChild() {
  if (child) return { ok: false, error: 'сервис уже запущен' };
  const root = appRoot();
  const localNode = path.join(root, '.runtime', 'node_modules', 'node-win-x64', 'bin', 'node.exe');
  const node = !app.isPackaged && fs.existsSync(localNode) ? localNode : 'node';
  const args = [path.join(root, 'dist', 'index.js')];
  const env = Object.assign({}, process.env);
  env.CONFIG_FILE = configPath();
  try {
    child = spawn(node, args, { cwd: root, env, windowsHide: true });
  } catch (e) {
    child = null;
    return { ok: false, error: String(e.message || e) };
  }
  child.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach(pushLog));
  child.stderr.on('data', (d) => String(d).split(/\r?\n/).forEach(pushLog));
  const spawned = child;
  child.on('exit', (code) => {
    pushLog('— сервис завершился (код ' + code + ') —');
    if (child === spawned) child = null;
    if (win && !win.isDestroyed()) win.webContents.send('svc-state', !!child);
  });
  child.on('error', (e) => {
    pushLog('не удалось запустить сервис: ' + e.message + ' (установлен ли Node.js 20+ в PATH?)');
    if (child === spawned) child = null;
    if (win && !win.isDestroyed()) win.webContents.send('svc-state', !!child);
  });
  pushLog('— сервис запускается —');
  return { ok: true };
}

function stopChild() {
  if (!child) return { ok: false, error: 'сервис не запущен' };
  try { child.kill(); } catch { /* ignore */ }
  child = null;
  pushLog('— сервис остановлен —');
  if (win && !win.isDestroyed()) win.webContents.send('svc-state', false);
  return { ok: true };
}

ipcMain.handle('svc:start', async () => {
  const r = await startChild();
  if (win && !win.isDestroyed()) win.webContents.send('svc-state', !!child);
  return r;
});
ipcMain.handle('svc:stop', () => stopChild());
ipcMain.handle('svc:state', () => ({ running: !!child }));
ipcMain.handle('svc:logs', () => logBuffer.slice(-500));
ipcMain.handle('config:path', () => configPath());
ipcMain.handle('config:open', () => shell.openPath(configPath()));
ipcMain.handle('dolphin:settings', () => {
  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  return { profileId: cfg.browser?.dolphinProfileId || '', cdpUrl: cfg.browser?.cdpUrl || '' };
});
let connectingDolphin = false;
ipcMain.handle('dolphin:connect', async (_e, profileId, restart = false) => {
  if (connectingDolphin) return { ok: false, error: 'Подключение уже выполняется.' };
  connectingDolphin = true;
  try {
    const cfgFile = configPath();
    const result = await connectProfile(profileId, fetch, {
      restart: restart === true,
      dolphinPath: JSON.parse(fs.readFileSync(cfgFile, 'utf8')).browser?.dolphinPath,
      onStatus: (text) => {
        pushLog('Dolphin Anty: ' + text);
        if (win && !win.isDestroyed()) win.webContents.send('dolphin-status', text);
      },
    });
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.browser = { ...cfg.browser, dolphinProfileId: result.profileId, cdpUrl: result.cdpUrl };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    if (child) {
      const previous = child;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Не удалось остановить сервис. Перезапустите приложение.')), 5000);
        previous.once('exit', () => { clearTimeout(timer); resolve(); });
        previous.kill();
      });
      const started = await startChild();
      if (!started.ok) throw new Error(started.error);
    }
    pushLog('Dolphin Anty: профиль ' + result.profileId + ', CDP ' + result.cdpUrl);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, code: e.code, error: 'Не удалось подключить профиль: ' + (e.message || String(e)) };
  } finally {
    connectingDolphin = false;
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopChild();
  if (process.platform !== 'darwin') app.quit();
});
