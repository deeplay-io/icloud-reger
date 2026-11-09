import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Db } from './db';
import { DEFAULTS, loadConfig } from './config';
import { initializeParents } from './parent';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'icloud-parent-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** База версии 0.2.x: один активный родитель, остальные «исчерпаны», без настроек у родителей. */
function legacyDatabase(file: string): void {
  const d = new Database(file);
  d.exec(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      alias_limit INTEGER NOT NULL DEFAULT 750, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      parent_id INTEGER NOT NULL REFERENCES parents(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO parents (email, status) VALUES ('parent@icloud.com', 'exhausted'), ('old@icloud.com', 'exhausted'), ('current@icloud.com', 'active');
    INSERT INTO aliases (email, name, parent_id) VALUES ('a1@icloud.com', 'old1', 2), ('a2@icloud.com', 'current1', 3);
  `);
  d.close();
}

test('upgrade from the single-parent schema keeps every parent and moves profile and auto-registration to the active one', t => {
  const file = path.join(tempDir(t), 'codes.db');
  legacyDatabase(file);
  const cfg = structuredClone(DEFAULTS);
  cfg.browser.dolphinProfileId = '902053376';
  cfg.generator.enabled = true;
  cfg.generator.namePrefix = 'mybox';
  const logs: string[] = [];
  let db = new Db(file);
  try {
    initializeParents(cfg, db, line => logs.push(line));
    const current = db.parentByEmail('current@icloud.com')!;
    assert.equal(current.profile, '902053376');
    assert.equal(current.generator_enabled, 1);
    assert.equal(current.name_prefix, 'mybox');
    assert.equal(current.archived, 0);
    const old = db.parentByEmail('old@icloud.com')!;
    assert.deepEqual([old.profile, old.generator_enabled, old.name_prefix, old.archived], ['', 0, '', 0]);
    assert.equal(db.countAliases(old.id), 1, 'алиасы прежних родителей остаются, их коды читаются');
    assert.equal(db.parentByEmail('parent@icloud.com')!.archived, 1, 'заглушка из примера без алиасов убирается из работы');
    assert.deepEqual(db.workingParents().map(p => p.email), ['old@icloud.com', 'current@icloud.com']);
    assert.ok(logs.some(line => line.includes('current@icloud.com') && line.includes('902053376')));
  } finally { db.close(); }

  // Повторный запуск ничего не переносит заново: настройки, изменённые в окне, сохраняются.
  db = new Db(file);
  try {
    const current = db.parentByEmail('current@icloud.com')!;
    db.updateParent(current.id, { generatorEnabled: false, profile: '111' });
    db.close();
    db = new Db(file);
    initializeParents(cfg, db);
    assert.equal(db.parentByEmail('current@icloud.com')!.generator_enabled, 0);
    assert.equal(db.parentByEmail('current@icloud.com')!.profile, '111');
  } finally { db.close(); }
});

test('without a Dolphin profile id the old CDP address becomes the profile of the active parent', t => {
  const file = path.join(tempDir(t), 'codes.db');
  legacyDatabase(file);
  const cfg = structuredClone(DEFAULTS);
  cfg.browser.cdpUrl = 'http://127.0.0.1:9333';
  const db = new Db(file);
  try {
    initializeParents(cfg, db);
    assert.equal(db.parentByEmail('current@icloud.com')!.profile, 'http://127.0.0.1:9333');
  } finally { db.close(); }
});

test('new database is filled from a real configured parent, never from the example placeholder', () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    cfg.parent.email = 'PARENT@icloud.com';
    initializeParents(cfg, db);
    assert.equal(db.listParents().length, 0);
    cfg.parent.email = 'Configured@icloud.com';
    cfg.browser.dolphinProfileId = '42';
    initializeParents(cfg, db);
    const parent = db.parentByEmail('configured@icloud.com')!;
    assert.equal(parent.profile, '42');
    initializeParents(cfg, db);
    assert.equal(db.listParents().length, 1);
  } finally { db.close(); }
});

test('config.json without parent.email is accepted: parents are managed in the window', t => {
  const file = path.join(tempDir(t), 'config.json');
  writeFileSync(file, JSON.stringify({ api: { port: 8790 } }));
  const cfg = loadConfig(file);
  assert.equal(cfg.parent.email, '');
  assert.equal(cfg.db.file, path.join(path.dirname(file), 'data', 'codes.db'));
});

test('a parent added by mistake can be deleted only while it has no aliases and no recent creations', () => {
  const db = new Db(':memory:');
  try {
    const typo = db.addParent('typo@icloud.com');
    const used = db.addParent('used@icloud.com');
    db.addAlias(used.id, 'x@icloud.com', 'x');
    const recent = db.addParent('recent@icloud.com');
    db.reserveAliasCreation(recent.id, 'pending@icloud.com', 100000000);
    assert.throws(() => db.addParent('TYPO@icloud.com'), /уже есть/);
    db.deleteParent(typo.id);
    assert.equal(db.parentById(typo.id), undefined);
    assert.throws(() => db.deleteParent(used.id), /отключить/);
    assert.throws(() => db.deleteParent(recent.id, 100000000 + 60000), /через час/);
  } finally { db.close(); }
});
