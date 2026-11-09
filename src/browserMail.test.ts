import test from 'node:test';
import assert from 'node:assert/strict';
import { merge } from './config';
import { MAIL_CODE_DEFAULTS } from './mailCodeConfig';
import { BrowserMail, BrowserMailError } from './browserMail';

const cfg = merge(MAIL_CODE_DEFAULTS, { browser: { apiUrl: 'http://127.0.0.1:8788', pollIntervalMs: 15000 } });

function fakeFetch(replies: { status?: number; body: unknown }[], requests: unknown[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const reply = replies.shift()!;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
}

test('browser messages are classified by the same kind rules as IMAP, newest first', async () => {
  const requests: unknown[] = [];
  const browser = new BrowserMail(cfg, fakeFetch([{ body: { parent: 'p@icloud.com', skipped: false, messages: [
    { from: 'GGPass', subject: 'Two-factor authentication', text: 'Your code: 111111', receivedAt: 1793620860000 },
    { from: 'GGPass', subject: 'Verify your email', text: 'Your code: 048213', receivedAt: 1793620800000 },
  ] } }], requests));
  assert.deepEqual(await browser.find('alias@icloud.com', 'CODE_KIND_SIGN_UP', 1793620790000, ['imap@icloud.com']),
    { status: 'found', code: '048213', receivedAt: 1793620800000, subject: 'Verify your email' });
  assert.deepEqual(requests[0], {
    email: 'alias@icloud.com', sentAfterMs: 1793620790000, skipParents: ['imap@icloud.com'],
    match: { subject: cfg.kinds.CODE_KIND_SIGN_UP.subject },
  });
});

test('one browser pass per alias per interval; skipped and busy do not count as a look', async () => {
  let now = 1000000;
  const requests: unknown[] = [];
  const browser = new BrowserMail(cfg, fakeFetch([
    { body: { parent: 'p@icloud.com', skipped: true, messages: [] } },
    { body: { parent: 'p@icloud.com', skipped: false, messages: [] } },
    { status: 409, body: { error: 'Операция с алиасами уже выполняется.' } },
  ], requests), () => now);
  assert.deepEqual(await browser.find('a@icloud.com', 'CODE_KIND_MFA', 0, []), { status: 'skipped' });
  assert.deepEqual(await browser.find('a@icloud.com', 'CODE_KIND_MFA', 0, []), { status: 'none' });
  now += 14999;
  assert.deepEqual(await browser.find('a@icloud.com', 'CODE_KIND_MFA', 0, []), { status: 'later' });
  assert.equal(requests.length, 2);
  now += 1;
  assert.deepEqual(await browser.find('a@icloud.com', 'CODE_KIND_MFA', 0, []), { status: 'later' });
  assert.equal(requests.length, 3);
});

test('errors carry the parent when the main service resolved the alias', async () => {
  const browser = new BrowserMail(cfg, fakeFetch([
    { status: 503, body: { error: 'Родитель алиаса p@icloud.com не подключён', parent: 'p@icloud.com' } },
  ]));
  await assert.rejects(browser.find('a@icloud.com', 'CODE_KIND_SIGN_UP', 0, []),
    (error: BrowserMailError) => error instanceof BrowserMailError && error.parent === 'p@icloud.com' && /не подключён/.test(error.message));
  const offline = new BrowserMail(cfg, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
  await assert.rejects(offline.find('a@icloud.com', 'CODE_KIND_SIGN_UP', 0, []), (error: BrowserMailError) => error.parent === '' && /недоступен/.test(error.message));
});

test('between passes the last failure is repeated instead of looking like "no mail yet"', async () => {
  let now = 1000000;
  const browser = new BrowserMail(cfg, fakeFetch([
    { status: 503, body: { error: 'Профиль родителя p@icloud.com не подключён', parent: 'p@icloud.com' } },
    { body: { parent: 'p@icloud.com', skipped: false, messages: [] } },
  ]), () => now);
  await assert.rejects(browser.find('a@icloud.com', 'CODE_KIND_SIGN_UP', 0, []), /не подключён/);
  now += 3000;
  await assert.rejects(browser.find('a@icloud.com', 'CODE_KIND_SIGN_UP', 0, []), (error: BrowserMailError) => error.parent === 'p@icloud.com');
  now += 15000;
  assert.deepEqual(await browser.find('a@icloud.com', 'CODE_KIND_SIGN_UP', 0, []), { status: 'none' });
  now += 3000;
  assert.deepEqual(await browser.find('a@icloud.com', 'CODE_KIND_SIGN_UP', 0, []), { status: 'later' });
});
