import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { HealthImplementation } from 'grpc-health-check';
import type { MailCodeConfig } from './mailCodeConfig';
import { getCode, type FindCode, type GetCodeRequest, type GetCodeResponse } from './mailCode';

export const PROTO_FILE = path.join(__dirname, '..', 'proto', 'deeplay', 'mail_code', 'v1', 'mail_code.proto');
export const SERVICE_NAME = 'deeplay.mail_code.v1.MailCodeService';

// keepCase — имена полей как в .proto; int64 приходят числами (миллисекунды влезают в 2^53); энамы — по имени.
export function loadMailCodeProto(): protoLoader.PackageDefinition {
  return protoLoader.loadSync(PROTO_FILE, { keepCase: true, longs: Number, enums: String, defaults: true });
}

export function mailCodeClient(definition = loadMailCodeProto()): grpc.ServiceClientConstructor {
  return (grpc.loadPackageDefinition(definition) as any).deeplay.mail_code.v1.MailCodeService;
}

/** gRPC без TLS: MailCodeService + reflection (для grpcurl) + grpc.health.v1 (для проб k8s). */
export async function startGrpcServer(cfg: MailCodeConfig, find: FindCode, log: (msg: string) => void): Promise<{ server: grpc.Server; port: number }> {
  const definition = loadMailCodeProto();
  const server = new grpc.Server();
  server.addService(mailCodeClient(definition).service, {
    GetCode(call: grpc.ServerUnaryCall<GetCodeRequest, GetCodeResponse>, callback: grpc.sendUnaryData<GetCodeResponse>) {
      const controller = new AbortController();
      call.on('cancelled', () => controller.abort());
      const started = Date.now();
      const r = call.request;
      const tag = `GetCode session=${r.session_id || '-'} email=${r.email} kind=${r.kind} sent_after=${r.sent_after_unix_ms} wait=${r.wait_seconds}`;
      getCode(r, cfg, find, controller.signal).then(response => {
        const details = (response.subject ? ` «${response.subject}»` : '') + (response.error_message ? `: ${response.error_message}` : '');
        log(`${tag} → ${response.result} за ${Date.now() - started} мс${controller.signal.aborted ? ' (клиент отменил вызов)' : ''}${details}`);
        callback(null, response);
      }, error => {
        const details = error instanceof Error ? error.message : String(error);
        log(`${tag} → INTERNAL: ${details}`);
        callback({ code: grpc.status.INTERNAL, details });
      });
    },
  });
  new ReflectionService(definition).addToServer(server);
  new HealthImplementation({ '': 'SERVING', [SERVICE_NAME]: 'SERVING' }).addToServer(server);
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`${cfg.grpc.host}:${cfg.grpc.port}`, grpc.ServerCredentials.createInsecure(), (error, bound) => error ? reject(error) : resolve(bound));
  });
  return { server, port };
}
