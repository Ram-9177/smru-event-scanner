import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { GraphDrive } from './graph.js';
import { LocalDrive } from './local.js';
import type { Drive } from './types.js';

export * from './types.js';
export { GraphDrive, LocalDrive };

export function createDrive(cfg: Config, db: Db, orgId: string): Drive {
  return cfg.drive === 'graph' ? new GraphDrive(db, cfg, orgId) : new LocalDrive(cfg.localDriveDir);
}
