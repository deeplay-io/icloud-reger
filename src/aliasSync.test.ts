import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db';

test('alias import is idempotent and mirrors the active iCloud list of the parent', () => {
  const db = new Db(':memory:');
  try {
    const first = db.setActiveParent('first@icloud.com', 750);
    db.addAlias(first.id, 'existing@icloud.com', 'existing');
    db.addAlias(first.id, 'deleted@icloud.com', 'deleted');
    assert.deepEqual(db.importAliases(first.id, [
      { email: 'existing@icloud.com', name: 'existing' },
      { email: 'Imported@icloud.com', name: 'from site' },
    ]), { added: 1, removed: 1 });
    assert.deepEqual(db.importAliases(first.id, [
      { email: 'existing@icloud.com', name: 'existing' },
      { email: 'imported@icloud.com', name: 'from site' },
    ]), { added: 0, removed: 0 });
    assert.equal(db.findAlias('deleted@icloud.com'), undefined);
    assert.deepEqual([...db.aliasEmails(first.id)].sort(), ['existing@icloud.com', 'imported@icloud.com']);
  } finally { db.close(); }
});

test('an empty active list removes every local alias of that parent only', () => {
  const db = new Db(':memory:');
  try {
    const first = db.setActiveParent('first@icloud.com', 750);
    db.addAlias(first.id, 'old@icloud.com', 'old');
    const second = db.setActiveParent('second@icloud.com', 750);
    db.addAlias(second.id, 'a@icloud.com', 'a');
    db.addAlias(second.id, 'b@icloud.com', 'b');
    assert.deepEqual(db.importAliases(second.id, []), { added: 0, removed: 2 });
    assert.equal(db.countAliases(second.id), 0);
    assert.equal(db.findAlias('old@icloud.com')?.parent_id, first.id);
  } finally { db.close(); }
});

test('a rejected import neither adds nor removes aliases and never moves them between parents', () => {
  const db = new Db(':memory:');
  try {
    const first = db.setActiveParent('first@icloud.com', 750);
    db.addAlias(first.id, 'existing@icloud.com', 'existing');
    const second = db.setActiveParent('second@icloud.com', 750);
    db.addAlias(second.id, 'kept@icloud.com', 'kept');
    assert.throws(() => db.importAliases(first.id, [{ email: 'wrong@icloud.com', name: '' }]));
    assert.throws(() => db.importAliases(second.id, [
      { email: 'new@icloud.com', name: '' },
      { email: 'existing@icloud.com', name: '' },
    ]));
    assert.deepEqual([...db.aliasEmails(second.id)], ['kept@icloud.com']);
    assert.deepEqual([...db.aliasEmails(first.id)], ['existing@icloud.com']);
  } finally { db.close(); }
});
