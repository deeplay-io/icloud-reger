import { loadConfig, saveParentEmail, saveGeneratorPrefix } from './config';
import { initializeParent } from './parent';
import { Db } from './db';
import { createApi } from './api';
import { startAliasGenerator, type AliasGenerator } from './aliasGen';
import { syncAliases } from './aliasSync';

function main(): void {
  const configFile = process.env.CONFIG_FILE ?? 'config.json';
  const cfg = loadConfig(configFile);
  const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);
  const db = new Db(cfg.db.file);
  initializeParent(cfg, db);
  let generator: AliasGenerator | undefined;

  const app = createApi(cfg, db, email => saveParentEmail(configFile, email), prefix => saveGeneratorPrefix(configFile, prefix));
  const server = app.listen(cfg.api.port, cfg.api.host, () => {
    if (cfg.generator.enabled) generator = startAliasGenerator(cfg, db, log);
    log(`API запущен: http://${cfg.api.host}:${cfg.api.port}`);
    const active = db.activeParent();
    log(`активный родитель: ${active?.email ?? 'не выбран'} (лимит ${active?.alias_limit ?? cfg.parent.aliasLimit} алиасов)`);
    log(`CDP: ${cfg.browser.cdpUrl}`);
    if (active) {
      void syncAliases(cfg, db)
        .then(result => log(`Алиасы iCloud: найдено ${result.found}, добавлено ${result.added}, удалено ${result.removed}, в базе ${result.total}`))
        .catch(error => log(`Загрузка алиасов: ${error.message}`));
    }
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
    generator?.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
