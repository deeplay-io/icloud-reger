import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './api';
import { DEFAULTS } from './config';
import { Db } from './db';

test('/mail/messages decides from the database before touching the browser', async t => {
  const db = new Db(':memory:');
  const imapParent = db.setActiveParent('imap@icloud.com', 750);
  db.addAlias(imapParent.id, 'covered@icloud.com', 'a1');
  const browserParent = db.setActiveParent('browser@icloud.com', 750);
  db.addAlias(browserParent.id, 'other@icloud.com', 'b1');
  db.setActiveParent('active@icloud.com', 750);
  const server = createApi(structuredClone(DEFAULTS), db).listen(0, '127.0.0.1');
  t.after(() => { server.close(); db.close(); });
  await new Promise(resolve => server.once('listening', resolve));
  const post = async (body: object) => {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mail/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  assert.deepEqual(await post({ email: 'Covered@icloud.com', skipParents: ['IMAP@icloud.com'] }),
    { status: 200, body: { parent: 'imap@icloud.com', skipped: true, messages: [] } });
  const unknown = await post({ email: 'nobody@icloud.com' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.parent, undefined);
  const inactive = await post({ email: 'other@icloud.com', skipParents: ['imap@icloud.com'] });
  assert.equal(inactive.status, 503);
  assert.equal(inactive.body.parent, 'browser@icloud.com');
  assert.match(inactive.body.error, /не подключён/);
  assert.equal((await post({ email: 'bad' })).status, 400);
});
