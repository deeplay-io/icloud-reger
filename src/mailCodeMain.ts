// gRPC-сервис кодов из почты (для пилота регистрации): npm run grpc
import { loadMailCodeConfig } from './mailCodeConfig';
import { Mailboxes } from './mailboxes';
import { SERVICE_NAME, startGrpcServer } from './grpcServer';

async function main(): Promise<void> {
  const cfg = loadMailCodeConfig();
  const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
  const mailboxes = new Mailboxes(cfg, log);
  const { server, port } = await startGrpcServer(cfg, (email, kind, sentAfter) => mailboxes.find(email, kind, sentAfter), log);
  log(`${SERVICE_NAME} запущен: ${cfg.grpc.host}:${port}, без TLS`);
  log(`ящики родителей: ${cfg.imap.accounts.map(account => account.email).join(', ') || 'не заданы'}`);
  const errors = await mailboxes.connectAll();
  for (const error of errors) log(error);
  if (cfg.imap.accounts.length && !errors.length) log('IMAP: все ящики подключены');

  const stop = (): void => {
    log('остановка');
    // Ожидающие вызовы держат tryShutdown до wait_seconds, поэтому ждём не больше 5 секунд.
    setTimeout(() => process.exit(0), 5000).unref();
    server.tryShutdown(() => { void mailboxes.close().finally(() => process.exit(0)); });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
