import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { BrowserConfig } from './config';

let browser: Browser | null = null;
let connecting: Promise<Browser> | null = null;

export async function getBrowser(cfg: BrowserConfig): Promise<Browser> {
  if (browser?.connected) return browser;
  if (!connecting) {
    connecting = puppeteer
      .connect({
        browserURL: cfg.cdpUrl,
        defaultViewport: null,
        protocolTimeout: cfg.actionTimeoutMs * 2,
      })
      .then((b) => {
        browser = b;
        b.on('disconnected', () => {
          browser = null;
          connecting = null;
        });
        return b;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

export function isConnected(): boolean {
  return browser?.connected === true;
}

/**
 * Ищет в открытых вкладках ту, чей URL содержит hint; если нет — открывает
 * новый таб с url. Возвращает страницу; закрывать её вызывающему не нужно
 * (наш таб закроет withPage, чужой — нет).
 */
async function findOrCreatePage(cfg: BrowserConfig, url: string, hint: string): Promise<{ page: Page; own: boolean }> {
  const b = await getBrowser(cfg);
  const pages = await b.pages();
  const hit = pages.find((p) => p.url().toLowerCase().includes(hint));
  if (hit) return { page: hit, own: false };
  const page = await b.newPage();
  page.setDefaultTimeout(cfg.actionTimeoutMs);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: cfg.actionTimeoutMs });
  return { page, own: true };
}

/** Работает на вкладке с hint'ом (открывает, если нет), fn получает страницу. Наш таб закрывается. */
export async function withPage<T>(
  cfg: BrowserConfig,
  url: string,
  hint: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const { page, own } = await findOrCreatePage(cfg, url, hint);
  try {
    return await fn(page);
  } finally {
    if (own) await page.close().catch(() => undefined);
  }
}

export async function pageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '');
}
