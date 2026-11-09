import { createHash } from 'node:crypto';
import type { Frame, Page } from 'puppeteer-core';
import type { Config } from './config';
import type { Db } from './db';
import { ApiError } from './errors';
import { withPage } from './browser';
import { extractCode } from './patterns';

export interface CodeResult {
  code: string;
  pattern: string;
  msgRef: string;
  subject?: string;
}

export function parseMailDate(value: string): number | null {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const match = value.toLowerCase().match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})[\s\S]*?(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const month = months.indexOf(match[2]);
  if (month < 0) return null;
  const result = new Date(+match[3], month, +match[1], +match[4], +match[5], +(match[6] || 0));
  if (result.getMonth() !== month || result.getDate() !== +match[1] || +match[4] > 23 || +match[5] > 59 || +(match[6] || 0) > 59) return null;
  return result.getTime();
}

export function readHeaderFields(rows: { label: string; value: string }[]) {
  const find = (label: RegExp) => rows.filter(row => label.test(row.label.trim())).map(row => row.value).join('\n');
  return {
    recipients: (find(/^(?:Кому|Копия|To|Cc)\s*:?$/i).match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []).map(email => email.toLowerCase()),
    subject: find(/^(?:Тема|Subject)\s*:?$/i),
    date: parseMailDate(find(/^(?:Дата|Date)\s*:?$/i)),
  };
}

function isMailFrame(frame: Frame, message = false): boolean {
  try {
    const url = new URL(frame.url());
    return message
      ? url.hostname === 'www-mail.icloud-sandbox.com' && url.pathname.startsWith('/applications/mail2-message/')
      : url.hostname === 'www.icloud.com' && url.pathname.startsWith('/applications/mail2/');
  } catch { return false; }
}

export function snapshotDocument(selector: string) {
  // Display names and email addresses are separate text nodes in iCloud.
  // textContent concatenates them ("Hide My Emailalias@icloud.com").
  const headerText = (element: Element | undefined | null): string => {
    if (!element) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  return {
    rows: [...document.querySelectorAll('.mail-message-header tr')].map(row => ({
      label: headerText(row.querySelector('td')),
      value: headerText(row.querySelectorAll('td')[1]),
    })),
    body: (document.querySelector(selector) as HTMLElement | null)?.innerText ?? '',
  };
}

async function readMessageSnapshots(page: Page, bodySelector: string) {
  const snapshots: ReturnType<typeof snapshotDocument>[] = [];
  for (const frame of page.frames().filter(frame => isMailFrame(frame, true))) {
    const snapshot = await frame.evaluate(snapshotDocument, bodySelector).catch(() => null);
    if (snapshot) snapshots.push(snapshot);
  }
  // Dolphin can expose cross-origin message iframes as separate CDP targets.
  // Match their frame IDs to iframe elements in this mail tab before reading.
  const client = await page.createCDPSession();
  try {
    const ids = new Set<string>();
    for (const frame of page.frames().filter(frame => isMailFrame(frame))) {
      for (const element of await frame.$$('iframe[src*="/applications/mail2-message/"]')) {
        const node = await client.send('DOM.describeNode', { backendNodeId: await element.backendNodeId() }).catch(() => null);
        if (node?.node.frameId) ids.add(node.node.frameId);
      }
    }
    if (!ids.size) return snapshots;
    for (const target of page.browser().targets()) {
      try {
        const url = new URL(target.url());
        if (url.hostname !== 'www-mail.icloud-sandbox.com' || !url.pathname.startsWith('/applications/mail2-message/')) continue;
      } catch { continue; }
      const session = await target.createCDPSession().catch(() => null);
      if (!session) continue;
      try {
        const tree = await session.send('Page.getFrameTree');
        if (!ids.has(tree.frameTree.frame.id)) continue;
        const result = await session.send('Runtime.evaluate', {
          expression: `(${snapshotDocument.toString()})(${JSON.stringify(bodySelector)})`,
          returnByValue: true,
        });
        if (!result.exceptionDetails && result.result.value) snapshots.push(result.result.value);
      } catch { /* Message changed or frame detached while loading. */ }
      finally { await session.detach().catch(() => {}); }
    }
  } finally { await client.detach().catch(() => {}); }
  return snapshots;
}

async function messageSnapshot(page: Page, expectedSubject: string, bodySelector: string, timeout: number, previous: string[]) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const snapshot of await readMessageSnapshots(page, bodySelector)) {
      if (!snapshot?.body.trim()) continue;
      if (previous.includes(JSON.stringify(snapshot))) continue;
      const header = readHeaderFields(snapshot.rows);
      if (expectedSubject && header.subject && header.subject.replace(/\s+/g, ' ').trim() !== expectedSubject.replace(/\s+/g, ' ').trim()) continue;
      if (!header.recipients.length) continue;
      return { ...snapshot, header: { ...header, subject: header.subject || expectedSubject } };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new ApiError(503, 'Не удалось дождаться заголовка и текста выбранного письма iCloud. Повторите запрос.');
}

let reading = false;
export async function readCode(cfg: Config, db: Db, aliasEmail: string): Promise<CodeResult> {
  if (reading) throw new ApiError(409, 'Чтение письма уже выполняется. Дождитесь завершения.');
  const email = aliasEmail.trim().toLowerCase();
  const alias = db.findAlias(email);
  if (!alias) throw new ApiError(404, `Алиас ${email} не найден в базе: возможно, он удалён или деактивирован в iCloud. Если адрес создан недавно, нажмите «Загрузить из iCloud».`);
  const parent = db.parentById(alias.parent_id);
  if (!parent || db.activeParent()?.id !== parent.id) throw new ApiError(503, 'Выберите родителя этого алиаса и подключите его профиль Dolphin.');
  const sel = cfg.code.selectors;
  const messageItem = sel.messageItem || '.thread-list-item[role="treeitem"]';
  const body = sel.body || '.mail-message-defaults';
  reading = true;
  try {
    return await withPage(cfg.browser, cfg.browser.mailUrl, cfg.browser.mailTabHint, async page => {
      await page.bringToFront();
      const mail = page.frames().find(frame => isMailFrame(frame)) ?? await page.waitForFrame(frame => isMailFrame(frame), { timeout: cfg.browser.actionTimeoutMs });
      await mail.waitForSelector('.thread-list', { timeout: cfg.browser.actionTimeoutMs });
      const list = await mail.$$(messageItem);
      if (!list.length) throw new ApiError(404, 'В открытой папке iCloud Mail нет писем. Откройте папку с нужным письмом и повторите запрос.');
      const n = Math.min(cfg.code.maxMessagesToScan, list.length);
      const seen = db.seenRefs(email);
      for (let i = 0; i < n; i++) {
        const item = (await mail.$$(messageItem))[i];
        if (!item) break;
        const subject = await item.$eval(sel.subject || '.thread-subject', element => element.textContent?.trim() ?? '').catch(() => '');
        const selected = await item.evaluate(element => element.getAttribute('aria-selected') === 'true');
        const previous: string[] = [];
        if (!selected) {
          for (const snapshot of await readMessageSnapshots(page, body)) previous.push(JSON.stringify(snapshot));
          await item.click();
        }
        const message = await messageSnapshot(page, subject, body, cfg.browser.actionTimeoutMs, previous);
        if (!message.header.recipients.includes(email)) continue;
        if (message.header.date === null) throw new ApiError(503, 'Не удалось распознать дату письма: свежесть кода не подтверждена.');
        const age = Date.now() - message.header.date;
        if (age > cfg.code.freshnessMinutes * 60000 || age < -5 * 60000) continue;
        const extracted = extractCode(message.body, cfg.code.patterns);
        if (!extracted) continue;
        const ref = createHash('sha256').update(JSON.stringify(message.rows) + '\n' + message.body).digest('hex');
        if (seen.has(ref)) continue;
        if (db.activeParent()?.id !== parent.id) throw new ApiError(409, 'Родитель изменился во время чтения. Повторите запрос.');
        db.recordCode(email, ref, extracted.code);
        return { code: extracted.code, pattern: extracted.pattern, msgRef: ref, subject: message.header.subject };
      }
      throw new ApiError(404, `Новое письмо с кодом для ${email} не найдено среди ${n} последних писем (свежесть: ${cfg.code.freshnessMinutes} мин.).`);
    });
  } finally { reading = false; }
}
