import express, { type Express, type Request, type Response } from 'express';
import { type ParentRow, ALIAS_HOURLY_LIMIT, namePrefixOf } from './db';
import { ApiError } from './errors';
import { readAliasMessages, readCode } from './codeReader';
import { validProfile, type BrowserPool } from './browser';
import { syncAliases } from './aliasSync';
import { createAlias } from './aliasCreate';
import { aliasLimitOf, rescheduleAfterPause, type AliasGenerator } from './aliasGen';
import type { AliasSyncScheduler } from './aliasSyncScheduler';
import { validAliasPrefix } from './aliasNames';
import { accountOf, checkImapLogin, readImapAccounts, readImapStatus, removeImapAccount, saveImapAccount, ImapLoginError } from './imapAccounts';
import type { Services } from './services';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ApiContext extends Services {
  pool: Pick<BrowserPool, 'get' | 'connect' | 'status' | 'isConnected' | 'drop'>;
  generator: Pick<AliasGenerator, 'state' | 'lastAttempt'>;
  syncs: Pick<AliasSyncScheduler, 'status' | 'runNow' | 'syncSoon'>;
  /** mail-code.json: IMAP-пароли родителей для gRPC-сервиса. */
  mailCodeFile: string;
  log: (message: string) => void;
}

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

function fail(res: Response, e: unknown, fallback = 500): void {
  res.status(e instanceof ApiError ? e.status : fallback).json({ error: errorText(e) });
}

export function createApi(ctx: ApiContext): Express {
  const { cfg, db, pool, generator, syncs, mailCodeFile, log } = ctx;
  const app = express();
  app.use(express.json());
  // CORS: локальный сервис, интерфейс ходит сюда с file:// / другого origin
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  function parentView(parent: ParentRow, counts: Map<number, number>, accounts = readImapAccounts(mailCodeFile), imapStatus = readImapStatus(mailCodeFile)) {
    const now = Date.now();
    const limit = aliasLimitOf(parent);
    const prefix = namePrefixOf(parent);
    let nextName: string | null = null;
    try { nextName = db.nextAliasName(parent.id, prefix); } catch { /* в e-mail родителя символы, недопустимые в метке */ }
    const account = accountOf(accounts, parent.email);
    const status = account && imapStatus ? imapStatus[account.email] : undefined;
    return {
      id: parent.id,
      email: parent.email,
      archived: !!parent.archived,
      profile: parent.profile,
      browser: pool.status(parent.id),
      aliases: counts.get(parent.id) ?? 0,
      limit,
      full: db.aliasCapacityUsed(parent.id) >= limit,
      generator: {
        enabled: !!parent.generator_enabled,
        state: generator.state(parent),
        nextRunAt: db.generatorNextRun(parent.id),
        createdThisHour: db.creationsThisHour(parent.id, now),
        attemptsLastHour: db.creationAttempts(parent.id, now).length,
        allowedAt: db.creationAllowedAt(parent.id, now),
        hourlyLimit: ALIAS_HOURLY_LIMIT,
        namePrefix: prefix,
        customPrefix: parent.name_prefix,
        nextName,
        last: generator.lastAttempt(parent.id),
      },
      sync: syncs.status(parent.id),
      imap: {
        configured: !!account?.configured,
        proxy: account?.proxy ?? '',
        // unknown — пароль задан, но gRPC-сервис не запущен или ещё не входил в ящик.
        state: !account?.configured ? 'none' : status?.state ?? 'unknown',
        error: status?.error ?? '',
      },
    };
  }

  const viewOf = (parent: ParentRow) => parentView(parent, db.aliasCounts());

  function parentFrom(req: Request): ParentRow {
    const parent = db.parentById(Number(req.params.id));
    if (!parent) throw new ApiError(404, 'Родитель не найден.');
    return parent;
  }

  app.get('/health', (_req: Request, res: Response) => {
    const parents = db.listParents();
    const working = parents.filter(parent => !parent.archived);
    const withProfile = working.filter(parent => parent.profile);
    const connected = withProfile.filter(parent => pool.isConnected(parent.id)).length;
    const states = working.map(parent => ({ parent, state: generator.state(parent) }));
    const scheduled = states.filter(s => s.state === 'scheduled' || s.state === 'creating' || s.state === 'waiting-browser')
      .map(s => ({ parent: s.parent.email, at: db.generatorNextRun(s.parent.id) }))
      .filter((s): s is { parent: string; at: number } => s.at !== null)
      .sort((a, b) => a.at - b.at);
    res.json({
      ok: true,
      browser: !withProfile.length ? 'none' : connected === withProfile.length ? 'connected' : connected ? 'partial' : 'disconnected',
      parents: {
        total: parents.length,
        working: working.length,
        archived: parents.length - working.length,
        withProfile: withProfile.length,
        connected,
        registering: states.filter(s => s.parent.generator_enabled).length,
        full: states.filter(s => s.state === 'full').length,
      },
      aliases: db.countAllAliases(),
      generator: { next: scheduled[0] ?? null },
    });
  });

  app.get('/parents', (_req: Request, res: Response) => {
    const counts = db.aliasCounts();
    const accounts = readImapAccounts(mailCodeFile);
    const imapStatus = readImapStatus(mailCodeFile);
    res.json(db.listParents().map(parent => parentView(parent, counts, accounts, imapStatus)));
  });

  function readSettings(body: any, current?: ParentRow) {
    const settings: { profile?: string; namePrefix?: string; generatorEnabled?: boolean; archived?: boolean } = {};
    if (body?.profile !== undefined) {
      const profile = String(body.profile ?? '').trim();
      if (profile && !validProfile(profile)) throw new ApiError(400, 'Профиль: числовой ID профиля Dolphin Anty или адрес CDP вида http://127.0.0.1:9222.');
      settings.profile = profile;
    }
    if (body?.namePrefix !== undefined) {
      const prefix = String(body.namePrefix ?? '').trim();
      if (prefix && !validAliasPrefix(prefix)) throw new ApiError(400, 'Метка: имя без номера и без @icloud.com, например mybox (1–60 букв, цифр, точек, дефисов или подчёркиваний). Пусто — начало e-mail родителя.');
      settings.namePrefix = prefix;
    }
    for (const key of ['generatorEnabled', 'archived'] as const) {
      if (body?.[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') throw new ApiError(400, `${key}: true или false`);
      settings[key] = body[key];
    }
    if (current?.archived && settings.generatorEnabled && settings.archived !== false) throw new ApiError(409, 'Родитель отключён: сначала верните его в работу.');
    // Два родителя в одном профиле кликали бы по одной странице одновременно: блокировки у них разные.
    const profile = settings.profile ?? (settings.archived === false ? current?.profile : undefined);
    if (profile) {
      const other = db.workingParents().find(parent => parent.id !== current?.id && parent.profile === profile);
      if (other) throw new ApiError(409, `Профиль ${profile} уже у родителя ${other.email}: у каждого родителя свой профиль Dolphin.`);
    }
    return settings;
  }

  app.post('/parents', (req: Request, res: Response) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Укажите e-mail родительской iCloud-учётки.');
      const existing = db.parentByEmail(email);
      if (existing) throw new ApiError(409, existing.archived ? `Родитель ${email} уже есть среди отключённых: верните его в работу.` : `Родитель ${email} уже есть в списке.`);
      const settings = readSettings(req.body);
      // Авторегистрация у нового родителя включается отдельно, когда профиль подключён и алиасы загружены.
      const parent = db.addParent(email, { ...settings, generatorEnabled: false, archived: false });
      log(`[${parent.email}] родитель добавлен${parent.profile ? `, профиль ${parent.profile}` : ''}`);
      res.json(viewOf(parent));
    } catch (e) { fail(res, e); }
  });

  app.patch('/parents/:id', (req: Request, res: Response) => {
    try {
      const before = parentFrom(req);
      const settings = readSettings(req.body, before);
      const parent = db.updateParent(before.id, settings);
      if (settings.profile !== undefined && settings.profile !== before.profile) {
        pool.drop(parent.id);
        syncs.syncSoon(parent.id);
        log(`[${parent.email}] профиль: ${parent.profile || 'не задан'}`);
      }
      if (settings.generatorEnabled !== undefined && settings.generatorEnabled !== !!before.generator_enabled) {
        if (settings.generatorEnabled) rescheduleAfterPause(cfg, db, parent.id);
        log(`[${parent.email}] авторегистрация ${settings.generatorEnabled ? 'включена' : 'выключена'}`);
      }
      if (settings.namePrefix !== undefined && settings.namePrefix !== before.name_prefix) log(`[${parent.email}] метка авторегистрации: ${namePrefixOf(parent)}`);
      if (settings.archived !== undefined && settings.archived !== !!before.archived) {
        if (settings.archived) {
          db.updateParent(parent.id, { generatorEnabled: false });
          pool.drop(parent.id);
        } else syncs.syncSoon(parent.id);
        log(`[${parent.email}] ${settings.archived ? 'отключён: профиль больше не подключается, алиасы не загружаются и не создаются' : 'возвращён в работу'}`);
      }
      res.json(viewOf(db.parentById(parent.id)!));
    } catch (e) { fail(res, e); }
  });

  // Удалить можно только родителя без алиасов — например, добавленного по ошибке.
  app.delete('/parents/:id', (req: Request, res: Response) => {
    try {
      const parent = parentFrom(req);
      db.deleteParent(parent.id);
      pool.drop(parent.id);
      log(`[${parent.email}] родитель удалён`);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.post('/parents/:id/connect', async (req: Request, res: Response) => {
    try {
      const parent = parentFrom(req);
      res.json({ browser: await pool.connect(parent, req.body?.restart === true) });
    } catch (e) { fail(res, e, 503); }
  });

  app.post('/parents/:id/sync', async (req: Request, res: Response) => {
    try {
      const parent = parentFrom(req);
      res.json(await syncs.runNow(parent.id));
    } catch (e) { fail(res, e, 503); }
  });

  app.post('/parents/:id/aliases', async (req: Request, res: Response) => {
    try {
      const parent = parentFrom(req);
      res.json(await createAlias(ctx, parent.id, String(req.body?.name ?? '').trim()));
    } catch (e) { fail(res, e, 503); }
  });

  // IMAP-пароль родителя для gRPC-сервиса: проверяется одним входом и записывается в mail-code.json.
  app.put('/parents/:id/imap', async (req: Request, res: Response) => {
    try {
      const parent = parentFrom(req);
      const password = String(req.body?.password ?? '').trim();
      const proxy = String(req.body?.proxy ?? '').trim();
      if (!password) throw new ApiError(400, 'Введите app-specific пароль (account.apple.com → Вход и безопасность → Пароли приложений).');
      if (proxy && !/^(socks[45]?|https?):\/\/\S+$/i.test(proxy)) throw new ApiError(400, 'Прокси: socks5://… или http://…; пусто — напрямую.');
      const existing = accountOf(readImapAccounts(mailCodeFile), parent.email);
      try {
        await checkImapLogin(mailCodeFile, { email: parent.email, user: existing?.user || undefined, password, proxy });
      } catch (error) {
        const authFailed = error instanceof ImapLoginError && error.authFailed;
        throw new ApiError(authFailed ? 400 : 502, (authFailed
          ? 'Apple не принял пароль: нужен app-specific пароль этого Apple ID, а не обычный. '
          : 'Не удалось проверить вход (сеть или прокси), пароль не сохранён. ') + errorText(error));
      }
      saveImapAccount(mailCodeFile, { email: parent.email, password, proxy });
      log(`[${parent.email}] IMAP: пароль проверен и сохранён в mail-code.json${proxy ? ' (через прокси)' : ''}`);
      res.json(viewOf(parent));
    } catch (e) { fail(res, e); }
  });

  app.delete('/parents/:id/imap', (req: Request, res: Response) => {
    try {
      const parent = parentFrom(req);
      removeImapAccount(mailCodeFile, parent.email);
      log(`[${parent.email}] IMAP: пароль удалён из mail-code.json, коды этого родителя — только через браузер`);
      res.json(viewOf(parent));
    } catch (e) { fail(res, e); }
  });

  const codeHandler = async (req: Request, res: Response): Promise<void> => {
    const email = ((req.query.email as string) ?? req.body?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'параметр email обязателен, пример: ***@icloud.com' });
      return;
    }
    try {
      const r = await readCode(ctx, email);
      if ((req.query.format ?? req.body?.format) === 'json') {
        res.json({ email, code: r.code, parent: r.parent, subject: r.subject ?? '' });
        return;
      }
      // Формат по ТЗ: почта:код
      res.status(200).type('text/plain').send(`${email}:${r.code}`);
    } catch (e) {
      if (!(e instanceof ApiError)) console.error('/code:', e);
      fail(res, e);
    }
  };
  app.get('/code', codeHandler);
  app.post('/code', codeHandler);

  // Запасной путь gRPC-сервиса кодов: письма на алиас из iCloud Mail в профиле его родителя (см. readAliasMessages).
  app.post('/mail/messages', async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'email обязателен' }); return; }
    const sentAfterMs = Math.max(0, Number(req.body?.sentAfterMs) || 0);
    const skipParents = Array.isArray(req.body?.skipParents) ? req.body.skipParents.map((p: unknown) => String(p).toLowerCase()) : [];
    let match: { from?: string; subject?: string; mustContain?: string } | undefined;
    if (req.body?.match && typeof req.body.match === 'object') {
      match = {};
      for (const key of ['from', 'subject', 'mustContain'] as const) {
        const pattern = req.body.match[key];
        if (!pattern) continue;
        try { new RegExp(String(pattern), 'i'); } catch (e) { res.status(400).json({ error: `match.${key}: ${errorText(e)}` }); return; }
        match[key] = String(pattern);
      }
    }
    try {
      res.json(await readAliasMessages(ctx, email, sentAfterMs, skipParents, match));
    } catch (e) {
      // parent: gRPC-сервис по нему понимает, что ящик этого алиаса действительно не прочитан.
      const alias = db.findAlias(email);
      const parent = alias ? db.parentById(alias.parent_id)?.email : undefined;
      res.status(e instanceof ApiError ? e.status : 500).json({ error: errorText(e), parent });
    }
  });

  // Без limit — весь список массивом (как раньше); с limit — страница { total, rows } для окна.
  app.get('/aliases', (req: Request, res: Response) => {
    const parentId = Number(req.query.parent) || undefined;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const limit = Math.min(500, Number(req.query.limit) || 0) || undefined;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const result = db.listAliases({ parentId, q, limit, offset });
    res.json(limit ? result : result.rows);
  });

  // Добавить уже существующий адрес можно только подтвердив его по списку iCloud родителя.
  app.post('/aliases', async (req: Request, res: Response) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new ApiError(400, 'email обязателен');
      if (db.findAlias(email)) throw new ApiError(409, 'алиас уже в пуле');
      const parentEmail = String(req.body?.parent ?? '').trim().toLowerCase();
      const working = db.workingParents();
      const parent = parentEmail ? db.parentByEmail(parentEmail) : working.length === 1 ? working[0] : undefined;
      if (!parent) throw new ApiError(400, 'Укажите parent — e-mail родителя, в списке «Скрыть e-mail» которого есть этот адрес.');
      await syncAliases(ctx, parent.id);
      const verified = db.findAlias(email);
      if (!verified || verified.parent_id !== parent.id) {
        throw new ApiError(400, 'Адрес не найден в iCloud этого родителя. Для нового алиаса используйте «Создать в iCloud»: Apple назначит адрес автоматически.');
      }
      res.json({ email: verified.email, name: verified.name, parent: parent.email });
    } catch (e) { fail(res, e, 503); }
  });

  return app;
}
