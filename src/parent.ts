import type { Config } from './config';
import { PLACEHOLDER_PARENT, type Db, type ParentSettings } from './db';

/** Профиль из старого config.json: ID профиля Dolphin, а без него — адрес CDP. */
function legacyProfile(cfg: Config): string {
  return String(cfg.browser.dolphinProfileId ?? '').trim() || cfg.browser.cdpUrl;
}

function legacySettings(cfg: Config): ParentSettings {
  return { profile: legacyProfile(cfg), generatorEnabled: cfg.generator.enabled, namePrefix: cfg.generator.namePrefix };
}

/**
 * Родители живут в базе. config.json нужен только при переходе со схемы с одним активным родителем
 * (его профиль и авторегистрация переезжают к этому родителю) и для заполнения новой базы.
 */
export function initializeParents(cfg: Config, db: Db, log: (message: string) => void = () => {}): void {
  if (db.legacyActiveParentId !== null) {
    const parent = db.updateParent(db.legacyActiveParentId, legacySettings(cfg));
    log(`родители: ${parent.email} получил профиль ${parent.profile || '—'} и авторегистрацию (${parent.generator_enabled ? 'включена' : 'выключена'}) из config.json`);
    return;
  }
  const email = cfg.parent.email.trim().toLowerCase();
  if (db.listParents().length === 0 && email && email !== PLACEHOLDER_PARENT) {
    db.addParent(email, { ...legacySettings(cfg), aliasLimit: cfg.parent.aliasLimit });
    log(`родители: добавлен ${email} из config.json`);
  }
}
