import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Db, ALIAS_WINDOW_MS } from './db';
import { AliasGenerator, randomIntervalMs } from './aliasGen';
import { DEFAULTS } from './config';
import { AliasRateLimitError } from './errors';

test('five requests in rolling hour, uncertain requests count, exact boundary unlocks', () => {
  const db = new Db(':memory:');
  try {
    const parent = db.setActiveParent('owner@icloud.com', 750);
    const start = 100000000;
    for (let i = 0; i < 5; i++) db.reserveAliasCreation(parent.id, `alias${i}@icloud.com`, start + i * 60000);
    assert.throws(() => db.reserveAliasCreation(parent.id, 'sixth@icloud.com', start + 5 * 60000), AliasRateLimitError);
    assert.equal(db.creationAllowedAt(parent.id, start + 59 * 60000), start + ALIAS_WINDOW_MS);
    db.reserveAliasCreation(parent.id, 'boundary@icloud.com', start + ALIAS_WINDOW_MS);
    assert.equal(db.creationAttempts(parent.id, start + ALIAS_WINDOW_MS).length, 5);
  } finally { db.close(); }
});

test('750 cap applies even with a larger configured limit and includes unconfirmed last creation', () => {
  const db = new Db(':memory:');
  try {
    const parent = db.setActiveParent('owner@icloud.com', 2000);
    for (let i = 0; i < 749; i++) db.addAlias(parent.id, `old${i}@icloud.com`, String(i));
    const event = db.reserveAliasCreation(parent.id, 'last@icloud.com', 100000000);
    assert.throws(() => db.reserveAliasCreation(parent.id, 'over-cap@icloud.com', 100000001), /лимит/);
    db.addAlias(parent.id, 'last@icloud.com', 'last');
    db.confirmAliasCreation(event, 100000001);
    assert.equal(db.countAliases(parent.id), 750);
    assert.throws(() => db.reserveAliasCreation(parent.id, 'over-cap@icloud.com', 200000000), /лимит/);
  } finally { db.close(); }
});

test('schedule and rolling-hour budget survive database reopen', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'icloud-generator-test-'));
  const file = path.join(root, 'test.db');
  let db = new Db(file);
  try {
    const parent = db.setActiveParent('owner@icloud.com', 750);
    db.setGeneratorSchedule(parent.id, 100500000);
    for (let i = 0; i < 5; i++) db.reserveAliasCreation(parent.id, `pending${i}@icloud.com`, 100000000 + i);
    db.close();
    db = new Db(file);
    assert.equal(db.generatorNextRun(parent.id), 100500000);
    assert.equal(db.creationAllowedAt(parent.id, 100001000), 100000000 + ALIAS_WINDOW_MS);
    assert.throws(() => db.reserveAliasCreation(parent.id, 'extra@icloud.com', 100001000), AliasRateLimitError);
  } finally {
    db.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('random scheduler obeys rolling budget across many simulated hours and does not overlap', async () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    const parent = db.setActiveParent('owner@icloud.com', 750);
    let now = 100000000;
    const times: number[] = [];
    let draws = 0;
    const generator = new AliasGenerator(cfg, db, () => {}, {
      now: () => now,
      random: () => (++draws % 10) / 10,
      create: async (_cfg, currentDb, name) => {
        const email = `auto${times.length}@icloud.com`;
        const event = currentDb.reserveAliasCreation(parent.id, email, now);
        await Promise.resolve();
        currentDb.addAlias(parent.id, email, name);
        currentDb.confirmAliasCreation(event, now);
        times.push(now);
        return { email, name, parent: parent.email };
      },
    });
    await generator.tick();
    assert.equal(times.length, 0);
    for (let i = 0; i < 80; i++) {
      now = db.generatorNextRun(parent.id)!;
      await Promise.all([generator.tick(), generator.tick()]);
    }
    assert.ok(times.length > 50);
    for (const time of times) assert.ok(times.filter(other => other > time - ALIAS_WINDOW_MS && other <= time).length <= 5);
    assert.equal(new Set(times).size, times.length);
    generator.stop();
    now += ALIAS_WINDOW_MS;
    const before = times.length;
    await generator.tick();
    assert.equal(times.length, before);
  } finally { db.close(); }
});

test('generator stops at 750 and resumes independently for a newly selected parent', async () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    const first = db.setActiveParent('first@icloud.com', 1000);
    for (let i = 0; i < 750; i++) db.addAlias(first.id, `old${i}@icloud.com`, String(i));
    let creates = 0;
    const generator = new AliasGenerator(cfg, db, () => {}, { now: () => 100000000, create: async () => { creates++; throw new Error('must not create'); } });
    await generator.tick();
    assert.equal(creates, 0);
    assert.equal(db.generatorNextRun(first.id), null);
    const second = db.setActiveParent('second@icloud.com', 750);
    await generator.tick();
    assert.ok(db.generatorNextRun(second.id)! > 100000000);
  } finally { db.close(); }
});

test('random interval stays within configured bounds', () => {
  assert.equal(randomIntervalMs(8, 16, () => 0), 8 * 60000);
  assert.equal(randomIntervalMs(8, 16, () => 1), 16 * 60000);
  assert.equal(randomIntervalMs(8, 16, () => 0.5), 12 * 60000);
});

test('clock-hour counter resets at midnight independently of the rolling rate limit', () => {
  const db = new Db(':memory:');
  try {
    const parent = db.setActiveParent('owner@icloud.com', 750);
    const midnight = Date.UTC(2026, 9, 30, 17); // 00:00 in Novosibirsk.
    for (let i = 0; i < 5; i++) {
      const time = midnight - (5 - i) * 60000;
      const event = db.reserveAliasCreation(parent.id, `test${i}@icloud.com`, time);
      db.confirmAliasCreation(event, time + 1);
    }
    assert.equal(db.creationsThisHour(parent.id, midnight - 1), 5);
    assert.equal(db.creationsThisHour(parent.id, midnight), 0);
    assert.equal(db.creationAttempts(parent.id, midnight).length, 5);
    assert.throws(() => db.reserveAliasCreation(parent.id, 'new@icloud.com', midnight), AliasRateLimitError);
    const time = midnight + 55 * 60000;
    const event = db.reserveAliasCreation(parent.id, 'new@icloud.com', time);
    assert.equal(db.creationsThisHour(parent.id, time), 0);
    db.confirmAliasCreation(event, time);
    assert.equal(db.creationsThisHour(parent.id, time), 1);
    assert.equal(db.creationsThisHour(parent.id, midnight + ALIAS_WINDOW_MS), 0);
  } finally { db.close(); }
});

test('clock-hour counter attributes a late confirmation to the hour of the request', () => {
  const db = new Db(':memory:');
  try {
    const parent = db.setActiveParent('owner@icloud.com', 750);
    const hour = Date.UTC(2026, 9, 31, 16); // 23:00 in Novosibirsk.
    const late = db.reserveAliasCreation(parent.id, 'late@icloud.com', hour - 5 * 60000);
    for (let i = 0; i < 4; i++) {
      const time = hour + (10 + i * 12) * 60000;
      const event = db.reserveAliasCreation(parent.id, `test${i}@icloud.com`, time);
      db.confirmAliasCreation(event, time + 1000);
    }
    db.confirmAliasCreation(late, hour + 10 * 60000);
    assert.equal(db.creationsThisHour(parent.id, hour - 1), 1);
    assert.equal(db.creationsThisHour(parent.id, hour + 59 * 60000), 4);
  } finally { db.close(); }
});

test('overdue schedule runs when polling is slightly late instead of postponing forever', async () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    const parent = db.setActiveParent('owner@icloud.com', 750);
    const now = 100000000;
    db.setGeneratorSchedule(parent.id, now - 800);
    let creates = 0;
    const generator = new AliasGenerator(cfg, db, () => {}, {
      now: () => now, random: () => 0.5,
      create: async (_cfg, _db, name) => {
        creates++;
        return { email: 'new@icloud.com', name, parent: parent.email };
      },
    });
    await generator.tick();
    assert.equal(creates, 1);
    assert.ok(db.generatorNextRun(parent.id)! > now);
  } finally { db.close(); }
});
