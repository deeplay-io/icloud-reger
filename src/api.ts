import express, { type Express, type Request, type Response } from 'express';
import type { Config } from './config';
import { type Db, ALIAS_HOURLY_LIMIT, ALIAS_MAXIMUM } from './db';
import { ApiError } from './errors';
import { readAliasMessages, readCode } from './codeReader';
import { isConnected } from './browser';
import { syncAliases } from './aliasSync';
import { createAlias } from './aliasCreate';
import { validAliasPrefix } from './aliasNames';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createApi(cfg: Config, db: Db, persistParent: (email: string) => void = () => {}, persistPrefix: (prefix: string) => void = () => {}): Express {
  const app = express();
  app.use(express.json());
  // CORS: локальный сервис, интерфейс ходит сюда с file:// / другого origin
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/health', (_req: Request, res: Response) => {
    const active = db.activeParent();
    const now = Date.now();
    res.json({
      ok: true,
      browser: isConnected() ? 'connected' : 'disconnected',
      activeParent: active?.email ?? null,
      aliases: db.countAllAliases(),
      generator: {
        enabled: cfg.generator.enabled,
        nextRunAt: active ? db.generatorNextRun(active.id) : null,
        attemptsLastHour: active ? db.creationAttempts(active.id, now).length : 0,
        createdThisHour: active ? db.creationsThisHour(active.id, now) : 0,
        currentHourStart: Math.floor(now / 3600000) * 3600000,
        currentHourEndsAt: (Math.floor(now / 3600000) + 1) * 3600000,
        allowedAt: active ? db.creationAllowedAt(active.id, now) : now,
        hourlyLimit: ALIAS_HOURLY_LIMIT,
        aliasLimit: active ? Math.min(ALIAS_MAXIMUM, active.alias_limit) : ALIAS_MAXIMUM,
        limitReached: !!active && db.aliasCapacityUsed(active.id) >= Math.min(ALIAS_MAXIMUM, active.alias_limit),
      },
    });
  });

  const codeHandler = async (req: Request, res: Response): Promise<void> => {
    const email = ((req.query.email as string) ?? req.body?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'параметр email обязателен, пример: ***@icloud.com' });
      return;
    }
    try {
      const r = await readCode(cfg, db, email);
      // Формат по ТЗ: почта:код
      res.status(200).type('text/plain').send(`${email}:${r.code}`);
    } catch (e) {
      if (e instanceof ApiError) {
        res.status(e.status).json({ error: e.message });
        return;
      }
      console.error('/code:', e);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  app.get('/code', codeHandler);
  app.post('/code', codeHandler);

  // Запасной путь gRPC-сервиса кодов: письма на алиас из iCloud Mail в браузере (см. readAliasMessages).
  app.post('/mail/messages', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'email обязателен' }); return; }
    const sentAfterMs = Math.max(0, Number(req.body?.sentAfterMs) || 0);
    const skipParents = Array.isArray(req.body?.skipParents) ? req.body.skipParents.map((p: unknown) => String(p).toLowerCase()) : [];
    try {
      res.json(await readAliasMessages(cfg, db, email, sentAfterMs, skipParents));
    } catch (e) {
      // parent: gRPC-сервис по нему понимает, что ящик этого алиаса действительно не прочитан.
      const alias = db.findAlias(email);
      const parent = alias ? db.parentById(alias.parent_id)?.email : undefined;
      res.status(e instanceof ApiError ? e.status : 500).json({ error: e instanceof Error ? e.message : String(e), parent });
    }
  });

  app.get('/aliases', (_req: Request, res: Response) => {
    res.json(db.listAliases());
  });

  const namingSettings = () => {
    const parent = db.activeParent();
    const namePrefix = cfg.generator.namePrefix || parent?.email.split('@')[0] || '';
    return { namePrefix, nextName: parent && namePrefix ? db.nextAliasName(parent.id, namePrefix) : null };
  };
  app.get('/generator/settings', (_req, res) => { res.json(namingSettings()); });
  app.post('/generator/settings', (req, res) => {
    const prefix = String(req.body?.namePrefix ?? '').trim();
    if (!validAliasPrefix(prefix)) { res.status(400).json({ error: 'Введите имя без номера и без @icloud.com: например mybox (1–60 букв, цифр, точек, дефисов или подчёркиваний).' }); return; }
    try {
      persistPrefix(prefix);
      cfg.generator.namePrefix = prefix;
      res.json(namingSettings());
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  let syncingAliases = false;
  app.post('/aliases/sync', async (_req: Request, res: Response) => {
    if (syncingAliases) { res.status(409).json({ error: 'Загрузка алиасов уже выполняется.' }); return; }
    syncingAliases = true;
    try {
      res.json(await syncAliases(cfg, db));
    } catch (e) {
      res.status(e instanceof ApiError ? e.status : 503).json({ error: e instanceof Error ? e.message : String(e) });
    } finally { syncingAliases = false; }
  });

  app.get('/parents', (_req: Request, res: Response) => {
    res.json(db.listParents().map((p) => ({ ...p, aliases: db.countAliases(p.id) })));
  });

  // Ротация родителя: открыли нового в браузере — сообщаем сервису.
  app.post('/parent', (req: Request, res: Response) => {
    const email = (String(req.body?.email ?? '')).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'email обязателен' });
      return;
    }
    try {
      persistParent(email);
    } catch (e) {
      res.status(500).json({ error: 'Не удалось сохранить родителя в config.json: ' + (e instanceof Error ? e.message : String(e)) });
      return;
    }
    const p = db.setActiveParent(email, cfg.parent.aliasLimit);
    cfg.parent.email = p.email;
    res.json({ activeParent: p.email, aliases: db.countAliases(p.id) });
  });

  app.post('/aliases/create', async (req: Request, res: Response) => {
    try {
      res.json(await createAlias(cfg, db, String(req.body?.name ?? '').trim()));
    } catch (e) {
      res.status(e instanceof ApiError ? e.status : 503).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Registering an existing address requires verification against iCloud.
  app.post('/aliases', async (req: Request, res: Response) => {
    const email = (String(req.body?.email ?? '')).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'email обязателен' });
      return;
    }
    const parent = db.activeParent();
    if (!parent) {
      res.status(503).json({ error: 'нет активного родителя' });
      return;
    }
    if (db.findAlias(email)) {
      res.status(409).json({ error: 'алиас уже в пуле' });
      return;
    }
    try {
      await syncAliases(cfg, db);
      const verified = db.findAlias(email);
      if (!verified || verified.parent_id !== parent.id) {
        res.status(400).json({ error: 'Адрес не найден в iCloud. Для нового алиаса используйте «Создать в iCloud»: Apple назначит адрес автоматически.' });
        return;
      }
      res.json({ email: verified.email, name: verified.name, parent: parent.email });
    } catch (e) {
      res.status(e instanceof ApiError ? e.status : 503).json({ error: e instanceof Error ? e.message : String(e) });
    }
    return;
  });

  return app;
}
