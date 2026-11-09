// Быстрая проверка без браузера: npm run smoke
import { Db } from './db';
import { extractCode } from './patterns';
import { DEFAULTS } from './config';

let failed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
}

const db = new Db(':memory:');
db.setActiveParent('parent1@icloud.com', 750);
db.addAlias(1, 'rel1@icloud.com', '1');
check('findAlias case-insensitive', db.findAlias('REL1@ICLOUD.COM')?.name === '1');
check('countAliases', db.countAliases(1) === 1);
db.setActiveParent('parent2@icloud.com', 750);
check('rotation: old parent exhausted', db.parentById(1)?.status === 'exhausted');
check('rotation: new parent active', db.activeParent()?.email === 'parent2@icloud.com');
check('seen refs dedupe', (() => {
  db.recordCode('rel1@icloud.com', 'ref1', '123456');
  db.recordCode('rel1@icloud.com', 'ref1', '123456');
  return db.seenRefs('rel1@icloud.com').size === 1;
})());

const patterns = DEFAULTS.code.patterns;
check('rus: "Ваш код для входа: 482913"', extractCode('Ваш код для входа: 482913', patterns)?.code === '482913');
check('eng: "Your one-time code is 123456."', extractCode('Your one-time code is 123456. It expires in 10 minutes.', patterns)?.code === '123456');
check('no code: "Привет, письмо без кода"', extractCode('Привет, это просто письмо, цифр в нём нет', patterns) === null);
check('6-digit fallback: "Ваш код: 482913. Не сообщайте его кому-либо"', extractCode('Ваш код: 482913. Не сообщайте его кому-либо', patterns)?.code === '482913');

console.log(failed === 0 ? 'smoke: OK' : `smoke: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
