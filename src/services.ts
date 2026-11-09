import type { Config } from './config';
import type { Db } from './db';
import type { BrowserPool } from './browser';

/** То, что нужно операциям с родителями в браузере: конфиг, база и браузеры родителей. */
export interface Services {
  cfg: Config;
  db: Db;
  pool: Pick<BrowserPool, 'get'>;
}
