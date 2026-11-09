import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Db } from './db';
import { DEFAULTS, saveParentEmail } from './config';
import { initializeParent } from './parent';
import { createApi } from './api';

test('startup preserves the selected parent and exhausted status', () => {
  const db = new Db(':memory:');
  try {
    const selected = db.setActiveParent('selected@icloud.com', 750);
    const cfg = structuredClone(DEFAULTS);
    cfg.parent.email = 'PARENT@icloud.com';
    initializeParent(cfg, db);
    assert.equal(db.activeParent()?.email, selected.email);
    assert.equal(db.listParents().length, 1);
    db.markExhausted(selected.id);
    initializeParent(cfg, db);
    assert.equal(db.activeParent(), undefined);
    assert.equal(db.parentById(selected.id)?.status, 'exhausted');
  } finally { db.close(); }
});

test('new database uses a real configured parent, never the example placeholder', () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    cfg.parent.email = 'PARENT@icloud.com';
    initializeParent(cfg, db);
    assert.equal(db.listParents().length, 0);
    cfg.parent.email = 'configured@icloud.com';
    initializeParent(cfg, db);
    assert.equal(db.activeParent()?.email, 'configured@icloud.com');
  } finally { db.close(); }
});

test('parent API saves email in config and database and survives database reopen', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'icloud-parent-test-'));
  const file = path.join(root, 'config.json');
  const dbFile = path.join(root, 'test.db');
  const cfg = structuredClone(DEFAULTS);
  writeFileSync(file, JSON.stringify({ ...cfg, browser: { ...cfg.browser, dolphinProfileId: '123' } }));
  const db = new Db(dbFile);
  const server = createApi(cfg, db, email => saveParentEmail(file, email)).listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/parent`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Selected@icloud.com' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { activeParent: string }).activeParent, 'selected@icloud.com');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.parent.email, 'selected@icloud.com');
    assert.equal(saved.browser.dolphinProfileId, '123');
    assert.equal(db.activeParent()?.email, 'selected@icloud.com');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
  try {
    const reopened = new Db(dbFile);
    try {
      cfg.parent.email = 'PARENT@icloud.com';
      initializeParent(cfg, reopened);
      assert.equal(reopened.activeParent()?.email, 'selected@icloud.com');
    } finally { reopened.close(); }
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
