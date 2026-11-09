import test from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { protoPath as healthProtoPath } from 'grpc-health-check';
import { merge } from './config';
import { MAIL_CODE_DEFAULTS } from './mailCodeConfig';
import type { FindCode } from './mailCode';
import { mailCodeClient, startGrpcServer } from './grpcServer';

const cfg = merge(MAIL_CODE_DEFAULTS, { grpc: { host: '127.0.0.1', port: 0, pollIntervalMs: 20 } });

test('GetCode over the wire: enums, int64 and cancellation', async t => {
  const calls: unknown[][] = [];
  const find: FindCode = async (email, kind, sentAfter) => {
    calls.push([email, kind, sentAfter]);
    return email === 'alias@icloud.com'
      ? { status: 'found', code: '048213', receivedAt: 1793620805123, subject: 'Verify your email' }
      : { status: 'none' };
  };
  const { server, port } = await startGrpcServer(cfg, find, () => {});
  t.after(() => server.forceShutdown());
  const Client = mailCodeClient();
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  t.after(() => client.close());
  const call = (request: object, deadlineMs = 5000) => new Promise<any>((resolve, reject) =>
    client.GetCode(request, { deadline: new Date(Date.now() + deadlineMs) }, (error: grpc.ServiceError | null, response: unknown) => error ? reject(error) : resolve(response)));

  assert.deepEqual(await call({ email: 'alias@icloud.com', kind: 'CODE_KIND_SIGN_UP', sent_after_unix_ms: 1793620800000, wait_seconds: 5 }), {
    result: 'GET_CODE_RESULT_SUCCESS', code: '048213', received_at_unix_ms: 1793620805123, subject: 'Verify your email', error_message: '',
  });
  assert.deepEqual(calls[0], ['alias@icloud.com', 'CODE_KIND_SIGN_UP', 1793620800000]);

  // Числовой энам (так шлют клиенты на других языках) и пропущенный kind.
  assert.equal((await call({ email: 'alias@icloud.com', kind: 2 })).result, 'GET_CODE_RESULT_SUCCESS');
  const missingKind = await call({ email: 'alias@icloud.com' });
  assert.equal(missingKind.result, 'GET_CODE_RESULT_FAIL');
  assert.match(missingKind.error_message, /kind/);

  // Дедлайн клиента: сервер перестаёт опрашивать ящики.
  await assert.rejects(call({ email: 'late@icloud.com', kind: 'CODE_KIND_MFA', wait_seconds: 60 }, 300),
    (error: grpc.ServiceError) => error.code === grpc.status.DEADLINE_EXCEEDED);
  await new Promise(resolve => setTimeout(resolve, 100));
  const polls = calls.length;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls.length, polls);
});

test('grpc.health.v1 reports SERVING', async t => {
  const { server, port } = await startGrpcServer(cfg, async () => ({ status: 'none' }), () => {});
  t.after(() => server.forceShutdown());
  const health = (grpc.loadPackageDefinition(protoLoader.loadSync(healthProtoPath, { enums: String })) as any).grpc.health.v1.Health;
  const client = new health(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  t.after(() => client.close());
  const response = await new Promise<any>((resolve, reject) =>
    client.Check({ service: 'deeplay.mail_code.v1.MailCodeService' }, (error: Error | null, r: unknown) => error ? reject(error) : resolve(r)));
  assert.equal(response.status, 'SERVING');
});
