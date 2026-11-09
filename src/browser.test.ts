import test from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'puppeteer-core';
import { Db } from './db';
import { DEFAULTS } from './config';
import { BrowserPool, RETRY_MS, validProfile } from './browser';
import { DolphinError, PROFILE_REQUIRES_RESTART } from './dolphin';

/** Браузер без close(): пул обязан только отключаться, закрытие убило бы профиль с залогиненным Apple ID. */
class FakeBrowser {
  connected = true;
  disconnects = 0;
  private handlers: (() => void)[] = [];
  constructor(readonly cdpUrl: string) {}
  on(event: string, handler: () => void) { if (event === 'disconnected') this.handlers.push(handler); return this; }
  // Как puppeteer: событие 'disconnected' приходит прямо из disconnect().
  async disconnect() { this.disconnects++; this.crash(); }
  crash() { this.connected = false; for (const handler of this.handlers) handler(); }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const db = new Db(':memory:');
  let now = 100000000;
  let port = 50000;
  const resolved: { id: string; restart: boolean }[] = [];
  const browsers: FakeBrowser[] = [];
  let active = 0;
  let maxActive = 0;
  const failing = new Map<string, Error>();
  const logs: string[] = [];
  const pool = new BrowserPool(DEFAULTS.browser, () => db.workingParents(), line => logs.push(line), {
    now: () => now,
    resolveProfile: async (id, { restart }) => {
      resolved.push({ id, restart });
      active++;
      maxActive = Math.max(maxActive, active);
      await flush();
      active--;
      const error = failing.get(id);
      if (error) throw error;
      return `http://127.0.0.1:${++port}`;
    },
    connect: async cdpUrl => {
      const browser = new FakeBrowser(cdpUrl);
      browsers.push(browser);
      return browser as unknown as Browser;
    },
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await flush(); };
  return { db, pool, resolved, browsers, failing, logs, settle, maxActive: () => maxActive, advance: (ms: number) => { now += ms; } };
}

test('every working parent with a profile is connected; Dolphin requests go one at a time; a CDP address skips Dolphin', async () => {
  const { db, pool, resolved, browsers, settle, maxActive } = setup();
  const a = db.addParent('a@icloud.com', { profile: '101' });
  const b = db.addParent('b@icloud.com', { profile: '102' });
  const c = db.addParent('c@icloud.com', { profile: 'http://127.0.0.1:9222' });
  const none = db.addParent('none@icloud.com');
  const off = db.addParent('off@icloud.com', { profile: '103', archived: true });
  pool.tick();
  await settle();
  assert.deepEqual(resolved.map(r => r.id), ['101', '102']);
  assert.equal(maxActive(), 1);
  assert.ok(browsers.some(browser => browser.cdpUrl === 'http://127.0.0.1:9222'));
  for (const parent of [a, b, c]) assert.equal(pool.status(parent.id).state, 'connected');
  assert.equal(pool.status(none.id).state, 'none');
  assert.equal(pool.status(off.id).state, 'none');
  await assert.rejects(pool.get(db.parentById(none.id)!), /не подключён: не задан ID профиля/);
  await assert.rejects(pool.get(db.parentById(off.id)!), /не подключён: родитель отключён/);
  pool.tick();
  await settle();
  assert.equal(resolved.length, 2, 'подключённых повторно не трогает');
});

test('after a failure the parent waits a minute; operations get the error at once; the button retries immediately', async () => {
  const { db, pool, resolved, failing, logs, settle, advance } = setup();
  const parent = db.addParent('a@icloud.com', { profile: '101' });
  failing.set('101', new Error('Dolphin Anty не отвечает'));
  pool.tick();
  await settle();
  assert.equal(pool.status(parent.id).state, 'error');
  await assert.rejects(pool.get(parent), /a@icloud.com не подключён: Dolphin Anty не отвечает/);
  pool.tick();
  await settle();
  assert.equal(resolved.length, 1);
  advance(RETRY_MS);
  pool.tick();
  await settle();
  assert.equal(resolved.length, 2);
  assert.equal(logs.filter(line => line.includes('Dolphin Anty не отвечает')).length, 1, 'одна и та же ошибка пишется в лог один раз');
  failing.delete('101');
  const status = await pool.connect(parent);
  assert.equal(status.state, 'connected');
  assert.equal(resolved.length, 3);
});

test('a closed profile is reconnected on the next pass with a freshly resolved port', async () => {
  const { db, pool, resolved, browsers, settle } = setup();
  const parent = db.addParent('a@icloud.com', { profile: '101' });
  pool.tick();
  await settle();
  const first = pool.status(parent.id).cdpUrl;
  browsers[0].crash();
  assert.equal(pool.status(parent.id).state, 'error');
  pool.tick();
  await settle();
  assert.equal(pool.status(parent.id).state, 'connected');
  assert.notEqual(pool.status(parent.id).cdpUrl, first);
  assert.deepEqual(resolved.map(r => r.restart), [false, false]);
});

test('a profile opened without automation is never restarted automatically, only by the button', async () => {
  const { db, pool, resolved, browsers, failing, settle, advance } = setup();
  const parent = db.addParent('a@icloud.com', { profile: '101' });
  failing.set('101', new DolphinError('Профиль уже открыт без доступного порта автоматизации.', PROFILE_REQUIRES_RESTART));
  pool.tick();
  await settle();
  assert.equal(pool.status(parent.id).code, PROFILE_REQUIRES_RESTART);
  advance(RETRY_MS);
  pool.tick();
  await settle();
  assert.ok(resolved.every(r => !r.restart));
  failing.delete('101');
  await pool.connect(parent, true);
  assert.equal(resolved.at(-1)!.restart, true);
  assert.equal(pool.status(parent.id).state, 'connected');
  // Перезапуск уже подключённого профиля отпускает старое подключение, не закрывая браузер.
  await pool.connect(db.parentById(parent.id)!, true);
  assert.equal(browsers[0].disconnects, 1);
});

test('changing or clearing the profile releases the old browser; archived parents are released by the pass', async () => {
  const { db, pool, browsers, logs, settle } = setup();
  const parent = db.addParent('a@icloud.com', { profile: '101' });
  pool.tick();
  await settle();
  db.updateParent(parent.id, { profile: '202' });
  pool.tick();
  await settle();
  assert.equal(browsers[0].disconnects, 1);
  assert.equal(browsers.length, 2);
  db.updateParent(parent.id, { archived: true });
  pool.tick();
  assert.equal(browsers[1].disconnects, 1);
  assert.equal(pool.status(parent.id).state, 'none');
  assert.ok(!logs.some(line => line.includes('переподключаю')), 'штатное отключение не выглядит как обрыв');
});

test('profile field accepts a Dolphin profile id or a CDP address', () => {
  assert.ok(validProfile('902053376'));
  assert.ok(validProfile('http://127.0.0.1:9222'));
  assert.ok(!validProfile('profile-1'));
  assert.ok(!validProfile('http://'));
});
