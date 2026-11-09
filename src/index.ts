import path from 'node:path';
import { loadConfig } from './config';
import { initializeParents } from './parent';
import { Db } from './db';
import { createApi } from './api';
import { AliasGenerator } from './aliasGen';
import { syncAliases } from './aliasSync';
import { createAlias } from './aliasCreate';
import { AliasSyncScheduler } from './aliasSyncScheduler';
import { BrowserPool } from './browser';

function main(): void {
  const configFile = path.resolve(process.env.CONFIG_FILE ?? 'config.json');
  const cfg = loadConfig(configFile);
  // IMAP-пароли родителей для gRPC-сервиса: окно передаёт путь, без окна — рядом с config.json.
  const mailCodeFile = path.resolve(process.env.MAIL_CODE_CONFIG ?? path.join(path.dirname(configFile), 'mail-code.json'));
  const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
  const db = new Db(cfg.db.file);
  initializeParents(cfg, db, log);

  const pool = new BrowserPool(cfg.browser, () => db.workingParents(), log);
  const svc = { cfg, db, pool };
  const syncs = new AliasSyncScheduler(db, parentId => syncAliases(svc, parentId), log, Date.now, parentId => pool.isConnected(parentId));
  const generator = new AliasGenerator(cfg, db, log, {
    create: parentId => createAlias(svc, parentId, '', { sequential: true }),
    ready: parentId => pool.isConnected(parentId),
  });
  // Подключился профиль (в том числе после переподключения) — сверяем алиасы родителя с iCloud.
  pool.onConnected = parentId => {
    syncs.syncSoon(parentId);
    void syncs.tick();
  };

  const app = createApi({ ...svc, generator, syncs, mailCodeFile, log });
  const server = app.listen(cfg.api.port, cfg.api.host, () => {
    log(`API запущен: http://${cfg.api.host}:${cfg.api.port}`);
    const working = db.workingParents();
    if (!working.length) log('родители не добавлены: добавьте их во вкладке «Родители»');
    for (const parent of working) {
      log(`[${parent.email}] профиль ${parent.profile || 'не задан'}, авторегистрация ${parent.generator_enabled ? 'включена' : 'выключена'}, алиасов ${db.countAliases(parent.id)}`);
    }
    pool.start();
    syncs.start();
    generator.start();
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    log(error.code === 'EADDRINUSE'
      ? `Порт ${cfg.api.host}:${cfg.api.port} занят другим процессом. Остановите другую копию сервиса или измените api.port в config.json.`
      : `Не удалось запустить API: ${error.message}`);
    db.close();
    process.exit(1);
  });

  const stop = (): void => {
    log('остановка');
    generator.stop();
    syncs.stop();
    // Браузеры только отпускаются: профили Dolphin с залогиненными Apple ID остаются открытыми.
    pool.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
