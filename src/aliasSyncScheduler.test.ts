import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db';
import { AliasBusyError } from './errors';
import { AliasSyncScheduler, SYNC_EVERY_MS, SYNC_RETRY_MS } from './aliasSyncScheduler';

function setup(sync: (email: string) => Promise<void>, ready: (parentId: number) => boolean = () => true) {
  const db = new Db(':memory:');
  const logs: string[] = [];
  const calls: string[] = [];
  let now = 100000000;
  const scheduler = new AliasSyncScheduler(db, async parentId => {
    const email = db.parentById(parentId)!.email;
    calls.push(email);
    await sync(email);
    return { parent: email, found: 3, added: 3, removed: 0, total: 3 };
  }, line => logs.push(line), () => now, ready);
  return { db, logs, calls, scheduler, advance: (ms: number) => { now += ms; } };
}

test('every parent with a profile is loaded once, then rechecked every 6 hours; a new parent is loaded at once', async () => {
  const { db, logs, calls, scheduler, advance } = setup(async () => {});
  try {
    await scheduler.tick();
    assert.equal(calls.length, 0, 'без родителей загружать нечего');
    db.addParent('first@icloud.com', { profile: '1' });
    db.addParent('second@icloud.com', { profile: '2' });
    db.addParent('noprofile@icloud.com');
    db.addParent('archived@icloud.com', { profile: '3', archived: true });
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(calls.sort(), ['first@icloud.com', 'second@icloud.com']);
    assert.ok(logs.some(line => line.startsWith('[first@icloud.com] алиасы iCloud: найдено 3')));
    assert.equal(scheduler.status(db.parentByEmail('first@icloud.com')!.id).state, 'ok');
    advance(SYNC_EVERY_MS - 1);
    await scheduler.tick();
    assert.equal(calls.length, 2);
    db.addParent('third@icloud.com', { profile: '4' });
    await scheduler.tick();
    assert.equal(calls.length, 3);
    advance(1);
    await scheduler.tick();
    assert.equal(calls.length, 5);
  } finally { db.close(); }
});

test('a parent whose browser is not connected is skipped quietly and loaded right after it connects', async () => {
  const connected = new Set<number>();
  const { db, logs, calls, scheduler } = setup(async () => {}, id => connected.has(id));
  try {
    const parent = db.addParent('owner@icloud.com', { profile: '1' });
    await scheduler.tick();
    assert.equal(calls.length, 0);
    assert.equal(logs.length, 0);
    connected.add(parent.id);
    await scheduler.tick();
    assert.equal(calls.length, 1);
    scheduler.syncSoon(parent.id);
    await scheduler.tick();
    assert.equal(calls.length, 2, 'после переподключения загружает снова');
  } finally { db.close(); }
});

test('failed load is retried every 2 minutes and the same error is logged once', async () => {
  let fail = true;
  const { db, logs, calls, scheduler, advance } = setup(async () => { if (fail) throw new Error('браузер не подключён.'); });
  try {
    const parent = db.addParent('owner@icloud.com', { profile: '1' });
    await scheduler.tick();
    assert.equal(scheduler.status(parent.id).state, 'error');
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

test('alias creation in progress postpones the load quietly; a manual load reports busy', async () => {
  let busy = true;
  const { db, logs, calls, scheduler, advance } = setup(async () => { if (busy) throw new AliasBusyError(); });
  try {
    const parent = db.addParent('owner@icloud.com', { profile: '1' });
    await scheduler.tick();
    assert.equal(logs.length, 0);
    await assert.rejects(scheduler.runNow(parent.id), AliasBusyError);
    busy = false;
    advance(30 * 1000);
    await scheduler.tick();
    assert.equal(calls.length, 3);
    assert.match(logs[0], /найдено 3/);
  } finally { db.close(); }
});
