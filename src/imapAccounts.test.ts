import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accountOf, imapStatusPath, readImapAccounts, readImapStatus, removeImapAccount, saveImapAccount } from './imapAccounts';

function temp(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'icloud-imap-accounts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'mail-code.json');
}

test('saving a password drops example placeholders, updates the matching entry and keeps everything else', t => {
  const file = temp(t);
  writeFileSync(file, JSON.stringify({
    grpc: { port: 50051 },
    imap: { host: 'imap.mail.me.com', accounts: [
      { email: 'PARENT@icloud.com', password: 'xxxx-xxxx-xxxx-xxxx' },
      { email: 'mail@gmail.com', user: 'legacy@icloud.com', password: 'old', proxy: 'socks5://p' },
      { email: 'other@icloud.com', password: 'keep' },
    ] },
  }));
  saveImapAccount(file, { email: 'Legacy@icloud.com', password: 'new-pass', proxy: '' });
  saveImapAccount(file, { email: 'fresh@icloud.com', password: 'fresh-pass', proxy: 'http://proxy:8080' });
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.grpc.port, 50051);
  assert.equal(raw.imap.host, 'imap.mail.me.com');
  assert.deepEqual(raw.imap.accounts, [
    { email: 'mail@gmail.com', user: 'legacy@icloud.com', password: 'new-pass', proxy: '' },
    { email: 'other@icloud.com', password: 'keep' },
    { email: 'fresh@icloud.com', password: 'fresh-pass', proxy: 'http://proxy:8080' },
  ]);
  const accounts = readImapAccounts(file);
  assert.equal(accountOf(accounts, 'legacy@icloud.com')?.email, 'mail@gmail.com');
  assert.equal(accountOf(accounts, 'fresh@icloud.com')?.proxy, 'http://proxy:8080');
  assert.ok(!JSON.stringify(accounts).includes('pass'));
  removeImapAccount(file, 'legacy@icloud.com');
  assert.deepEqual(readImapAccounts(file).map(a => a.email), ['other@icloud.com', 'fresh@icloud.com']);
});

test('a missing mail-code.json is created with only the account', t => {
  const file = temp(t);
  assert.deepEqual(readImapAccounts(file), []);
  saveImapAccount(file, { email: 'p@icloud.com', password: 'pw' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { imap: { accounts: [{ email: 'p@icloud.com', password: 'pw', proxy: '' }] } });
});

test('status of a stopped gRPC service is ignored', t => {
  const file = temp(t);
  const status = imapStatusPath(file);
  writeFileSync(status, JSON.stringify({ pid: process.pid, updatedAt: 1, accounts: { 'p@icloud.com': { state: 'connected', error: '', at: 1 } } }));
  assert.equal(readImapStatus(file)?.['p@icloud.com'].state, 'connected');
  writeFileSync(status, JSON.stringify({ pid: 2 ** 22 + 12345, updatedAt: 1, accounts: { 'p@icloud.com': { state: 'connected', error: '', at: 1 } } }));
  assert.equal(readImapStatus(file), null);
});
