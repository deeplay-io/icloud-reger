// Пробный вызов GetCode, как его делает пилот:
//   npm run grpc:call -- --email xyz@icloud.com --kind SIGN_UP --since-minutes 10 --wait 60
import { parseArgs } from 'node:util';
import * as grpc from '@grpc/grpc-js';
import { mailCodeClient } from './grpcServer';

const { values } = parseArgs({
  options: {
    addr: { type: 'string', default: '127.0.0.1:50051' },
    email: { type: 'string', default: '' },
    kind: { type: 'string', default: 'SIGN_UP' },
    'since-minutes': { type: 'string', default: '0' },
    wait: { type: 'string', default: '0' },
    session: { type: 'string', default: 'grpc-call' },
  },
});
const kind = values.kind!.toUpperCase();
const sinceMinutes = Number(values['since-minutes']);
const request = {
  email: values.email,
  kind: kind.startsWith('CODE_KIND_') ? kind : `CODE_KIND_${kind}`,
  sent_after_unix_ms: sinceMinutes > 0 ? Date.now() - sinceMinutes * 60000 : 0,
  wait_seconds: Number(values.wait),
  session_id: values.session,
};
const Client = mailCodeClient();
const client = new Client(values.addr!, grpc.credentials.createInsecure());
// Как у пилота: дедлайн вызова на несколько секунд больше wait_seconds.
const deadline = new Date(Date.now() + (request.wait_seconds + 5) * 1000);
console.log('запрос:', JSON.stringify(request));
client.GetCode(request, { deadline }, (error: grpc.ServiceError | null, response: unknown) => {
  client.close();
  if (error) {
    console.error(`gRPC ${grpc.status[error.code]}: ${error.details}`);
    process.exit(1);
  }
  console.log('ответ:', JSON.stringify(response, null, 2));
});
