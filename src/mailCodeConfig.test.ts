import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadMailCodeConfig } from './mailCodeConfig';

test('mail-code.example.json is refused until real passwords are set', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mail-code-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'mail-code.json');
  const example = JSON.parse(readFileSync(path.join(__dirname, '..', 'mail-code.example.json'), 'utf8'));

  writeFileSync(file, JSON.stringify(example));
  assert.throws(() => loadMailCodeConfig(file), /пароль из примера/);

  example.imap.accounts = [{ email: 'Parent1@iCloud.com', password: 'abcd-efgh-ijkl-mnop' }];
  writeFileSync(file, JSON.stringify(example));
  assert.equal(loadMailCodeConfig(file).imap.accounts[0].email, 'parent1@icloud.com');
});
