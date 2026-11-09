import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Db, ALIAS_WINDOW_MS } from './db';
import { AliasGenerator, randomIntervalMs, rescheduleAfterPause } from './aliasGen';
import { DEFAULTS } from './config';
import { AliasRateLimitError } from './errors';

test('five requests in rolling hour, uncertain requests count, exact boundary unlocks', () => {
  const db = new Db(':memory:');
  try {
    const parent = db.addParent('owner@icloud.com', { generatorEnabled: true });
    const start = 100000000;
    for (let i = 0; i < 5; i++) db.reserveAliasCreation(parent.id, `alias${i}@icloud.com`, start + i * 60000);
    assert.throws(() => db.reserveAliasCreation(parent.id, 'sixth@icloud.com', start + 5 * 60000), AliasRateLimitError);
    assert.equal(db.creationAllowedAt(parent.id, start + 59 * 60000), start + ALIAS_WINDOW_MS);
    db.reserveAliasCreation(parent.id, 'boundary@icloud.com', start + ALIAS_WINDOW_MS);
    assert.equal(db.creationAttempts(parent.id, start + ALIAS_WINDOW_MS).length, 5);
  } finally { db.close(); }
});

test('rate limit is per parent: a busy parent does not block another one', () => {
  const db = new Db(':memory:');
  try {
    const first = db.addParent('first@icloud.com');
    const second = db.addParent('second@icloud.com');
    const start = 100000000;
    for (let i = 0; i < 5; i++) db.reserveAliasCreation(first.id, `a${i}@icloud.com`, start + i);
    assert.throws(() => db.reserveAliasCreation(first.id, 'a5@icloud.com', start + 10), AliasRateLimitError);
    db.reserveAliasCreation(second.id, 'b0@icloud.com', start + 10);
    assert.equal(db.creationAttempts(second.id, start + 10).length, 1);
  } finally { db.close(); }
});

test('archived parent cannot reserve a creation', () => {
  const db = new Db(':memory:');
  try {
    const parent = db.addParent('owner@icloud.com', { archived: true });
    assert.throws(() => db.reserveAliasCreation(parent.id, 'x@icloud.com', 100000000), /отключён/);
  } finally { db.close(); }
});

test('750 cap applies even with a larger configured limit and includes unconfirmed last creation', () => {
  const db = new Db(':memory:');
  try {
    const parent = db.addParent('owner@icloud.com', { aliasLimit: 2000, generatorEnabled: true });
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
    const parent = db.addParent('owner@icloud.com', { generatorEnabled: true });
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
    const parent = db.addParent('owner@icloud.com', { generatorEnabled: true });
    let now = 100000000;
    const times: number[] = [];
    let draws = 0;
    const generator = new AliasGenerator(cfg, db, () => {}, {
      now: () => now,
      random: () => (++draws % 10) / 10,
      create: async parentId => {
        const email = `auto${times.length}@icloud.com`;
        const name = db.nextAliasName(parentId, 'owner');
        const event = db.reserveAliasCreation(parentId, email, now);
        await Promise.resolve();
        db.addAlias(parentId, email, name);
        db.confirmAliasCreation(event, now);
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

test('a parent at 750 stops and reports once while another parent keeps its own schedule', async () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    const first = db.addParent('first@icloud.com', { aliasLimit: 1000, generatorEnabled: true });
    for (let i = 0; i < 750; i++) db.addAlias(first.id, `old${i}@icloud.com`, String(i));
    const second = db.addParent('second@icloud.com', { generatorEnabled: true });
    let creates = 0;
    const logs: string[] = [];
    const generator = new AliasGenerator(cfg, db, line => logs.push(line), { now: () => 100000000, create: async () => { creates++; throw new Error('must not create'); } });
    await generator.tick();
    await generator.tick();
    assert.equal(creates, 0);
    assert.equal(db.generatorNextRun(first.id), null);
    assert.equal(generator.state(db.parentById(first.id)!), 'full');
    assert.equal(logs.filter(line => line.includes('[first@icloud.com]') && line.includes('лимит 750')).length, 1);
    assert.ok(db.generatorNextRun(second.id)! > 100000000);
    assert.equal(generator.state(db.parentById(second.id)!), 'scheduled');
  } finally { db.close(); }
});

test('parents create in parallel: a slow creation at one parent does not hold back another', async () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    const now = 100000000;
    const slow = db.addParent('slow@icloud.com', { generatorEnabled: true });
    const fast = db.addParent('fast@icloud.com', { generatorEnabled: true });
    db.setGeneratorSchedule(slow.id, now - 1);
    db.setGeneratorSchedule(fast.id, now - 1);
    let release: () => void = () => {};
    const started: number[] = [];
    const generator = new AliasGenerator(cfg, db, () => {}, {
      now: () => now,
      create: async parentId => {
        started.push(parentId);
        if (parentId === slow.id) await new Promise<void>(resolve => { release = resolve; });
        return { email: `new${parentId}@icloud.com`, name: 'x', parent: '' };
      },
    });
    const first = generator.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...started].sort(), [slow.id, fast.id].sort());
    assert.equal(generator.state(db.parentById(slow.id)!), 'creating');
    // Пока у медленного идёт создание, повторный шаг его не трогает.
    await generator.tick();
    assert.equal(started.length, 2);
    release();
    await first;
    assert.equal(generator.lastAttempt(slow.id)?.ok, true);
    assert.equal(generator.lastAttempt(fast.id)?.message, `создан new${fast.id}@icloud.com`);
  } finally { db.close(); }
});

test('only parents with the switch on are scheduled; a due parent without a browser waits without spending the run', async () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    const now = 100000000;
    const off = db.addParent('off@icloud.com');
    const offline = db.addParent('offline@icloud.com', { generatorEnabled: true });
    const archived = db.addParent('archived@icloud.com', { generatorEnabled: true, archived: true });
    db.setGeneratorSchedule(offline.id, now - 1);
    let ready = false;
    let creates = 0;
    const generator = new AliasGenerator(cfg, db, () => {}, {
      now: () => now,
      ready: () => ready,
      create: async () => { creates++; return { email: 'n@icloud.com', name: 'n', parent: '' }; },
    });
    await generator.tick();
    assert.equal(creates, 0);
    assert.equal(db.generatorNextRun(off.id), null);
    assert.equal(db.generatorNextRun(archived.id), null);
    assert.equal(db.generatorNextRun(offline.id), now - 1);
    assert.equal(generator.state(db.parentById(offline.id)!), 'waiting-browser');
    assert.equal(generator.state(db.parentById(off.id)!), 'off');
    assert.equal(generator.state(db.parentById(archived.id)!), 'archived');
    ready = true;
    await generator.tick();
    assert.equal(creates, 1);
  } finally { db.close(); }
});

test('turning the switch on after a long pause does not create at once', () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    const parent = db.addParent('owner@icloud.com');
    const now = 100000000;
    db.setGeneratorSchedule(parent.id, now - 24 * ALIAS_WINDOW_MS);
    rescheduleAfterPause(cfg, db, parent.id, now, () => 0);
    assert.equal(db.generatorNextRun(parent.id), now + cfg.generator.minIntervalMinutes * 60000);
    // Будущее расписание не трогаем.
    rescheduleAfterPause(cfg, db, parent.id, now, () => 1);
    assert.equal(db.generatorNextRun(parent.id), now + cfg.generator.minIntervalMinutes * 60000);
  } finally { db.close(); }
});

test('first creation waits an hour when this database has no creation history for the parent', async () => {
  const db = new Db(':memory:');
  try {
    const cfg = structuredClone(DEFAULTS);
    const now = 100000000;
    const generator = new AliasGenerator(cfg, db, () => {}, { now: () => now, random: () => 0, create: async () => { throw new Error('must not create'); } });
    const fresh = db.addParent('fresh@icloud.com', { generatorEnabled: true });
    await generator.tick();
    assert.equal(db.generatorNextRun(fresh.id), now + ALIAS_WINDOW_MS);

    const known = db.addParent('known@icloud.com', { generatorEnabled: true });
    db.confirmAliasCreation(db.reserveAliasCreation(known.id, 'earlier@icloud.com', now - 2 * ALIAS_WINDOW_MS), now - 2 * ALIAS_WINDOW_MS);
    await generator.tick();
    assert.equal(db.generatorNextRun(known.id), now + cfg.generator.minIntervalMinutes * 60000);
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
    const parent = db.addParent('owner@icloud.com', { generatorEnabled: true });
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
    const parent = db.addParent('owner@icloud.com', { generatorEnabled: true });
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
    const parent = db.addParent('owner@icloud.com', { generatorEnabled: true });
    const now = 100000000;
    db.setGeneratorSchedule(parent.id, now - 800);
    let creates = 0;
    const generator = new AliasGenerator(cfg, db, () => {}, {
      now: () => now, random: () => 0.5,
      create: async () => {
        creates++;
        return { email: 'new@icloud.com', name: 'owner1', parent: parent.email };
      },
    });
    await generator.tick();
    assert.equal(creates, 1);
    assert.ok(db.generatorNextRun(parent.id)! > now);
  } finally { db.close(); }
});
