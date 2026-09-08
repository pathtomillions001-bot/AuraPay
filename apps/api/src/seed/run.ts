import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { seed, describe, alreadySeeded } from './index.js';
import { createLogger } from '../logger.js';

const log = createLogger('seed-cli');

/**
 * `npm run seed` — loads the sandbox demo corpus.
 *
 * Refuses to run unless MODE=sandbox, so demo money can never land in a
 * production database by accident. Pass `--force` to re-seed over an existing
 * demo corpus (it still will not touch a production-mode database).
 */
async function main(): Promise<void> {
  if (!config.isSandbox) {
    log.error('refusing to seed: MODE is not sandbox', { mode: config.mode });
    process.exitCode = 1;
    return;
  }
  getDb();
  if (alreadySeeded() && !process.argv.includes('--force')) {
    console.log(describe());
    console.log('\nThe demo identities already exist; nothing was changed. Re-run with --force after clearing the database to rebuild the corpus.');
    return;
  }
  const summary = await seed({ runDemoPayments: !process.argv.includes('--no-payments') });
  console.log(describe());
  log.info('seed finished', { ...summary });
}

main().catch((error) => {
  log.error('seed failed', { error: (error as Error).message, stack: (error as Error).stack?.split('\n').slice(1, 4).join(' | ') });
  process.exitCode = 1;
});
