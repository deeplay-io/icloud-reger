import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi, type ApiContext } from './api';
import type { ClusterState } from './clusterSync';
import { DEFAULTS } from './config';
import { Db } from './db';
import { BrowserPool } from './browser';
import { AliasGenerator } from './aliasGen';
import { AliasSyncScheduler } from './aliasSyncScheduler';

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, mailCode: object = { imap: { accounts: [] } }, cluster?: ApiContext['cluster']) {
  const root = mkdtempSync(path.join(tmpdir(), 'icloud-api-test-'));
  const mailCodeFile = path.join(root, 'mail-code.json');
  writeFileSync(mailCodeFile, JSON.stringify(mailCode));
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULTS);
  const logs: string[] = [];
  const log = (line: string) => { logs.push(line); };
  const dropped: number[] = [];
  const pool = new BrowserPool(cfg.browser, () => db.workingParents(), log, {
    resolveProfile: async () => { throw new Error('Dolphin Anty не отвечает'); },
    connect: async () => { throw new Error('нет браузера'); },
  });
  const drop = pool.drop.bind(pool);
  pool.drop = id => { dropped.push(id); drop(id); };
  const generator = new AliasGenerator(cfg, db, log, { create: async () => { throw new Error('не в тесте'); }, ready: id => pool.isConnected(id) });
  const syncs = new AliasSyncScheduler(db, async () => { throw new Error('не в тесте'); }, log);
  const server = createApi({ cfg, db, pool, generator, syncs, mailCodeFile, log, cluster }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, route: string, body?: object) => {
    const res = await fetch(url + route, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data };
  };
  return { db, cfg, logs, dropped, call, mailCodeFile, root };
}

test('parents are added, configured and listed independently; auto-registration starts off', async t => {
  const { db, call, dropped } = await setup(t);
  assert.equal((await call('POST', '/parents', { email: 'bad' })).status, 400);
  assert.equal((await call('POST', '/parents', { email: 'p@icloud.com', profile: 'profile-1' })).status, 400);
  const added = await call('POST', '/parents', { email: 'First@iCloud.com', profile: '902053376' });
  assert.equal(added.status, 200);
  assert.equal(added.body.email, 'first@icloud.com');
  assert.equal(added.body.profile, '902053376');
  assert.equal(added.body.generator.enabled, false);
  assert.equal(added.body.generator.namePrefix, 'first');
  assert.equal(added.body.imap.state, 'none');
  assert.equal((await call('POST', '/parents', { email: 'first@icloud.com' })).status, 409);
  const second = await call('POST', '/parents', { email: 'second@icloud.com', profile: 'http://127.0.0.1:9333' });
  assert.equal(second.status, 200);

  const list = await call('GET', '/parents');
  assert.deepEqual(list.body.map((p: any) => p.email), ['first@icloud.com', 'second@icloud.com']);

  const id = added.body.id;
  const prefix = await call('PATCH', `/parents/${id}`, { namePrefix: 'mybox' });
  assert.equal(prefix.body.generator.nextName, 'mybox1');
  assert.equal((await call('PATCH', `/parents/${id}`, { namePrefix: 'bad@icloud.com' })).status, 400);
  assert.equal((await call('PATCH', `/parents/${id}`, { generatorEnabled: 'yes' })).status, 400);
  assert.equal((await call('PATCH', '/parents/999', { generatorEnabled: true })).status, 404);

  await call('PATCH', `/parents/${id}`, { profile: '111' });
  assert.deepEqual(dropped, [id], 'смена профиля отпускает старый браузер родителя');
  assert.equal(db.parentById(id)!.profile, '111');

  // Один профиль — один родитель в работе.
  const taken = await call('POST', '/parents', { email: 'third@icloud.com', profile: '111' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /уже у родителя first@icloud.com/);
  assert.equal((await call('PATCH', `/parents/${second.body.id}`, { profile: '111' })).status, 409);
  assert.equal((await call('PATCH', `/parents/${id}`, { profile: '111', namePrefix: 'box' })).status, 200, 'свой же профиль можно сохранить снова');
});

test('the per-parent switch applies at once and does not fire right after a long pause', async t => {
  const { db, cfg, call } = await setup(t);
  const parent = db.addParent('owner@icloud.com');
  const other = db.addParent('other@icloud.com');
  db.setGeneratorSchedule(parent.id, Date.now() - 24 * 60 * 60 * 1000);
  const before = Date.now();
  const on = await call('PATCH', `/parents/${parent.id}`, { generatorEnabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.generator.enabled, true);
  assert.ok(db.generatorNextRun(parent.id)! >= before + cfg.generator.minIntervalMinutes * 60000);
  assert.equal(db.parentById(other.id)!.generator_enabled, 0, 'другие родители не меняются');
  const health = await call('GET', '/health');
  assert.equal(health.body.parents.registering, 1);
  assert.equal(health.body.parents.working, 2);
  await call('PATCH', `/parents/${parent.id}`, { generatorEnabled: false });
  assert.equal(db.parentById(parent.id)!.generator_enabled, 0);
});

test('archiving turns auto-registration off and releases the browser; returning needs an explicit step', async t => {
  const { db, call, dropped } = await setup(t);
  const parent = db.addParent('owner@icloud.com', { profile: '1', generatorEnabled: true });
  const archived = await call('PATCH', `/parents/${parent.id}`, { archived: true });
  assert.equal(archived.body.archived, true);
  assert.equal(archived.body.generator.enabled, false);
  assert.deepEqual(dropped, [parent.id]);
  // Профиль отключённого родителя свободен, но вернуть его в работу при занятом профиле нельзя.
  const reuser = db.addParent('reuser@icloud.com');
  assert.equal((await call('PATCH', `/parents/${reuser.id}`, { profile: '1' })).status, 200);
  assert.equal((await call('PATCH', `/parents/${parent.id}`, { archived: false })).status, 409);
  db.updateParent(reuser.id, { profile: '' });
  assert.equal((await call('PATCH', `/parents/${parent.id}`, { generatorEnabled: true })).status, 409);
  assert.equal((await call('PATCH', `/parents/${parent.id}`, { archived: false, generatorEnabled: true })).body.generator.enabled, true);
  const typo = db.addParent('typo@icloud.com');
  assert.equal((await call('DELETE', `/parents/${typo.id}`)).status, 200);
  db.addAlias(parent.id, 'a@icloud.com', 'a');
  assert.equal((await call('DELETE', `/parents/${parent.id}`)).status, 409);
});

test('connecting a parent without a working Dolphin reports the error in its row', async t => {
  const { db, call } = await setup(t);
  const parent = db.addParent('owner@icloud.com', { profile: '123' });
  const noProfile = db.addParent('empty@icloud.com');
  const failed = await call('POST', `/parents/${parent.id}/connect`);
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /не подключён: Dolphin Anty не отвечает/);
  const row = (await call('GET', '/parents')).body.find((p: any) => p.id === parent.id);
  assert.equal(row.browser.state, 'error');
  assert.equal(row.browser.error, 'Dolphin Anty не отвечает');
  assert.equal((await call('POST', `/parents/${noProfile.id}/connect`)).status, 400);
});

test('IMAP password state comes from mail-code.json and the gRPC status file; passwords are never returned', async t => {
  const { db, call, mailCodeFile, root } = await setup(t, {
    grpc: { port: 50051 },
    imap: { accounts: [
      { email: 'Owner@icloud.com', password: 'abcd-efgh-ijkl-mnop', proxy: '' },
      { email: 'login-only@gmail.com', user: 'legacy@icloud.com', password: 'qrst-uvwx-yzab-cdef' },
      { email: 'keep@icloud.com', password: 'keep-keep-keep-keep' },
    ] },
  });
  const owner = db.addParent('owner@icloud.com');
  const legacy = db.addParent('legacy@icloud.com');
  const bare = db.addParent('bare@icloud.com');
  writeFileSync(path.join(root, 'imap-status.json'), JSON.stringify({ pid: process.pid, updatedAt: Date.now(), accounts: {
    'owner@icloud.com': { state: 'auth', error: 'вход не принят', at: Date.now() },
  } }));
  const rows = (await call('GET', '/parents')).body;
  const row = (id: number) => rows.find((p: any) => p.id === id);
  assert.deepEqual(row(owner.id).imap, { configured: true, proxy: '', state: 'auth', error: 'вход не принят' });
  assert.equal(row(legacy.id).imap.configured, true, 'ящик со входом по логину (user) относится к родителю');
  assert.equal(row(legacy.id).imap.state, 'unknown');
  assert.equal(row(bare.id).imap.state, 'none');
  assert.ok(!JSON.stringify(rows).includes('abcd-efgh'));

  assert.equal((await call('PUT', `/parents/${bare.id}/imap`, { password: ' ' })).status, 400);
  assert.equal((await call('PUT', `/parents/${bare.id}/imap`, { password: 'abcd-efgh-ijkl-mnop', proxy: 'ftp://x' })).status, 400);

  const removed = await call('DELETE', `/parents/${owner.id}/imap`);
  assert.equal(removed.body.imap.configured, false);
  const saved = JSON.parse(readFileSync(mailCodeFile, 'utf8'));
  assert.deepEqual(saved.imap.accounts.map((a: any) => a.email), ['login-only@gmail.com', 'keep@icloud.com']);
  assert.equal(saved.grpc.port, 50051, 'остальные настройки mail-code.json не трогаются');
});

test('with a cluster configured, mailbox state comes from the cluster service and a saved password is pushed at once', async t => {
  let state: ClusterState = {
    url: 'https://codes.example.com', ok: true, error: '', at: 1, pushedAt: 1,
    accounts: { 'owner@icloud.com': { state: 'connected', error: '', at: 1 } },
  };
  let pushes = 0;
  const { db, call, root } = await setup(t, {
    imap: { accounts: [
      { email: 'owner@icloud.com', password: 'abcd-efgh-ijkl-mnop' },
      { email: 'other@icloud.com', password: 'qrst-uvwx-yzab-cdef' },
    ] },
  }, { status: () => state, pushSoon: () => { pushes++; } });
  const owner = db.addParent('owner@icloud.com');
  const other = db.addParent('other@icloud.com');
  // Файл состояния от локального gRPC при настроенном кластере не учитывается.
  writeFileSync(path.join(root, 'imap-status.json'), JSON.stringify({ pid: process.pid, updatedAt: Date.now(), accounts: {
    'owner@icloud.com': { state: 'auth', error: 'локальный gRPC', at: Date.now() },
  } }));
  const row = async (id: number) => (await call('GET', '/parents')).body.find((p: any) => p.id === id);
  assert.equal((await row(owner.id)).imap.state, 'connected');
  assert.deepEqual((await row(other.id)).imap, { configured: true, proxy: '', state: 'unknown', error: '' });

  const health = (await call('GET', '/health')).body;
  assert.deepEqual(health.cluster, { url: 'https://codes.example.com', ok: true, error: '', at: 1, pushedAt: 1 });
  assert.ok(!JSON.stringify(health).includes('abcd-efgh'));

  state = { ...state, ok: false, error: 'сервис кодов в кластере недоступен: fetch failed', accounts: null };
  const offline = await row(owner.id);
  assert.equal(offline.imap.state, 'unknown');
  assert.match(offline.imap.error, /недоступен/);
  assert.equal((await call('GET', '/health')).body.cluster.ok, false);

  await call('DELETE', `/parents/${other.id}/imap`);
  assert.equal(pushes, 1, 'удалённый пароль сразу уходит в кластер');
});

test('without a cluster /health reports cluster: null', async t => {
  const { call } = await setup(t);
  assert.equal((await call('GET', '/health')).body.cluster, null);
});

test('/aliases pages with parent filter and search; without limit returns the plain list', async t => {
  const { db, call } = await setup(t);
  const first = db.addParent('first@icloud.com');
  const second = db.addParent('second@icloud.com');
  db.addAlias(first.id, 'a1@icloud.com', 'box1');
  db.addAlias(second.id, 'b1@icloud.com', 'other1');
  db.addAlias(second.id, 'b2@icloud.com', 'Box2');
  const plain = await call('GET', '/aliases');
  assert.equal(plain.body.length, 3);
  const page = await call('GET', `/aliases?limit=20&parent=${second.id}`);
  assert.equal(page.body.total, 2);
  assert.deepEqual(page.body.rows.map((r: any) => [r.email, r.parent]), [['b2@icloud.com', 'second@icloud.com'], ['b1@icloud.com', 'second@icloud.com']]);
  const search = await call('GET', '/aliases?limit=1&q=BOX');
  assert.equal(search.body.total, 2);
  assert.equal(search.body.rows.length, 1);
});

test('/mail/messages decides from the database before touching the browser and keeps its contract', async t => {
  const { db, call } = await setup(t);
  const imapParent = db.addParent('imap@icloud.com', { profile: '1' });
  db.addAlias(imapParent.id, 'covered@icloud.com', 'a1');
  const browserParent = db.addParent('browser@icloud.com');
  db.addAlias(browserParent.id, 'other@icloud.com', 'b1');
  const post = (body: object) => call('POST', '/mail/messages', body);

  assert.deepEqual(await post({ email: 'Covered@icloud.com', skipParents: ['IMAP@icloud.com'] }),
    { status: 200, body: { parent: 'imap@icloud.com', skipped: true, messages: [] } });
  const unknown = await post({ email: 'nobody@icloud.com' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.parent, undefined);
  const offline = await post({ email: 'other@icloud.com', skipParents: ['imap@icloud.com'] });
  assert.equal(offline.status, 503);
  assert.equal(offline.body.parent, 'browser@icloud.com');
  assert.match(offline.body.error, /не подключён/);
  assert.equal((await post({ email: 'bad' })).status, 400);
  const badRule = await post({ email: 'other@icloud.com', match: { subject: '(' } });
  assert.equal(badRule.status, 400);
  assert.match(badRule.body.error, /match.subject/);
});
