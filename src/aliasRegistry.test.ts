import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Db } from './db';
import { AliasRegistry } from './aliasRegistry';

test('registry reads the parent of an alias while the main service holds the database open, and after it closed', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'icloud-registry-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'codes.db');
  const db = new Db(file);
  const parent = db.addParent('owner@icloud.com');
  db.addAlias(parent.id, 'alias@icloud.com', 'a');
  const registry = new AliasRegistry(file, () => {});
  try {
    assert.equal(registry.parentOf('Alias@iCloud.com'), 'owner@icloud.com');
    assert.equal(registry.parentOf('nobody@icloud.com'), null);
    // Алиас, добавленный основным сервисом после открытия реестра, виден сразу.
    db.addAlias(parent.id, 'later@icloud.com', 'b');
    assert.equal(registry.parentOf('later@icloud.com'), 'owner@icloud.com');
  } finally {
    registry.close();
    db.close();
  }
  const reopened = new AliasRegistry(file, () => {});
  try {
    assert.equal(reopened.parentOf('alias@icloud.com'), 'owner@icloud.com');
  } finally { reopened.close(); }
});

test('missing database means "search every mailbox": no crash, logged once, retried later', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'icloud-registry-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'data', 'codes.db');
  let now = 1000;
  const logs: string[] = [];
  const registry = new AliasRegistry(file, line => logs.push(line), () => now);
  assert.equal(registry.check(), false);
  assert.equal(registry.parentOf('alias@icloud.com'), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /во всех ящиках/);
  const db = new Db(file);
  const parent = db.addParent('owner@icloud.com');
  db.addAlias(parent.id, 'alias@icloud.com', 'a');
  assert.equal(registry.parentOf('alias@icloud.com'), null, 'до повторной попытки база не открывается');
  now += 30 * 1000;
  assert.equal(registry.parentOf('alias@icloud.com'), 'owner@icloud.com');
  registry.close();
  db.close();
});
