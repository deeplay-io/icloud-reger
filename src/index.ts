import { loadConfig, saveParentEmail, saveGeneratorPrefix, saveGeneratorEnabled } from './config';
import { initializeParent } from './parent';
import { Db } from './db';
import { createApi } from './api';
import { startAliasGenerator, type AliasGenerator } from './aliasGen';
import { syncAliases } from './aliasSync';
import { AliasSyncScheduler } from './aliasSyncScheduler';

function main(): void {
  const configFile = process.env.CONFIG_FILE ?? 'config.json';
  const cfg = loadConfig(configFile);
  const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
  const db = new Db(cfg.db.file);
  initializeParent(cfg, db);
  let generator: AliasGenerator | undefined;
  const aliasSync = new AliasSyncScheduler(db, () => syncAliases(cfg, db), log);

  const app = createApi(cfg, db, email => saveParentEmail(configFile, email), prefix => saveGeneratorPrefix(configFile, prefix),
    enabled => saveGeneratorEnabled(configFile, enabled));
  const server = app.listen(cfg.api.port, cfg.api.host, () => {
    // Генератор работает всегда, а при generator.enabled = false просто ждёт: переключатель в окне действует без перезапуска.
    generator = startAliasGenerator(cfg, db, log);
    log(`авторегистрация: ${cfg.generator.enabled ? 'включена' : 'выключена'}`);
    log(`API запущен: http://${cfg.api.host}:${cfg.api.port}`);
    const active = db.activeParent();
    log(`активный родитель: ${active?.email ?? 'не выбран'} (лимит ${active?.alias_limit ?? cfg.parent.aliasLimit} алиасов)`);
    log(`CDP: ${cfg.browser.cdpUrl}`);
    aliasSync.start();
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
    aliasSync.stop();
    generator?.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
