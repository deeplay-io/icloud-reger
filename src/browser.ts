import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { BrowserConfig } from './config';
import type { ParentRow } from './db';
import { ApiError } from './errors';
import { connectProfile } from './dolphin';

export type BrowserState = 'none' | 'connecting' | 'connected' | 'error';
export interface BrowserStatus {
  state: BrowserState;
  error: string;
  /** PROFILE_REQUIRES_RESTART — профиль открыт без автоматизации, поможет только «Перезапустить профиль». */
  code: string;
  cdpUrl: string;
}

export interface PoolDependencies {
  /** Адрес CDP профиля Dolphin; закрытый профиль при этом открывается. */
  resolveProfile?: (profileId: string, options: { restart: boolean; onStatus: (text: string) => void }) => Promise<string>;
  connect?: (cdpUrl: string) => Promise<Browser>;
  now?: () => number;
}

/** После неудачного подключения следующая попытка — не раньше чем через минуту. */
export const RETRY_MS = 60 * 1000;
const KEEPALIVE_MS = 15 * 1000;

interface Slot {
  profile: string;
  browser: Browser | null;
  connecting: Promise<Browser> | null;
  state: BrowserState;
  error: string;
  code: string;
  cdpUrl: string;
  retryAt: number;
}

/** Профиль родителя — ID профиля Dolphin или готовый адрес CDP (браузер с remote debugging). */
export function isCdpUrl(profile: string): boolean {
  return /^https?:\/\//i.test(profile.trim());
}

export function validProfile(profile: string): boolean {
  const value = profile.trim();
  if (/^\d+$/.test(value)) return true;
  if (!isCdpUrl(value)) return false;
  try { new URL(value); return true; } catch { return false; }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Браузеры родителей: у каждого свой профиль Dolphin и своё подключение по CDP.
 * Профили всех родителей в работе держатся подключёнными: закрытый профиль сервис открывает снова,
 * порт CDP узнаёт заново при каждом подключении. Профиль, открытый без автоматизации, сам не перезапускает.
 */
export class BrowserPool {
  private slots = new Map<number, Slot>();
  // Запросы к Dolphin — по одному: при старте 15 профилей не запускают Dolphin дважды и не заваливают /start.
  private dolphin: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private resolveProfile: NonNullable<PoolDependencies['resolveProfile']>;
  private connectCdp: NonNullable<PoolDependencies['connect']>;
  private now: () => number;
  /** Вызывается после каждого подключения (например, чтобы сразу загрузить алиасы). */
  onConnected: (parentId: number) => void = () => {};

  constructor(
    private cfg: BrowserConfig,
    private parents: () => ParentRow[],
    private log: (message: string) => void,
    dependencies: PoolDependencies = {},
  ) {
    this.resolveProfile = dependencies.resolveProfile ?? (async (profileId, options) =>
      (await connectProfile(profileId, fetch, { ...options, dolphinPath: cfg.dolphinPath })).cdpUrl);
    this.connectCdp = dependencies.connect ?? (cdpUrl => puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null, protocolTimeout: cfg.actionTimeoutMs * 2 }));
    this.now = dependencies.now ?? Date.now;
  }

  status(parentId: number): BrowserStatus {
    const slot = this.slots.get(parentId);
    if (!slot) return { state: 'none', error: '', code: '', cdpUrl: '' };
    const state = slot.state === 'connected' && !slot.browser?.connected ? 'error' : slot.state;
    return { state, error: slot.error, code: slot.code, cdpUrl: slot.cdpUrl };
  }

  isConnected(parentId: number): boolean {
    return this.slots.get(parentId)?.browser?.connected === true;
  }

  private check(parent: ParentRow): void {
    if (parent.archived) throw new ApiError(503, `Профиль родителя ${parent.email} не подключён: родитель отключён.`);
    if (!parent.profile) throw new ApiError(503, `Профиль родителя ${parent.email} не подключён: не задан ID профиля Dolphin (вкладка «Родители»).`);
  }

  private slot(parent: ParentRow): Slot {
    let slot = this.slots.get(parent.id);
    if (slot && slot.profile !== parent.profile.trim()) {
      this.drop(parent.id);
      slot = undefined;
    }
    if (!slot) {
      slot = { profile: parent.profile.trim(), browser: null, connecting: null, state: 'none', error: '', code: '', cdpUrl: '', retryAt: 0 };
      this.slots.set(parent.id, slot);
    }
    return slot;
  }

  /** Браузер родителя для операции; не подключён — подключает (после недавней неудачи сразу отвечает ошибкой). */
  async get(parent: ParentRow): Promise<Browser> {
    this.check(parent);
    const slot = this.slot(parent);
    if (slot.browser?.connected) return slot.browser;
    if (slot.connecting) return slot.connecting;
    if (this.now() < slot.retryAt) throw new ApiError(503, `Профиль родителя ${parent.email} не подключён: ${slot.error}`);
    return this.open(parent, slot, false);
  }

  /** Подключение по кнопке: без паузы после неудачи; restart перезапускает профиль в Dolphin. */
  async connect(parent: ParentRow, restart = false): Promise<BrowserStatus> {
    try { this.check(parent); } catch (error) { throw new ApiError(400, message(error)); }
    const slot = this.slot(parent);
    if (slot.connecting) await slot.connecting.catch(() => undefined);
    if (restart && slot.browser) {
      const old = slot.browser;
      slot.browser = null;
      old.disconnect().catch(() => undefined);
    }
    if (!slot.browser?.connected) await this.open(parent, slot, restart);
    return this.status(parent.id);
  }

  private serialDolphin<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.dolphin.then(operation, operation);
    this.dolphin = run.catch(() => undefined);
    return run;
  }

  private open(parent: ParentRow, slot: Slot, restart: boolean): Promise<Browser> {
    slot.state = 'connecting';
    slot.code = '';
    const attempt = (async () => {
      const cdpUrl = isCdpUrl(slot.profile)
        ? slot.profile
        : await this.serialDolphin(() => this.resolveProfile(slot.profile, { restart, onStatus: text => this.log(`[${parent.email}] Dolphin Anty: ${text}`) }));
      const browser = await this.connectCdp(cdpUrl);
      if (this.slots.get(parent.id) !== slot || this.stopped) {
        browser.disconnect().catch(() => undefined);
        throw new Error('профиль родителя изменился во время подключения');
      }
      slot.browser = browser;
      slot.cdpUrl = cdpUrl;
      slot.state = 'connected';
      slot.error = '';
      slot.retryAt = 0;
      browser.on('disconnected', () => {
        if (slot.browser !== browser) return;
        slot.browser = null;
        slot.state = 'error';
        slot.error = 'браузер профиля закрыт или отключился';
        // Обход переподключит (и при необходимости снова откроет профиль) на следующем шаге.
        slot.retryAt = 0;
        this.log(`[${parent.email}] ${slot.error}, переподключаю`);
      });
      this.log(`[${parent.email}] браузер подключён: ${cdpUrl}`);
      this.onConnected(parent.id);
      return browser;
    })();
    const connecting = attempt.catch(error => {
      const text = message(error);
      if (slot.error !== text) this.log(`[${parent.email}] профиль не подключён: ${text}. Повтор через ${RETRY_MS / 60000} мин.`);
      slot.state = 'error';
      slot.error = text;
      slot.code = (error as { code?: string }).code ?? '';
      slot.retryAt = this.now() + RETRY_MS;
      throw new ApiError(503, `Профиль родителя ${parent.email} не подключён: ${text}`);
    }).finally(() => { if (slot.connecting === connecting) slot.connecting = null; });
    slot.connecting = connecting;
    return connecting;
  }

  /** Отпускает браузер родителя, не закрывая профиль: в нём залогинен Apple ID. */
  drop(parentId: number): void {
    const slot = this.slots.get(parentId);
    if (!slot) return;
    this.slots.delete(parentId);
    // Сначала забываем браузер: puppeteer может прислать 'disconnected' синхронно, и это не обрыв.
    const browser = slot.browser;
    slot.browser = null;
    browser?.disconnect().catch(() => undefined);
  }

  /** Один шаг обхода: подключить родителей в работе, отпустить отключённых и тех, у кого сменился или пропал профиль. */
  tick(): void {
    const working = this.parents();
    const ids = new Set(working.map(parent => parent.id));
    for (const id of [...this.slots.keys()]) if (!ids.has(id)) this.drop(id);
    for (const parent of working) {
      if (!parent.profile.trim()) { this.drop(parent.id); continue; }
      const slot = this.slot(parent);
      if (slot.browser?.connected || slot.connecting || this.now() < slot.retryAt) continue;
      this.open(parent, slot, false).catch(() => undefined);
    }
  }

  start(): void {
    const poll = () => {
      if (this.stopped) return;
      try { this.tick(); } catch (error) { this.log(`браузеры: ${message(error)}`); }
      this.timer = setTimeout(poll, KEEPALIVE_MS);
    };
    poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const id of [...this.slots.keys()]) this.drop(id);
  }
}

/**
 * Ищет в открытых вкладках браузера ту, чей URL содержит hint; если нет — открывает
 * новый таб с url. Наш таб закрывается после fn, чужой — нет.
 */
export async function withPage<T>(browser: Browser, cfg: BrowserConfig, url: string, hint: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const pages = await browser.pages();
  let page = pages.find(p => p.url().toLowerCase().includes(hint));
  let own = false;
  if (!page) {
    page = await browser.newPage();
    own = true;
    page.setDefaultTimeout(cfg.actionTimeoutMs);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: cfg.actionTimeoutMs });
  }
  try {
    return await fn(page);
  } finally {
    if (own) await page.close().catch(() => undefined);
  }
}

export async function pageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '');
}
