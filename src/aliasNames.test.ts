import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAliasName, validAliasPrefix } from './aliasNames';
import { Db } from './db';

test('uses maximum numeric suffix, including legacy email-shaped labels, rather than count', () => {
  assert.equal(nextAliasName(['mybox1', 'mybox3', 'mybox2@icloud.com', 'mybox4', 'mybox5'], 'mybox'), 'mybox6');
  assert.equal(nextAliasName(['mybox1', 'mybox9', 'different100', 'mybox-test99'], 'mybox'), 'mybox10');
  assert.equal(nextAliasName([], 'mybox'), 'mybox1');
  assert.equal(nextAliasName(['foo.bar12', 'fooXbar99'], 'foo.bar'), 'foo.bar13');
  assert.equal(validAliasPrefix('mybox@icloud.com'), false);
});

test('sequence is isolated by parent and imported label corrections are reflected locally', () => {
  const db = new Db(':memory:');
  try {
    const first = db.setActiveParent('first@icloud.com', 750);
    db.addAlias(first.id, 'one@icloud.com', 'mybox5');
    const second = db.setActiveParent('second@icloud.com', 750);
    db.addAlias(second.id, 'two@icloud.com', 'mybox2@icloud.com');
    assert.equal(db.nextAliasName(first.id, 'mybox'), 'mybox6');
    assert.equal(db.nextAliasName(second.id, 'mybox'), 'mybox3');
    db.importAliases(second.id, [{ email: 'two@icloud.com', name: 'mybox2' }]);
    assert.equal(db.findAlias('two@icloud.com')?.name, 'mybox2');
  } finally { db.close(); }
});
