import test from 'node:test';
import assert from 'node:assert/strict';
import { merge } from './config';
import { MAIL_CODE_DEFAULTS } from './mailCodeConfig';
import type { FindResult } from './mailboxes';
import { getCode, type FindCode, type GetCodeRequest } from './mailCode';

const cfg = merge(MAIL_CODE_DEFAULTS, { grpc: { maxWaitSeconds: 1, pollIntervalMs: 20 } });
const request = (over: Partial<GetCodeRequest> = {}): GetCodeRequest => ({
  email: 'Alias@iCloud.com ',
  kind: 'CODE_KIND_SIGN_UP',
  sent_after_unix_ms: 1793620800000,
  wait_seconds: 1,
  session_id: 's1',
  ...over,
});
const found: FindResult = { status: 'found', code: '048213', receivedAt: 1793620805000, subject: 'Verify your email' };
const never = new AbortController().signal;

function sequence(...results: (FindResult | Error)[]): FindCode & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const find = async (...args: unknown[]) => {
    calls.push(args);
    const next = results[Math.min(calls.length, results.length) - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(find, { calls });
}

test('invalid requests fail without touching mailboxes', async () => {
  const find = sequence(found);
  assert.equal((await getCode(request({ email: '' }), cfg, find, never)).result, 'GET_CODE_RESULT_FAIL');
  assert.equal((await getCode(request({ kind: 'CODE_KIND_UNSPECIFIED' }), cfg, find, never)).result, 'GET_CODE_RESULT_FAIL');
  const foreign = await getCode(request({ email: 'user@gmail.com' }), cfg, find, never);
  assert.equal(foreign.result, 'GET_CODE_RESULT_UNKNOWN_MAILBOX');
  assert.match(foreign.error_message, /gmail\.com/);
  assert.equal(find.calls.length, 0);
});

test('returns the code with normalized email, kind and sent_after', async () => {
  const find = sequence(found);
  const response = await getCode(request(), cfg, find, never);
  assert.deepEqual(response, {
    result: 'GET_CODE_RESULT_SUCCESS', code: '048213', received_at_unix_ms: 1793620805000, subject: 'Verify your email', error_message: '',
  });
  assert.deepEqual(find.calls, [['alias@icloud.com', 'CODE_KIND_SIGN_UP', 1793620800000]]);
});

test('waits until the message arrives', async () => {
  const find = sequence({ status: 'none' }, { status: 'none' }, found);
  assert.equal((await getCode(request(), cfg, find, never)).code, '048213');
  assert.equal(find.calls.length, 3);
});

test('wait_seconds = 0 checks once; the wait is capped by maxWaitSeconds', async () => {
  const once = sequence({ status: 'none' });
  assert.equal((await getCode(request({ wait_seconds: 0 }), cfg, once, never)).result, 'GET_CODE_RESULT_NOT_FOUND');
  assert.equal(once.calls.length, 1);
  const started = Date.now();
  const capped = await getCode(request({ wait_seconds: 3600 }), cfg, sequence({ status: 'none' }), never);
  assert.equal(capped.result, 'GET_CODE_RESULT_NOT_FOUND');
  assert.ok(Date.now() - started >= 1000 && Date.now() - started < 2000);
});

test('transient mailbox errors are retried, persistent ones become FAIL', async () => {
  assert.equal((await getCode(request(), cfg, sequence(new Error('socket closed'), found), never)).result, 'GET_CODE_RESULT_SUCCESS');
  const failed = await getCode(request(), cfg, sequence(new Error('IMAP parent@icloud.com: вход не принят')), never);
  assert.equal(failed.result, 'GET_CODE_RESULT_FAIL');
  assert.match(failed.error_message, /вход не принят/);
});

test('newest message of the kind without a code is FAIL, not an older code', async () => {
  const find = sequence({ status: 'unparsed', receivedAt: 1793620805000, subject: 'New template' }, found);
  const response = await getCode(request(), cfg, find, never);
  assert.equal(response.result, 'GET_CODE_RESULT_FAIL');
  assert.match(response.error_message, /New template/);
  assert.equal(find.calls.length, 1);
});

test('stops waiting when the client cancels the call', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const response = await getCode(request(), merge(cfg, { grpc: { maxWaitSeconds: 60 } }), sequence({ status: 'none' }), controller.signal);
  assert.equal(response.result, 'GET_CODE_RESULT_NOT_FOUND');
  assert.ok(Date.now() - started < 500);
});
