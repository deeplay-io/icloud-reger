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
const first = db.addParent('parent1@icloud.com', { generatorEnabled: true });
db.addAlias(first.id, 'rel1@icloud.com', '1');
check('findAlias case-insensitive', db.findAlias('REL1@ICLOUD.COM')?.name === '1');
check('countAliases', db.countAliases(first.id) === 1);
const second = db.addParent('parent2@icloud.com', { generatorEnabled: true });
check('parents: both in work at once', db.workingParents().map(p => p.id).join() === `${first.id},${second.id}`);
check('parents: alias filter by parent', db.listAliases({ parentId: second.id }).total === 0 && db.listAliases({ parentId: first.id }).rows[0]?.parent === 'parent1@icloud.com');
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
