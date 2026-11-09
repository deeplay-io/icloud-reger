import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXAMPLE_PASSWORD, loadMailCodeConfig } from './mailCodeConfig';

test('the example starts without mailboxes; a placeholder password is still refused', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mail-code-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'mail-code.json');
  const example = JSON.parse(readFileSync(path.join(__dirname, '..', 'mail-code.example.json'), 'utf8'));

  writeFileSync(file, JSON.stringify(example));
  assert.deepEqual(loadMailCodeConfig(file).imap.accounts, []);

  example.imap.accounts = [{ email: 'PARENT@icloud.com', password: EXAMPLE_PASSWORD }];
  writeFileSync(file, JSON.stringify(example));
  assert.throws(() => loadMailCodeConfig(file), /пароль из примера/);

  example.imap.accounts = [{ email: 'Parent1@iCloud.com', password: 'abcd-efgh-ijkl-mnop' }];
  writeFileSync(file, JSON.stringify(example));
  assert.equal(loadMailCodeConfig(file).imap.accounts[0].email, 'parent1@icloud.com');
});

test('alias registry database: next to mail-code.json by default, CODES_DB from the window, explicit path wins', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mail-code-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'mail-code.json');
  writeFileSync(file, JSON.stringify({ imap: { accounts: [] } }));
  const saved = process.env.CODES_DB;
  t.after(() => { if (saved === undefined) delete process.env.CODES_DB; else process.env.CODES_DB = saved; });
  delete process.env.CODES_DB;
  assert.equal(loadMailCodeConfig(file).registry.dbFile, path.join(root, 'data', 'codes.db'));
  process.env.CODES_DB = path.join(root, 'elsewhere.db');
  assert.equal(loadMailCodeConfig(file).registry.dbFile, path.join(root, 'elsewhere.db'));
  writeFileSync(file, JSON.stringify({ registry: { dbFile: 'custom.db' } }));
  assert.equal(loadMailCodeConfig(file).registry.dbFile, path.join(root, 'custom.db'));
});
