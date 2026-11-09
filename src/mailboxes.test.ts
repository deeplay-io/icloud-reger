import test from 'node:test';
import assert from 'node:assert/strict';
import { messageRecipients, receivedAfter, Mailboxes, type Candidate } from './mailboxes';
import { merge } from './config';
import { MAIL_CODE_DEFAULTS, type ImapAccount } from './mailCodeConfig';

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

const accounts: ImapAccount[] = [
  { email: 'p1@icloud.com', password: 'a' },
  { email: 'p2@icloud.com', password: 'b' },
  { email: 'mail@gmail.com', user: 'p3@icloud.com', password: 'c' },
];

/** Ящики без сети: candidates и read подменены, searched — какие ящики искали. */
function fakeBoxes(owners: Record<string, string>, failing: string[] = [], list = accounts) {
  const cfg = merge(MAIL_CODE_DEFAULTS, { imap: { accounts: list } });
  const searched: string[] = [];
  const boxes = new Mailboxes(cfg, () => {}, { registry: { parentOf: alias => owners[alias] ?? null } });
  const stub = () => {
    for (const box of boxes.boxes) {
      box.candidates = async () => {
        searched.push(box.account.email);
        if (failing.includes(box.account.email)) throw new Error(`IMAP ${box.account.email}: нет сети`);
        return [];
      };
      box.read = async (_c: Candidate) => ({ from: '', subject: '', text: '' });
    }
  };
  stub();
  return { boxes, searched, stub };
}

test('a known alias is searched only in the mailbox of its parent (by email or by login)', async () => {
  const { boxes, searched } = fakeBoxes({ 'a@icloud.com': 'p2@icloud.com', 'c@icloud.com': 'p3@icloud.com' });
  assert.deepEqual(await boxes.find('a@icloud.com', 'CODE_KIND_SIGN_UP', 0), { status: 'none' });
  assert.deepEqual(searched, ['p2@icloud.com']);
  assert.deepEqual(boxes.healthyEmails('a@icloud.com'), ['p2@icloud.com']);
  searched.length = 0;
  await boxes.find('c@icloud.com', 'CODE_KIND_SIGN_UP', 0);
  assert.deepEqual(searched, ['mail@gmail.com']);
});

test('unknown alias, or a parent without its own mailbox in the list, is searched in every mailbox', async () => {
  const { boxes, searched } = fakeBoxes({ 'b@icloud.com': 'nobox@icloud.com' });
  await boxes.find('x@icloud.com', 'CODE_KIND_MFA', 0);
  assert.deepEqual(searched.sort(), ['mail@gmail.com', 'p1@icloud.com', 'p2@icloud.com']);
  searched.length = 0;
  await boxes.find('b@icloud.com', 'CODE_KIND_MFA', 0);
  assert.equal(searched.length, 3);
});

test('healthy mailboxes are kept per alias: a failing box seen by one call is not reported healthy to another', async () => {
  const { boxes } = fakeBoxes({ 'a@icloud.com': 'p1@icloud.com', 'b@icloud.com': 'p2@icloud.com' }, ['p2@icloud.com']);
  const results = await Promise.allSettled([
    boxes.find('a@icloud.com', 'CODE_KIND_SIGN_UP', 0),
    boxes.find('b@icloud.com', 'CODE_KIND_SIGN_UP', 0),
    boxes.find('unknown@icloud.com', 'CODE_KIND_SIGN_UP', 0),
  ]);
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(boxes.healthyEmails('a@icloud.com'), ['p1@icloud.com']);
  assert.deepEqual(boxes.healthyEmails('b@icloud.com'), []);
  assert.ok(!boxes.healthyEmails('unknown@icloud.com').includes('p2@icloud.com'));
});

test('reload adds, replaces and removes mailboxes without touching unchanged ones', async () => {
  const { boxes } = fakeBoxes({});
  const before = new Map(boxes.boxes.map(box => [box.account.email, box]));
  const result = boxes.reload([
    { email: 'p1@icloud.com', password: 'a' },
    { email: 'p2@icloud.com', password: 'changed' },
    { email: 'p4@icloud.com', password: 'd' },
  ]);
  assert.deepEqual(result, { added: ['p4@icloud.com'], changed: ['p2@icloud.com'], removed: ['mail@gmail.com'] });
  const after = new Map(boxes.boxes.map(box => [box.account.email, box]));
  assert.equal(after.get('p1@icloud.com'), before.get('p1@icloud.com'));
  assert.notEqual(after.get('p2@icloud.com'), before.get('p2@icloud.com'));
  assert.equal(after.get('p2@icloud.com')!.account.password, 'changed');
  assert.equal(boxes.size(), 3);
  assert.deepEqual(boxes.reload([]), { added: [], changed: [], removed: ['p1@icloud.com', 'p2@icloud.com', 'p4@icloud.com'] });
  await assert.rejects(boxes.find('a@icloud.com', 'CODE_KIND_SIGN_UP', 0), /не задан ни один IMAP-аккаунт/);
});
