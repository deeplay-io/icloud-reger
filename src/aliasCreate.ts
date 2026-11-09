import type { Frame } from 'puppeteer-core';
import type { Services } from './services';
import { ALIAS_MAXIMUM, namePrefixOf } from './db';
import { AliasRateLimitError } from './errors';
import { ApiError } from './errors';
import { HME, getAliasFrame, readAliasSnapshot, withAliasOperation } from './aliasSync';

async function clickButton(frame: Frame, selector: string, label: string): Promise<void> {
  const button = await frame.$(selector);
  if (!button) throw new ApiError(503, `В iCloud не найдена доступная кнопка «${label}».`);
  await button.click();
}

export interface CreatedAlias {
  email: string;
  name: string;
  parent: string;
}

/** Создаёт алиас у родителя в его профиле; sequential — метка по следующему номеру (авторегистрация). */
export async function createAlias({ cfg, db, pool }: Services, parentId: number, name: string, options: { sequential?: boolean } = {}): Promise<CreatedAlias> {
  if (!options.sequential && (!name || name.length > 100 || name.includes('@'))) throw new ApiError(400, 'Введите метку алиаса без @icloud.com (от 1 до 100 символов).');
  const parent = db.parentById(parentId);
  if (!parent || parent.archived) throw new ApiError(409, 'Родитель отключён или не найден.');
  const allowed = db.creationAllowedAt(parent.id);
  if (allowed > Date.now()) throw new AliasRateLimitError(allowed);
  const browser = await pool.get(parent);
  return withAliasOperation(parent.id, async () => {
    const frame = await getAliasFrame(cfg, browser, parent.email);
    const before = await readAliasSnapshot(frame, parent.email, cfg.browser.actionTimeoutMs);
    db.importAliases(parent.id, before);
    if (options.sequential) name = db.nextAliasName(parent.id, namePrefixOf(db.parentById(parent.id) ?? parent));
    if (db.countAliases(parent.id) >= Math.min(ALIAS_MAXIMUM, parent.alias_limit)) throw new ApiError(409, 'Достигнут лимит алиасов родителя (максимум 750).');
    await clickButton(frame, HME.add, 'Добавить');
    let submitted = false;
    try {
    await frame.waitForSelector(HME.label, { timeout: cfg.browser.actionTimeoutMs });
    await frame.waitForFunction(() => (document.body.innerText.match(/[\w.+-]+@(?:(?:private\.)?icloud|me|mac)\.com/gi) ?? []).length === 1, { timeout: cfg.browser.actionTimeoutMs, polling: 200 });
    const proposed = await frame.evaluate(() => document.body.innerText.match(/[\w.+-]+@(?:(?:private\.)?icloud|me|mac)\.com/gi) ?? []);
    if (proposed.length !== 1 || before.some(alias => alias.email === proposed[0].toLowerCase())) {
      throw new ApiError(503, 'Не удалось определить новый адрес в форме iCloud. Создание не подтверждено.');
    }
    const email = proposed[0].toLowerCase();
    await frame.type(HME.label, name);
    // Submit only from the add form: the page of a created address has Deactivate/Delete buttons.
    await frame.waitForFunction((s, label) => !!document.querySelector(s.addForm) && document.querySelector<HTMLInputElement>(s.label)?.value === label && !!document.querySelector(s.forward), { timeout: cfg.browser.actionTimeoutMs, polling: 200 }, HME, name);
    const eventId = db.reserveAliasCreation(parent.id, email);
    // Once submitted, an uncertain response still consumes a durable rate slot.
    submitted = true;
    await clickButton(frame, HME.forward, 'Создать адрес электронной почты');
    try {
      await frame.waitForFunction(s => !document.querySelector(s.addForm), { timeout: cfg.browser.actionTimeoutMs, polling: 200 }, HME);
      const after = await readAliasSnapshot(frame, parent.email, cfg.browser.actionTimeoutMs, email);
      const created = after.find(alias => alias.email === email && alias.name === name);
      if (!created) throw new Error('Новый адрес не появился в списке iCloud.');
      db.importAliases(parent.id, after);
      db.confirmAliasCreation(eventId);
      return { email: created.email, name: created.name, parent: parent.email };
    } catch (error) {
      throw new ApiError(503, `Не удалось подтвердить создание ${email}. Не повторяйте создание сразу: нажмите «Загрузить из iCloud», чтобы проверить результат. ${error instanceof Error ? error.message : error}`);
    }
    } finally {
      if (!submitted && await frame.$(HME.addForm).catch(() => null)) {
        await clickButton(frame, HME.back, 'Назад').catch(() => {});
      }
    }
  });
}
