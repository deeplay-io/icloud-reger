import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db';
import { AliasBusyError } from './errors';
import { AliasSyncScheduler, SYNC_EVERY_MS, SYNC_RETRY_MS } from './aliasSyncScheduler';

function setup(sync: () => Promise<void>) {
  const db = new Db(':memory:');
  const logs: string[] = [];
  const calls: string[] = [];
  let now = 100000000;
  const scheduler = new AliasSyncScheduler(db, async () => {
    calls.push(db.activeParent()!.email);
    await sync();
    return { parent: db.activeParent()!.email, found: 3, added: 3, removed: 0, total: 3 };
  }, line => logs.push(line), () => now);
  return { db, logs, calls, scheduler, advance: (ms: number) => { now += ms; } };
}

test('fresh database is filled on start, then rechecked every 6 hours and right after a parent change', async () => {
  const { db, logs, calls, scheduler, advance } = setup(async () => {});
  try {
    await scheduler.tick();
    assert.equal(calls.length, 0, 'без родителя загружать нечего');
    db.setActiveParent('first@icloud.com', 750);
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(calls, ['first@icloud.com']);
    assert.match(logs[0], /first@icloud.com: найдено 3/);
    advance(SYNC_EVERY_MS - 1);
    await scheduler.tick();
    assert.equal(calls.length, 1);
    db.setActiveParent('second@icloud.com', 750);
    await scheduler.tick();
    assert.deepEqual(calls, ['first@icloud.com', 'second@icloud.com']);
    advance(SYNC_EVERY_MS);
    await scheduler.tick();
    assert.equal(calls.length, 3);
  } finally { db.close(); }
});

test('failed load is retried every 2 minutes and the same error is logged once', async () => {
  let fail = true;
  const { db, logs, calls, scheduler, advance } = setup(async () => { if (fail) throw new Error('браузер не подключён.'); });
  try {
    db.setActiveParent('owner@icloud.com', 750);
    await scheduler.tick();
    advance(SYNC_RETRY_MS - 1);
    await scheduler.tick();
    assert.equal(calls.length, 1);
    advance(1);
    await scheduler.tick();
    assert.equal(calls.length, 2);
    assert.equal(logs.filter(line => line.includes('браузер не подключён')).length, 1);
    fail = false;
    advance(SYNC_RETRY_MS);
    await scheduler.tick();
    assert.match(logs.at(-1)!, /найдено 3/);
  } finally { db.close(); }
});

test('alias creation in progress postpones the load quietly', async () => {
  let busy = true;
  const { db, logs, calls, scheduler, advance } = setup(async () => { if (busy) throw new AliasBusyError(); });
  try {
    db.setActiveParent('owner@icloud.com', 750);
    await scheduler.tick();
    assert.equal(logs.length, 0);
    busy = false;
    advance(30 * 1000);
    await scheduler.tick();
    assert.equal(calls.length, 2);
    assert.match(logs[0], /найдено 3/);
  } finally { db.close(); }
});
