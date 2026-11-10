import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { merge } from './config';
import { MAIL_CODE_DEFAULTS, type ImapAccount } from './mailCodeConfig';
import { Mailboxes, type Candidate } from './mailboxes';
import type { ImapStatusEntry } from './imapAccounts';
import { parseSnapshot, SnapshotReceiver, SnapshotRegistry, startSnapshotServer, type Snapshot } from './snapshot';
import { ClusterSync, buildSnapshot } from './clusterSync';
import { combineSources } from './codeSources';

const TOKEN = 'test-token-0123456789';
const PASSWORD = 'abcd-efgh-ijkl-mnop';

/** Ящики без сети: что приходило в reload и какое состояние отдавать. */
function fakeMailboxes() {
  let current: ImapAccount[] = [];
  const reloads: ImapAccount[][] = [];
  const connected: string[][] = [];
  const state = { status: {} as Record<string, ImapStatusEntry> };
  const mailboxes = {
    reload(accounts: ImapAccount[]) {
      reloads.push(accounts);
      const before = current.map(a => a.email);
      current = accounts;
      const after = accounts.map(a => a.email);
      return { added: after.filter(e => !before.includes(e)), changed: [], removed: before.filter(e => !after.includes(e)) };
    },
    async connectAll(emails?: string[]) {
      connected.push(emails ?? []);
      return [];
    },
    statusSnapshot: () => ({ ...state.status }),
    size: () => current.length,
  };
  return { mailboxes, reloads, connected, state };
}

async function startPod(t: { after: (fn: () => void | Promise<void>) => void }, port = 0) {
  const fake = fakeMailboxes();
  const registry = new SnapshotRegistry();
  const logs: string[] = [];
  const log = (line: string) => { logs.push(line); };
  const receiver = new SnapshotReceiver({ mailboxes: fake.mailboxes, registry, log });
  const cfg = { ...MAIL_CODE_DEFAULTS.snapshot, host: '127.0.0.1', port, token: TOKEN, maxBytes: 64 * 1024 };
  const { server, port: bound } = await startSnapshotServer(cfg, receiver, log);
  const close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  t.after(close);
  return { ...fake, registry, receiver, logs, url: `http://127.0.0.1:${bound}`, port: bound, close };
}

const snapshot = (): Snapshot => ({
  accounts: [{ email: 'p1@icloud.com', password: PASSWORD }, { email: 'p2@icloud.com', password: 'qrst-uvwx-yzab-cdef', proxy: 'socks5://10.0.0.1:1080' }],
  aliases: { 'a1@icloud.com': 'p1@icloud.com', 'b1@icloud.com': 'p2@icloud.com' },
});

test('snapshot body is validated and normalized; errors never echo a password', () => {
  const parsed = parseSnapshot({
    version: 'v1',
    accounts: [{ email: ' P1@iCloud.com ', password: ` ${PASSWORD} `, user: '', proxy: '' }, { email: 'mail@gmail.com', user: 'p3@icloud.com', password: 'x' }],
    aliases: { 'A1@iCloud.com': 'P1@icloud.com' },
  });
  assert.deepEqual(parsed.snapshot.accounts, [{ email: 'p1@icloud.com', password: PASSWORD }, { email: 'mail@gmail.com', user: 'p3@icloud.com', password: 'x' }]);
  assert.deepEqual(parsed.snapshot.aliases, { 'a1@icloud.com': 'p1@icloud.com' });

  const bad = (body: unknown, re: RegExp) => assert.throws(() => parseSnapshot(body), (e: Error) => re.test(e.message) && !e.message.includes(PASSWORD));
  bad(null, /JSON-объект/);
  bad({ accounts: [], aliases: {} }, /version/);
  bad({ version: 'v', accounts: {}, aliases: {} }, /accounts: массив/);
  bad({ version: 'v', accounts: [{ email: 'p@icloud.com', password: '' }], aliases: {} }, /нет пароля/);
  bad({ version: 'v', accounts: [{ email: 'p@icloud.com', password: PASSWORD, proxy: 'ftp://x' }], aliases: {} }, /proxy/);
  bad({ version: 'v', accounts: [{ email: 'p@icloud.com', password: PASSWORD }, { email: 'P@icloud.com', password: PASSWORD }], aliases: {} }, /повторяется/);
  bad({ version: 'v', accounts: [{ email: 'nobody', password: PASSWORD }], aliases: {} }, /email/);
  bad({ version: 'v', accounts: [], aliases: [] }, /aliases/);
  bad({ version: 'v', accounts: [], aliases: { 'a@icloud.com': 5 } }, /два e-mail/);
});

test('snapshot server: token required, status before and after a snapshot, bad bodies refused', async t => {
  const pod = await startPod(t);
  const call = async (method: string, route: string, body?: unknown, token: string | null = TOKEN) => {
    const res = await fetch(pod.url + route, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  assert.deepEqual(await call('GET', '/healthz', undefined, null), { status: 200, body: { ok: true } });
  assert.equal((await call('GET', '/status', undefined, null)).status, 401);
  assert.equal((await call('GET', '/status', undefined, 'wrong-token-wrong-token')).status, 401);
  assert.equal((await call('PUT', '/snapshot', { version: 'v1', ...snapshot() }, 'wrong-token-wrong-token')).status, 401);
  assert.equal(pod.reloads.length, 0, 'без токена снимок не применяется');
  assert.equal((await call('GET', '/elsewhere')).status, 404);
  assert.equal((await call('POST', '/snapshot', {})).status, 405);

  const before = await call('GET', '/status');
  assert.deepEqual(before.body, { version: null, receivedAt: null, accounts: {} });

  assert.equal((await call('PUT', '/snapshot', '{not json')).status, 400);
  assert.equal((await call('PUT', '/snapshot', { version: 'v1', accounts: [{ email: 'p@icloud.com' }], aliases: {} })).status, 400);
  assert.equal((await call('PUT', '/snapshot', { version: 'v1', accounts: [], aliases: {}, pad: 'x'.repeat(70 * 1024) })).status, 413);
  assert.equal(pod.reloads.length, 0, 'неверный снимок не трогает ящики');

  pod.state.status = { 'p1@icloud.com': { state: 'connected', error: '', at: 1 } };
  const applied = await call('PUT', '/snapshot', { version: 'v1', ...snapshot() });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.version, 'v1');
  assert.deepEqual(applied.body.accounts, { 'p1@icloud.com': { state: 'connected', error: '', at: 1 } });
  assert.deepEqual(pod.reloads.at(-1)!.map(a => a.email), ['p1@icloud.com', 'p2@icloud.com']);
  assert.deepEqual(pod.connected.at(-1), ['p1@icloud.com', 'p2@icloud.com']);
  assert.equal(pod.registry.parentOf('B1@icloud.com'), 'p2@icloud.com');
  assert.equal(pod.registry.parentOf('unknown@icloud.com'), null);
  assert.equal((await call('GET', '/status')).body.version, 'v1');
  assert.ok(pod.logs.some(line => /снимок от приложения получен: ящиков 2, алиасов 2/.test(line)));
  assert.ok(!pod.logs.join('\n').includes(PASSWORD), 'пароли не попадают в лог');
});

test('in snapshot mode the pushed alias owner narrows the IMAP search to one mailbox', async () => {
  // Сеть не нужна: вход в ящики подменён, поиск писем тоже.
  const cfg = merge(MAIL_CODE_DEFAULTS, { imap: { host: '127.0.0.1', port: 1, accounts: [] } });
  const registry = new SnapshotRegistry();
  const mailboxes = new Mailboxes(cfg, () => {}, { registry });
  const connected: string[][] = [];
  mailboxes.connectAll = async emails => { connected.push(emails ?? []); return []; };
  const receiver = new SnapshotReceiver({ mailboxes, registry, log: () => {} });
  const find = combineSources(mailboxes, null, () => receiver.received ? 'нет паролей в снимке' : 'снимка ещё нет');
  await assert.rejects(find('a1@icloud.com', 'CODE_KIND_SIGN_UP', 0), /снимка ещё нет/);

  receiver.apply('v1', snapshot());
  const searched: string[] = [];
  for (const box of mailboxes.boxes) {
    box.candidates = async () => { searched.push(box.account.email); return [] as Candidate[]; };
  }
  assert.deepEqual(await find('a1@icloud.com', 'CODE_KIND_SIGN_UP', 0), { status: 'none' });
  assert.deepEqual(searched, ['p1@icloud.com']);
  assert.deepEqual(connected, [['p1@icloud.com', 'p2@icloud.com']], 'новые ящики подключаются сразу после снимка');

  receiver.apply('v1', snapshot());
  assert.equal(connected.length, 1, 'тот же снимок не переподключает ящики');
  receiver.apply('v2', { accounts: [], aliases: {} });
  await assert.rejects(find('a1@icloud.com', 'CODE_KIND_SIGN_UP', 0), /нет паролей в снимке/);
  await mailboxes.close();
});

test('the app pushes only when the pod lacks the current snapshot, also after a pod restart', async t => {
  const pod = await startPod(t);
  let current = snapshot();
  const logs: string[] = [];
  const sync = new ClusterSync({ url: pod.url, token: TOKEN, intervalMs: 60_000 }, () => current, line => { logs.push(line); });

  await sync.tick();
  assert.equal(pod.reloads.length, 1, 'первая сверка отправляет снимок');
  assert.equal(sync.status().ok, true);
  assert.ok(sync.status().pushedAt);
  pod.state.status = { 'p2@icloud.com': { state: 'auth', error: 'вход не принят', at: 2 } };

  await sync.tick();
  assert.equal(pod.reloads.length, 1, 'снимок не менялся — не отправляется');
  assert.deepEqual(sync.status().accounts, { 'p2@icloud.com': { state: 'auth', error: 'вход не принят', at: 2 } });

  current = { ...current, aliases: { ...current.aliases, 'c1@icloud.com': 'p1@icloud.com' } };
  await sync.tick();
  assert.equal(pod.reloads.length, 2, 'новый алиас — снимок отправлен снова');
  assert.equal(pod.registry.parentOf('c1@icloud.com'), 'p1@icloud.com');

  // Под перезапущен: снимка у него нет, приложение отправляет его на следующей сверке.
  await pod.close();
  const restarted = await startPod(t, pod.port);
  await sync.tick();
  assert.equal(restarted.reloads.length, 1);
  assert.equal(restarted.registry.parentOf('c1@icloud.com'), 'p1@icloud.com');
  assert.ok(logs.some(line => /снимка ещё не было/.test(line)));
  assert.ok(!logs.join('\n').includes(PASSWORD) && !logs.join('\n').includes(TOKEN));
});

test('the app never pushes a snapshot it could not read, and reports a wrong token without leaking it', async t => {
  const pod = await startPod(t);
  const root = mkdtempSync(path.join(tmpdir(), 'cluster-sync-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mailCodeFile = path.join(root, 'mail-code.json');
  const db = { aliasParents: () => [{ email: 'a1@icloud.com', parent: 'p1@icloud.com' }] };
  const logs: string[] = [];
  const sync = new ClusterSync({ url: pod.url, token: TOKEN, intervalMs: 60_000 }, () => buildSnapshot(db, mailCodeFile), line => { logs.push(line); });

  await sync.tick();
  assert.equal(pod.reloads.length, 0, 'нет mail-code.json — снимок не отправлен');
  assert.equal(sync.status().ok, false);
  assert.match(sync.status().error, /снимок не собран/);
  assert.deepEqual(sync.status().accounts, {}, 'состояние ящиков от пода всё равно обновляется');

  writeFileSync(mailCodeFile, JSON.stringify({ imap: { accounts: [{ email: 'P1@icloud.com', password: PASSWORD }] } }));
  await sync.tick();
  assert.equal(pod.reloads.length, 1);
  assert.deepEqual(pod.reloads[0], [{ email: 'p1@icloud.com', password: PASSWORD }]);
  assert.equal(sync.status().ok, true);

  writeFileSync(mailCodeFile, '{ "imap": { "accounts": [');
  await sync.tick();
  assert.equal(pod.reloads.length, 1, 'битый mail-code.json не превращается в пустой снимок');
  assert.equal(pod.receiver.status().version !== null, true);

  // Под отклонил снимок (кривой прокси вписан руками): тот же снимок не отправляется на каждой сверке.
  writeFileSync(mailCodeFile, JSON.stringify({ imap: { accounts: [{ email: 'p1@icloud.com', password: PASSWORD, proxy: 'ftp://x' }] } }));
  const refusals = () => pod.logs.filter(line => /снимок не принят \(400\)/.test(line)).length;
  await sync.tick();
  await sync.tick();
  assert.equal(refusals(), 1);
  assert.equal(sync.status().ok, false);
  assert.match(sync.status().error, /снимок отклонён.*proxy/);
  writeFileSync(mailCodeFile, JSON.stringify({ imap: { accounts: [{ email: 'p1@icloud.com', password: PASSWORD, proxy: 'socks5://10.0.0.1:1080' }] } }));
  await sync.tick();
  assert.equal(pod.reloads.length, 2, 'исправленный снимок уходит сразу');
  assert.equal(sync.status().ok, true);

  const wrong = new ClusterSync({ url: pod.url, token: 'another-token-0123456789', intervalMs: 60_000 }, () => snapshot(), line => { logs.push(line); });
  await wrong.tick();
  assert.equal(wrong.status().ok, false);
  assert.match(wrong.status().error, /HTTP 401/);
  assert.equal(wrong.status().accounts, null);
  assert.ok(!logs.join('\n').includes('another-token') && !logs.join('\n').includes(PASSWORD));

  const offline = new ClusterSync({ url: 'http://127.0.0.1:1', token: TOKEN, intervalMs: 60_000 }, () => snapshot(), () => {});
  await offline.tick();
  assert.equal(offline.status().ok, false);
  assert.match(offline.status().error, /недоступен/);
});
