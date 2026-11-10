// gRPC-сервис кодов из почты (для пилота регистрации): npm run grpc
import { unwatchFile, watchFile } from 'node:fs';
import path from 'node:path';
import { loadMailCodeConfig } from './mailCodeConfig';
import { Mailboxes, type AliasOwner } from './mailboxes';
import { AliasRegistry } from './aliasRegistry';
import { imapStatusPath } from './imapAccounts';
import { BrowserMail } from './browserMail';
import { combineSources } from './codeSources';
import { SERVICE_NAME, startGrpcServer } from './grpcServer';
import { SnapshotReceiver, SnapshotRegistry, startSnapshotServer } from './snapshot';

async function main(): Promise<void> {
  const file = path.resolve(process.env.MAIL_CODE_CONFIG ?? 'mail-code.json');
  const cfg = loadMailCodeConfig(file);
  const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
  // В кластере ящики и родители алиасов приходят снимком от приложения на Windows, а не из файла и базы.
  const snapshotMode = cfg.snapshot.port > 0;
  const snapshotRegistry = snapshotMode ? new SnapshotRegistry() : null;
  const dbRegistry = snapshotMode ? null : new AliasRegistry(cfg.registry.dbFile, log);
  const registry: AliasOwner = snapshotRegistry ?? dbRegistry!;
  // imap-status.json — для окна на той же машине; в кластере состояние уходит приложению в ответе на снимок.
  const mailboxes = new Mailboxes(cfg, log, { registry, statusFile: snapshotMode ? undefined : imapStatusPath(file) });
  const receiver = snapshotRegistry ? new SnapshotReceiver({ mailboxes, registry: snapshotRegistry, log }) : null;
  const browser = cfg.browser.enabled ? new BrowserMail(cfg) : null;
  const noAccounts = receiver
    ? () => receiver.received
      ? 'в снимке от приложения на Windows нет ни одного IMAP-пароля: задайте пароли родителям в окне приложения'
      : 'приложение на Windows ещё не прислало IMAP-пароли родителей: проверьте cluster.url и cluster.token в его config.json'
    : undefined;
  const { server, port } = await startGrpcServer(cfg, combineSources(mailboxes, browser, noAccounts), log);
  log(`${SERVICE_NAME} запущен: ${cfg.grpc.host}:${port}, без TLS`);
  const snapshotServer = receiver ? await startSnapshotServer(cfg.snapshot, receiver, log) : null;
  if (snapshotServer) {
    log(`приём снимка от приложения: http://${cfg.snapshot.host}:${snapshotServer.port} (PUT /snapshot, GET /status) — ящики родителей появятся после первого снимка`);
  } else {
    log(`IMAP, ящики родителей: ${cfg.imap.accounts.map(account => account.email).join(', ') || 'не заданы'}`);
    dbRegistry?.check();
  }
  log(browser
    ? `запасной путь через браузер: ${cfg.browser.apiUrl} (для родителей без IMAP; нужен запущенный сервис и подключённый профиль родителя)`
    : 'запасной путь через браузер выключен');
  const errors = await mailboxes.connectAll();
  for (const error of errors) log(error);
  if (cfg.imap.accounts.length && !errors.length) log('IMAP: все ящики подключены');

  // Пароли родителей меняются в окне (запись в mail-code.json): подхватываем без перезапуска и без обрыва вызовов.
  // watchFile опрашивает файл: на Windows он надёжнее fs.watch при записи через переименование.
  // В кластере файл — ConfigMap без паролей: перечитывать его значило бы выйти из всех ящиков из снимка.
  if (!snapshotMode) {
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
  }

  const stop = (): void => {
    log('остановка');
    if (!snapshotMode) unwatchFile(file);
    snapshotServer?.server.close();
    // Ожидающие вызовы держат tryShutdown до wait_seconds, поэтому ждём не больше 5 секунд.
    setTimeout(() => process.exit(0), 5000).unref();
    server.tryShutdown(() => { dbRegistry?.close(); void mailboxes.close().finally(() => process.exit(0)); });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
