import { createHash } from 'node:crypto';
import type { Frame, Page } from 'puppeteer-core';
import type { Db, ParentRow } from './db';
import type { Services } from './services';
import { ApiError } from './errors';
import { withPage } from './browser';
import { extractCode } from './patterns';
import { withAliasOperation } from './aliasSync';
import { matchesRule } from './mailKinds';
import type { MailKindRule } from './mailCodeConfig';

export interface CodeResult {
  code: string;
  pattern: string;
  msgRef: string;
  subject?: string;
}

// Начала названий месяцев на языках интерфейса iCloud: русский («9 ноября»), немецкий («9. November»), английский.
const MONTH_PREFIXES = [['янв', 'jan'], ['фев', 'feb'], ['мар', 'mär', 'mar'], ['апр', 'apr'], ['мая', 'май', 'mai', 'may'], ['июн', 'jun'], ['июл', 'jul'], ['авг', 'aug'], ['сен', 'sep'], ['окт', 'okt', 'oct'], ['ноя', 'nov'], ['дек', 'dez', 'dec']];

export function parseMailDate(value: string): number | null {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const match = value.toLowerCase().match(/(\d{1,2})\.?\s+([a-zа-яёäöü]+)\.?\s+(\d{4})[\s\S]*?(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const month = MONTH_PREFIXES.findIndex(prefixes => prefixes.includes(match[2].slice(0, 3)));
  if (month < 0) return null;
  const result = new Date(+match[3], month, +match[1], +match[4], +match[5], +(match[6] || 0));
  if (result.getMonth() !== month || result.getDate() !== +match[1] || +match[4] > 23 || +match[5] > 59 || +(match[6] || 0) > 59) return null;
  return result.getTime();
}

export function readHeaderFields(rows: { label: string; value: string }[]) {
  const find = (label: RegExp) => rows.filter(row => label.test(row.label.trim())).map(row => row.value).join('\n');
  // Подписи полей зависят от языка браузера в профиле: русский, английский, немецкий.
  const dateText = find(/^(?:Дата|Date|Datum)\s*:?$/i);
  return {
    recipients: (find(/^(?:Кому|Копия|To|Cc|An|Kopie)\s*:?$/i).match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []).map(email => email.toLowerCase()),
    from: find(/^(?:От кого|От|From|Von)\s*:?$/i),
    subject: find(/^(?:Тема|Subject|Betreff)\s*:?$/i),
    date: parseMailDate(dateText),
    dateText,
  };
}

/**
 * iCloud показывает время письма в часовом поясе браузера, а профиль Dolphin часто подменяет его под прокси.
 * parseMailDate читает такое время в поясе Node, поэтому сдвигаем на разницу поясов. Время с явным поясом не трогаем.
 */
export function pageDateToUtc(dateText: string, parsed: number, pageOffsetMinutes: number): number {
  if (/\b(?:GMT|UTC|Z)\b|[+-]\d{2}:?\d{2}\s*$/i.test(dateText)) return parsed;
  return parsed + (pageOffsetMinutes - new Date(parsed).getTimezoneOffset()) * 60000;
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

/** Алиас из базы и его родитель: почта читается в профиле этого родителя. */
function aliasParent(db: Db, email: string): ParentRow {
  const alias = db.findAlias(email);
  if (!alias) throw new ApiError(404, `Алиас ${email} не найден в базе: возможно, он удалён или деактивирован в iCloud. Если адрес создан недавно, нажмите «Загрузить из iCloud».`);
  const parent = db.parentById(alias.parent_id);
  if (!parent) throw new ApiError(404, `Родитель алиаса ${email} не найден в базе.`);
  return parent;
}

// Обычное письмо открывается за 1–2 секунды; то, что не открылось за это время (другой шаблон, без получателя), пропускаем.
const MESSAGE_TIMEOUT_MS = 10000;

/**
 * Открывает вкладку iCloud Mail и по очереди открывает письма открытой папки, от новых к старым.
 * visit возвращает true, чтобы остановиться. Письмо, которое не удалось прочитать, пропускается;
 * ошибка — только если не прочиталось ни одно. Работает под общей блокировкой операций в браузере.
 */
async function scanMailbox({ cfg, pool }: Services, parent: ParentRow, visit: (message: Awaited<ReturnType<typeof messageSnapshot>>, pageOffsetMinutes: number) => boolean | void): Promise<number> {
  const sel = cfg.code.selectors;
  const messageItem = sel.messageItem || '.thread-list-item[role="treeitem"]';
  const body = sel.body || '.mail-message-defaults';
  const browser = await pool.get(parent);
  return withAliasOperation(parent.id, () => withPage(browser, cfg.browser, cfg.browser.mailUrl, cfg.browser.mailTabHint, async page => {
    await page.bringToFront();
    const mail = page.frames().find(frame => isMailFrame(frame)) ?? await page.waitForFrame(frame => isMailFrame(frame), { timeout: cfg.browser.actionTimeoutMs });
    await mail.waitForSelector('.thread-list', { timeout: cfg.browser.actionTimeoutMs });
    const list = await mail.$$(messageItem);
    if (!list.length) throw new ApiError(404, 'В открытой папке iCloud Mail нет писем. Откройте папку с нужным письмом и повторите запрос.');
    const pageOffsetMinutes = await mail.evaluate(() => new Date().getTimezoneOffset());
    const n = Math.min(cfg.code.maxMessagesToScan, list.length);
    let read = 0;
    let lastError: unknown;
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
      let message;
      try {
        message = await messageSnapshot(page, subject, body, Math.min(cfg.browser.actionTimeoutMs, MESSAGE_TIMEOUT_MS), previous);
      } catch (error) {
        lastError = error;
        continue;
      }
      read++;
      if (visit(message, pageOffsetMinutes)) break;
    }
    if (!read && lastError) throw lastError;
    return n;
  }));
}

export async function readCode(svc: Services, aliasEmail: string): Promise<CodeResult & { parent: string }> {
  const { cfg, db } = svc;
  const email = aliasEmail.trim().toLowerCase();
  const parent = aliasParent(db, email);
  const seen = db.seenRefs(email);
  let result: CodeResult | undefined;
  const n = await scanMailbox(svc, parent, message => {
    if (!message.header.recipients.includes(email)) return;
    if (message.header.date === null) throw new ApiError(503, 'Не удалось распознать дату письма: свежесть кода не подтверждена.');
    const age = Date.now() - message.header.date;
    if (age > cfg.code.freshnessMinutes * 60000 || age < -5 * 60000) return;
    const extracted = extractCode(message.body, cfg.code.patterns);
    if (!extracted) return;
    const ref = createHash('sha256').update(JSON.stringify(message.rows) + '\n' + message.body).digest('hex');
    if (seen.has(ref)) return;
    db.recordCode(email, ref, extracted.code);
    result = { code: extracted.code, pattern: extracted.pattern, msgRef: ref, subject: message.header.subject };
    return true;
  });
  if (result) return { ...result, parent: parent.email };
  throw new ApiError(404, `Новое письмо с кодом для ${email} не найдено среди ${n} последних писем ящика ${parent.email} (свежесть: ${cfg.code.freshnessMinutes} мин.).`);
}

export interface MailMessage {
  from: string;
  subject: string;
  text: string;
  /** Время письма из заголовка в UTC; точность — минута или секунда, как показывает iCloud. 0 — не распознано. */
  receivedAt: number;
}

/**
 * Запасной путь gRPC-сервиса кодов: письма на алиас в открытой папке iCloud Mail, от новых к старым.
 * Вид письма и код определяет gRPC-сервис теми же правилами, что для IMAP. seen_codes не трогаем:
 * повторный запрос должен вернуть тот же код.
 * skipParents — родители, чьи ящики gRPC-сервис уже исправно читает по IMAP: для них браузер не открываем.
 * match — правило запрошенного вида (без вырезания кода): проход останавливается на первом, самом новом
 * подходящем письме, как и поиск по IMAP. Без него собираются все письма на алиас.
 */
export async function readAliasMessages(svc: Services, aliasEmail: string, sentAfterMs: number, skipParents: string[] = [], match?: Omit<MailKindRule, 'patterns'>) {
  const email = aliasEmail.trim().toLowerCase();
  const parent = aliasParent(svc.db, email);
  if (skipParents.includes(parent.email)) return { parent: parent.email, skipped: true, messages: [] as MailMessage[] };
  // Время в заголовке может быть с точностью до минуты: письмо из той же минуты не теряем.
  const after = Math.floor(sentAfterMs / 60000) * 60000;
  const messages: MailMessage[] = [];
  await scanMailbox(svc, parent, (message, pageOffsetMinutes) => {
    const { header } = message;
    const receivedAt = header.date === null ? 0 : pageDateToUtc(header.dateText, header.date, pageOffsetMinutes);
    if (sentAfterMs > 0) {
      if (!receivedAt) return;
      // Список от новых к старым: дальше только письма старше sent_after.
      if (receivedAt < after) return true;
    }
    if (!header.recipients.includes(email)) return;
    const mail = { from: header.from, subject: header.subject, text: message.body, receivedAt };
    if (match && !matchesRule(mail, { ...match, patterns: [] })) return;
    messages.push(mail);
    return !!match;
  });
  return { parent: parent.email, skipped: false, messages };
}
