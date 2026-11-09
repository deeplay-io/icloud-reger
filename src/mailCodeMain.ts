// gRPC-сервис кодов из почты (для пилота регистрации): npm run grpc
import { loadMailCodeConfig } from './mailCodeConfig';
import { Mailboxes } from './mailboxes';
import { BrowserMail } from './browserMail';
import { combineSources } from './codeSources';
import { SERVICE_NAME, startGrpcServer } from './grpcServer';

async function main(): Promise<void> {
  const cfg = loadMailCodeConfig();
  const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
  const mailboxes = new Mailboxes(cfg, log);
  const imap = cfg.imap.accounts.length ? mailboxes : null;
  const browser = cfg.browser.enabled ? new BrowserMail(cfg) : null;
  const { server, port } = await startGrpcServer(cfg, combineSources(imap, browser), log);
  log(`${SERVICE_NAME} запущен: ${cfg.grpc.host}:${port}, без TLS`);
  log(`IMAP, ящики родителей: ${cfg.imap.accounts.map(account => account.email).join(', ') || 'не заданы'}`);
  log(browser
    ? `запасной путь через браузер: ${cfg.browser.apiUrl} (для родителей без IMAP; нужен запущенный сервис и подключённый профиль Dolphin)`
    : 'запасной путь через браузер выключен');
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
