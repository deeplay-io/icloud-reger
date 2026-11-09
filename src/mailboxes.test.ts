import test from 'node:test';
import assert from 'node:assert/strict';
import { messageRecipients, receivedAfter } from './mailboxes';

test('INTERNALDATE has one-second precision', () => {
  const sentAfter = Date.UTC(2026, 10, 2, 12, 0, 0, 500);
  assert.ok(receivedAfter(Date.UTC(2026, 10, 2, 12, 0, 0), sentAfter));
  assert.ok(!receivedAfter(Date.UTC(2026, 10, 2, 11, 59, 59), sentAfter));
  assert.ok(receivedAfter(0, 0));
});

test('recipients come from To, Cc and delivery headers', () => {
  const recipients = messageRecipients({
    envelope: { to: [{ name: 'Hide My Email', address: 'Alias@iCloud.com' }], cc: [{ address: 'copy@icloud.com' }] },
    headers: Buffer.from('Delivered-To: hidden@icloud.com\r\nX-Original-To: parent@icloud.com\r\n'),
  });
  assert.deepEqual(recipients, ['alias@icloud.com', 'copy@icloud.com', 'hidden@icloud.com', 'parent@icloud.com']);
  assert.deepEqual(messageRecipients({}), []);
});
