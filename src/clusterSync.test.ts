import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from './config';
import { Db } from './db';
import { ClusterSync, buildSnapshot } from './clusterSync';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'icloud-cluster-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('cluster is off without url; with url it needs a token of the pod', t => {
  const file = path.join(tempDir(t), 'config.json');
  writeFileSync(file, JSON.stringify({}));
  assert.equal(loadConfig(file).cluster.url, '');
  writeFileSync(file, JSON.stringify({ cluster: { url: 'https://codes.example.com/' } }));
  assert.throws(() => loadConfig(file), /cluster\.token/);
  writeFileSync(file, JSON.stringify({ cluster: { url: 'codes.example.com', token: 'x'.repeat(20) } }));
  assert.throws(() => loadConfig(file), /cluster\.url/);
  writeFileSync(file, JSON.stringify({ cluster: { url: 'https://codes.example.com/', token: ` ${'x'.repeat(20)} ` } }));
  const cfg = loadConfig(file);
  assert.equal(cfg.cluster.url, 'https://codes.example.com');
  assert.equal(cfg.cluster.token, 'x'.repeat(20));
  assert.equal(cfg.cluster.intervalMs, 10000);
});

test('snapshot holds every alias with its parent, archived parents included, and passwords from mail-code.json', t => {
  const root = tempDir(t);
  const mailCodeFile = path.join(root, 'mail-code.json');
  writeFileSync(mailCodeFile, JSON.stringify({ imap: { accounts: [{ email: 'p1@icloud.com', password: 'pw1' }] } }));
  const db = new Db(':memory:');
  t.after(() => db.close());
  const p1 = db.addParent('p1@icloud.com');
  const p2 = db.addParent('p2@icloud.com');
  db.addAlias(p1.id, 'B@icloud.com', 'b');
  db.addAlias(p2.id, 'a@icloud.com', 'a');
  db.updateParent(p2.id, { archived: true });
  assert.deepEqual(buildSnapshot(db, mailCodeFile), {
    accounts: [{ email: 'p1@icloud.com', password: 'pw1' }],
    aliases: { 'a@icloud.com': 'p2@icloud.com', 'b@icloud.com': 'p1@icloud.com' },
  });
});

test('calls during a sync collapse into one more sync', async () => {
  const requests: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests.push(`${init.method} ${url}`);
    if (requests.length === 1) await gate;
    return new Response(JSON.stringify({ version: 'same', receivedAt: 1, accounts: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  const sync = new ClusterSync({ url: 'http://pod', token: 'x'.repeat(20), intervalMs: 60_000 }, () => ({ accounts: [], aliases: {} }), () => {}, fetchFn);
  const first = sync.tick();
  sync.pushSoon();
  sync.pushSoon();
  release();
  await first;
  await new Promise(resolve => setTimeout(resolve, 20));
  // Версии не совпали ('same' ≠ версия пустого снимка) — каждая сверка отправляет PUT после GET.
  assert.deepEqual(requests, ['GET http://pod/status', 'PUT http://pod/snapshot', 'GET http://pod/status', 'PUT http://pod/snapshot']);
});
