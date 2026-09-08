import { LEGAL_DISCLAIMER, config, assertProductionReady } from './config.js';
import { getDb } from './db/index.js';
import { buildApp } from './http/app.js';
import { createLogger } from './logger.js';
import * as queue from './workers/queue.js';

const log = createLogger('main');

/**
 * One process: HTTP API plus the worker loop that drives settlement.
 *
 * That is a deliberate staging choice, not a shortcut. Every step a payment takes
 * is recorded in `job_queue` and claimed by `worker_id`, so the same code can run
 * as N API replicas plus M workers: set `WORKER_ENABLED=false` on the web nodes
 * and the queue semantics do not change. What would change is only *who* claims
 * the next tick.
 */
async function main(): Promise<void> {
  const problems = assertProductionReady();
  if (problems.length) {
    for (const p of problems) log.error('production readiness', { problem: p });
    throw new Error(`Refusing to start with an incomplete configuration:\n  ${problems.join('\n  ')}`);
  }

  // Opening the database is also what runs migrations, so nothing else has to.
  const db = getDb();
  let counts: { users: number; payments: number } | undefined;
  try {
    counts = db.maybeOne<{ users: number; payments: number }>(
      `SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM payment_intents) AS payments`,
    );
  } catch {
    // A brand new database has no tables to count yet. That is not an error worth
    // shouting about, and the banner below says the same thing more usefully.
    counts = undefined;
  }

  // Prices before traffic. A sandbox that has just booted has an FX table older
  // than the quote TTL, and the first customer to ask for a price would be told the
  // market moved. Refreshing here is honest: it is the same call the sweep loop makes.
  const fx = await import('./domain/fx.js');
  try {
    const refreshed = await fx.refreshRates();
    log.info('price feed ready', { rates: refreshed.count, source: refreshed.source, simulated: refreshed.simulated });
  } catch (error) {
    log.warn('price feed not ready at boot — quotes will fail closed until the next refresh', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const app = await buildApp();

  // The knob that lets a web node serve traffic without settling money twice.
  const workerEnabled = process.env.WORKER_ENABLED !== 'false';
  if (workerEnabled) {
    queue.start({
      tickMs: Number(process.env.WORKER_TICK_MS ?? 1000),
      sweepMs: Number(process.env.WORKER_SWEEP_MS ?? 15_000),
    });
  } else {
    log.warn('worker loop disabled — quotes will expire but nothing will settle', { host: config.host });
  }

  await app.listen({ port: config.port, host: config.host });

  const banner = [
    '',
    `  AuraPay API — ${config.mode === 'sandbox' ? 'SANDBOX' : 'production'} mode`,
    `  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/v1/health`,
    `  database: ${config.database.driver} (${config.database.driver === 'sqlite' ? config.database.sqlitePath : 'managed'})`,
    counts && counts.users > 0 ? `  accounts: ${counts.users} users, ${counts.payments} payments on record` : '  no accounts yet — `npm run seed` for the sandbox corpus',
    '',
    `  ${LEGAL_DISCLAIMER}`,
    '',
  ].join('\n');
  // Printed to stdout rather than the logger: it must survive LOG_LEVEL=error,
  // because "is this real money?" is the one question that must never be guessable.
  process.stdout.write(`${banner}\n`);
  log.info('api listening', { port: config.port, mode: config.mode, driver: config.database.driver });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    // Stop taking requests, then stop settling them, then let in-flight jobs
    // finish their current step. A settlement that is half-applied is worse than
    // one that is merely late, and the journal is what makes "late" recoverable.
    await app.close().catch((error: unknown) => log.error('http close failed', { error: String(error) }));
    queue.stop();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const { closeDb } = await import('./db/index.js');
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  log.error('fatal boot error', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exitCode = 1;
});
