import type { Frame } from 'puppeteer-core';
import type { Config } from './config';
import type { Db } from './db';
import { getBrowser } from './browser';
import { ApiError } from './errors';

// Hide My Email markup. Button texts follow the browser language, so only classes and names are used.
export const HME = {
  tile: '.hide-my-email-tile button.tile-button',
  list: '.ActiveEmailList',
  listTitle: '.ActiveEmailList .flex-title h2',
  emptyList: '.ActiveEmailList-noEmails',
  card: '.ActiveEmailList .searchable-card-subtitle',
  add: '.AddButton button',
  label: 'input[name="hme-label"]',
  addForm: '.GeneratedEmail',
  back: '.button-bar-nav button.button-secondary:not([disabled])',
  forward: '.button-bar-nav button:not(.button-secondary):not([disabled])',
};

function isAliasFrame(candidate: Frame): boolean {
  try {
    const url = new URL(candidate.url());
    return !candidate.detached && url.hostname === 'www.icloud.com' && url.pathname.startsWith('/applications/hidemyemail/');
  } catch { return false; }
}

export async function getAliasFrame(cfg: Config): Promise<Frame> {
  const browser = await getBrowser(cfg.browser);
  let frame: Frame | undefined;
  const pages = await browser.pages();
  for (const page of pages) {
    frame = page.frames().find(isAliasFrame);
    if (frame) { await page.bringToFront(); break; }
  }
  if (!frame) {
    const page = pages.find(candidate => {
      try {
        const url = new URL(candidate.url());
        return url.hostname === 'www.icloud.com' && url.pathname.startsWith('/icloudplus');
      } catch { return false; }
    });
    if (page) {
      await page.bringToFront();
      const tile = await page.$(HME.tile);
      if (tile) {
        await tile.click();
        frame = await page.waitForFrame(isAliasFrame, { timeout: cfg.browser.actionTimeoutMs });
      }
    }
  }
  if (!frame) throw new ApiError(503, 'В профиле Dolphin откройте iCloud → Функции iCloud+ → Скрыть e-mail и повторите загрузку.');
  return frame;
}

/**
 * Reads the complete active list. The result is authoritative: aliases missing from it are removed locally,
 * so an empty list is read twice to rule out a page that has not rendered its cards yet.
 */
export async function readAliasSnapshot(frame: Frame, parentEmail: string, timeout: number, expectEmail = '') {
  const first = await readAliasList(frame, parentEmail, timeout, expectEmail);
  if (first.length) return first;
  await new Promise(resolve => setTimeout(resolve, 3000));
  return readAliasList(frame, parentEmail, timeout, expectEmail);
}

/** Reads the active list; from another page (e.g. a just created address) returns via the nav Back button. */
async function readAliasList(frame: Frame, parentEmail: string, timeout: number, expectEmail: string) {
  await frame.waitForFunction(s => !!document.querySelector(s.list) || (!document.querySelector(s.addForm) && !!document.querySelector(s.back)), { timeout, polling: 200 }, HME);
  if (!(await frame.$(HME.list))) await (await frame.$(HME.back))?.click();
  // The list title holds the only number on any language; the list may still be refreshing after a creation.
  await frame.waitForFunction((s, expect) => (!!document.querySelector(s.emptyList) || /\d/.test(document.querySelector(s.listTitle)?.textContent ?? ''))
    && (!expect || [...document.querySelectorAll(s.card)].some(card => card.textContent?.trim().toLowerCase() === expect)), { timeout, polling: 200 }, HME, expectEmail.toLowerCase());
  const snapshot = await frame.evaluate(s => ({
    text: document.body?.innerText ?? '',
    title: document.querySelector(s.emptyList) ? '0' : document.querySelector(s.listTitle)?.textContent ?? '',
    cards: [...document.querySelectorAll(s.card)].map(element => ({
      email: element.textContent?.trim().toLowerCase() ?? '',
      name: element.closest('.card')?.querySelector('h2')?.textContent?.trim() ?? '',
    })),
  }), HME);
  const addresses: string[] = snapshot.text.toLowerCase().match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g) ?? [];
  if (!addresses.includes(parentEmail.toLowerCase())) {
    throw new ApiError(409, `Не удалось подтвердить родителя ${parentEmail} на странице iCloud. Проверьте аккаунт в открытом профиле.`);
  }
  const count = snapshot.title.match(/\d+/g);
  if (count?.length !== 1) throw new ApiError(503, 'Не удалось прочитать количество активных алиасов. Откройте основной список «Скрыть e-mail».');
  const aliases = snapshot.cards.filter(card => /^[\w.+-]+@(?:(?:private\.)?icloud|me|mac)\.com$/i.test(card.email) && card.email !== parentEmail.toLowerCase());
  const unique = [...new Map(aliases.map(alias => [alias.email, alias])).values()];
  if (unique.length !== Number(count[0])) {
    throw new ApiError(503, `На странице загружено ${unique.length} из ${count[0]} активных алиасов. Откройте полный список и повторите загрузку.`);
  }
  return unique;
}

let busy = false;
export async function withAliasOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (busy) throw new ApiError(409, 'Операция с алиасами уже выполняется. Дождитесь завершения.');
  busy = true;
  try { return await operation(); } finally { busy = false; }
}

export async function syncAliases(cfg: Config, db: Db) {
  return withAliasOperation(async () => {
  const parent = db.activeParent();
  if (!parent) throw new ApiError(503, 'Сначала выберите родителя во вкладке «Родители».');
  const frame = await getAliasFrame(cfg);
  const unique = await readAliasSnapshot(frame, parent.email, cfg.browser.actionTimeoutMs);
  const { added, removed } = db.importAliases(parent.id, unique);
  return { parent: parent.email, found: unique.length, added, removed, total: db.countAliases(parent.id) };
  });
}
