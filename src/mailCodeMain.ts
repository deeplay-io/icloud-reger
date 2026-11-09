// gRPC-сервис кодов из почты (для пилота регистрации): npm run grpc
import { unwatchFile, watchFile } from 'node:fs';
import path from 'node:path';
import { loadMailCodeConfig } from './mailCodeConfig';
import { Mailboxes } from './mailboxes';
import { AliasRegistry } from './aliasRegistry';
import { imapStatusPath } from './imapAccounts';
import { BrowserMail } from './browserMail';
import { combineSources } from './codeSources';
import { SERVICE_NAME, startGrpcServer } from './grpcServer';

async function main(): Promise<void> {
  const file = path.resolve(process.env.MAIL_CODE_CONFIG ?? 'mail-code.json');
  const cfg = loadMailCodeConfig(file);
  const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
  const registry = new AliasRegistry(cfg.registry.dbFile, log);
  const mailboxes = new Mailboxes(cfg, log, { registry, statusFile: imapStatusPath(file) });
  const browser = cfg.browser.enabled ? new BrowserMail(cfg) : null;
  const { server, port } = await startGrpcServer(cfg, combineSources(mailboxes, browser), log);
  log(`${SERVICE_NAME} запущен: ${cfg.grpc.host}:${port}, без TLS`);
  log(`IMAP, ящики родителей: ${cfg.imap.accounts.map(account => account.email).join(', ') || 'не заданы'}`);
  registry.check();
  log(browser
    ? `запасной путь через браузер: ${cfg.browser.apiUrl} (для родителей без IMAP; нужен запущенный сервис и подключённый профиль родителя)`
    : 'запасной путь через браузер выключен');
  const errors = await mailboxes.connectAll();
  for (const error of errors) log(error);
  if (cfg.imap.accounts.length && !errors.length) log('IMAP: все ящики подключены');

  // Пароли родителей меняются в окне (запись в mail-code.json): подхватываем без перезапуска и без обрыва вызовов.
  // watchFile опрашивает файл: на Windows он надёжнее fs.watch при записи через переименование.
  watchFile(file, { interval: 2000 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) return;
    let next;
    try { next = loadMailCodeConfig(file); } catch (error) {
      log(`mail-code.json изменён, но не применён (работают прежние ящики): ${error instanceof Error ? error.message : error}`);
      return;
    }
    const r = mailboxes.reload(next.imap.accounts);
    if (!r.added.length && !r.changed.length && !r.removed.length) return;
    const list = (emails: string[]) => emails.join(', ') || '—';
    log(`IMAP: ящики обновлены из mail-code.json — добавлены: ${list(r.added)}; изменены: ${list(r.changed)}; удалены: ${list(r.removed)}`);
    void mailboxes.connectAll([...r.added, ...r.changed]).then(failed => {
      for (const error of failed) log(error);
    });
  });

  const stop = (): void => {
    log('остановка');
    unwatchFile(file);
    // Ожидающие вызовы держат tryShutdown до wait_seconds, поэтому ждём не больше 5 секунд.
    setTimeout(() => process.exit(0), 5000).unref();
    server.tryShutdown(() => { registry.close(); void mailboxes.close().finally(() => process.exit(0)); });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
