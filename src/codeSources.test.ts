import test from 'node:test';
import assert from 'node:assert/strict';
import type { FindResult } from './mailboxes';
import { BrowserMailError, type BrowserFindResult } from './browserMail';
import { combineSources, type BrowserSource, type ImapSource } from './codeSources';

const found: FindResult = { status: 'found', code: '048213', receivedAt: 1, subject: 'Verify' };

function imap(result: FindResult | Error, healthy: string[] = ['imap@icloud.com']): ImapSource {
  return {
    find: async () => { if (result instanceof Error) throw result; return result; },
    healthyEmails: () => healthy,
  };
}
function browser(result: BrowserFindResult | Error, calls: string[][] = []): BrowserSource {
  return { find: async (_e, _k, _s, skip) => { calls.push(skip); if (result instanceof Error) throw result; return result; } };
}

test('IMAP answer wins; the browser is asked only when IMAP found nothing, with the healthy boxes to skip', async () => {
  const calls: string[][] = [];
  assert.deepEqual(await combineSources(imap(found), browser({ status: 'none' }, calls))('a@icloud.com', 'CODE_KIND_SIGN_UP', 0), found);
  assert.equal(calls.length, 0);
  assert.deepEqual(await combineSources(imap({ status: 'none' }), browser(found, calls))('a@icloud.com', 'CODE_KIND_SIGN_UP', 0), found);
  assert.deepEqual(calls, [['imap@icloud.com']]);
  for (const status of ['skipped', 'later'] as const) {
    assert.deepEqual(await combineSources(imap({ status: 'none' }), browser({ status }))('a@icloud.com', 'CODE_KIND_SIGN_UP', 0), { status: 'none' });
  }
});

test('without IMAP accounts the browser is the only source', async () => {
  const calls: string[][] = [];
  assert.deepEqual(await combineSources(null, browser(found, calls))('a@icloud.com', 'CODE_KIND_MFA', 0), found);
  assert.deepEqual(calls, [[]]);
  await assert.rejects(combineSources(null, browser(new BrowserMailError('основной сервис недоступен')))('a@icloud.com', 'CODE_KIND_MFA', 0), /браузер: основной сервис недоступен/);
  await assert.rejects(combineSources(null, null)('a@icloud.com', 'CODE_KIND_MFA', 0), /browser.enabled/);
});

test('browser failure keeps NOT_FOUND of a healthy IMAP unless the alias belongs to a parent IMAP does not read', async () => {
  const lookup = (b: BrowserSource, i = imap({ status: 'none' })) => combineSources(i, b)('a@icloud.com', 'CODE_KIND_SIGN_UP', 0);
  assert.deepEqual(await lookup(browser(new BrowserMailError('основной сервис недоступен'))), { status: 'none' });
  await assert.rejects(lookup(browser(new BrowserMailError('Родитель не подключён', 'p@icloud.com'))), /браузер: Родитель не подключён/);
  await assert.rejects(lookup(browser(new BrowserMailError('основной сервис недоступен')), imap(new Error('вход не принят'))),
    /IMAP: вход не принят; браузер: основной сервис недоступен/);
  assert.deepEqual(await lookup(browser(found), imap(new Error('вход не принят'))), found);
});

test('IMAP without mailboxes yet (passwords are added later in the window) leaves the browser as the only source', async () => {
  const calls: string[][] = [];
  const empty: ImapSource = { find: async () => { throw new Error('must not search'); }, healthyEmails: () => [], size: () => 0 };
  assert.deepEqual(await combineSources(empty, browser(found, calls))('a@icloud.com', 'CODE_KIND_SIGN_UP', 0), found);
  assert.deepEqual(calls, [[]]);
  await assert.rejects(combineSources(empty, null)('a@icloud.com', 'CODE_KIND_SIGN_UP', 0), /browser.enabled/);
});

test('the browser skips the mailboxes found healthy for this very alias', async () => {
  const asked: string[] = [];
  const calls: string[][] = [];
  const source: ImapSource = { find: async () => ({ status: 'none' }), healthyEmails: email => { asked.push(email); return ['p@icloud.com']; } };
  await combineSources(source, browser({ status: 'none' }, calls))('a@icloud.com', 'CODE_KIND_SIGN_UP', 0);
  assert.deepEqual(asked, ['a@icloud.com']);
  assert.deepEqual(calls, [['p@icloud.com']]);
});
