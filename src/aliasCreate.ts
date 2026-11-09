import type { Frame } from 'puppeteer-core';
import type { Config } from './config';
import type { Db } from './db';
import { ALIAS_MAXIMUM } from './db';
import { AliasRateLimitError } from './errors';
import { ApiError } from './errors';
import { HME, getAliasFrame, readAliasSnapshot, withAliasOperation } from './aliasSync';

async function clickButton(frame: Frame, selector: string, label: string): Promise<void> {
  const button = await frame.$(selector);
  if (!button) throw new ApiError(503, `В iCloud не найдена доступная кнопка «${label}».`);
  await button.click();
}

export async function createAlias(cfg: Config, db: Db, name: string, options: { sequential?: boolean } = {}) {
  if (!options.sequential && (!name || name.length > 100 || name.includes('@'))) throw new ApiError(400, 'Введите метку алиаса без @icloud.com (от 1 до 100 символов).');
  return withAliasOperation(async () => {
    const parent = db.activeParent();
    if (!parent) throw new ApiError(503, 'Сначала выберите родителя.');
    const allowed = db.creationAllowedAt(parent.id);
    if (allowed > Date.now()) throw new AliasRateLimitError(allowed);
    const frame = await getAliasFrame(cfg);
    const before = await readAliasSnapshot(frame, parent.email, cfg.browser.actionTimeoutMs);
    db.importAliases(parent.id, before);
    if (options.sequential) name = db.nextAliasName(parent.id, cfg.generator.namePrefix || parent.email.split('@')[0]);
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
    if (db.activeParent()?.id !== parent.id) throw new ApiError(409, 'Родитель изменился. Создание отменено.');
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
