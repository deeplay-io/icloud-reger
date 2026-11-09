import type { Config } from './config';
import type { Db } from './db';

/** Config seeds a new database; subsequent starts preserve the saved rotation. */
export function initializeParent(cfg: Config, db: Db): void {
  if (db.listParents().length === 0 && cfg.parent.email.toLowerCase() !== 'parent@icloud.com') {
    db.setActiveParent(cfg.parent.email, cfg.parent.aliasLimit);
  }
}
