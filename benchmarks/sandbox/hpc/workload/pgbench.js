'use strict';

/**
 * In-sandbox workload for `hpc-pgbench`.
 *
 * Pure-JS pglite (an embedded Postgres built on emscripten) running a
 * scaled-down pgbench-style workload:
 *
 *   - Schema setup (~80ms warm).
 *   - pgbench_init: scale=1, creates `pgbench_branches`/`tellers`/`accounts`
 *     and bulk-loads ~10_000 rows via INSERTs.
 *   - pgbench_run: 2000 read-write transactions across 4 sequential
 *     batches (pglite is single-threaded by design).
 *
 * The metric is transactions-per-second during the run phase. The
 * upstream project uses native pgbench; we use pglite so the test runs
 * without Postgres being installed in the sandbox.
 *
 * Calibration target (ceiling): 5_000 TPS. pglite typically lands
 * ~1_000-3_000 TPS for this workload on modern x86.
 */

const { emitWorkloadResult } = require('./stdout.js');

const BUNDLE_FIXTURE_ROOT = process.env.HPC_FIXTURE_ROOT || '/tmp/hpc/fixture';
const PGLITE_PATH = `${BUNDLE_FIXTURE_ROOT}/node_modules/@electric-sql/pglite`;

const SCALE = 1;
const TX_PER_BATCH = 2_000;
const BATCHES = 4;

async function loadPglite() {
  // pglite is an ESM-only package, so require() fails on providers with
  // strict module resolution. Use dynamic import() with a file:// URL.
  const fs = require('node:fs');
  const path = require('node:path');
  const pkgPath = path.join(PGLITE_PATH, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const entryField = pkg.main || (pkg.exports && pkg.exports['.'] && pkg.exports['.'].default) || './dist/index.js';
  const entry = entryField.replace(/^\.\//, '');
  const mod = await import('file://' + path.join(PGLITE_PATH, entry));
  return mod.PGlite;
}

async function setup(db) {
  await db.exec(`DROP TABLE IF EXISTS pgbench_accounts;`);
  await db.exec(`DROP TABLE IF EXISTS pgbench_history;`);
  await db.exec(`CREATE TABLE pgbench_accounts (
    aid    integer PRIMARY KEY,
    bid    integer,
    abalance integer,
    filler char(84)
  );`);
  await db.exec(`CREATE TABLE pgbench_history (
    tid   integer,
    bid   integer,
    aid   integer,
    delta integer,
    mtime timestamp,
    filler char(22)
  );`);

  const accountRows = SCALE * 10_000;
  const values = [];
  for (let aid = 1; aid <= accountRows; aid++) {
    values.push(`(${aid},${aid % 100},0,'${'x'.repeat(84)}')`);
  }
  const batchSize = 1000;
  for (let i = 0; i < values.length; i += batchSize) {
    const slice = values.slice(i, i + batchSize);
    await db.exec(`INSERT INTO pgbench_accounts (aid, bid, abalance, filler) VALUES ${slice.join(',')};`);
  }
  return accountRows;
}

async function runBench(db, accountRows) {
  async function oneTx(aid, bid) {
    await db.transaction(async (tx) => {
      await tx.exec(`UPDATE pgbench_accounts SET abalance = abalance + 1 WHERE aid = ${aid}`);
      await tx.query(`SELECT abalance FROM pgbench_accounts WHERE aid = ${aid}`);
      await tx.exec(`INSERT INTO pgbench_history (tid, bid, aid, delta, mtime, filler) VALUES (1, ${bid}, ${aid}, 1, now(), 'x')`);
    });
  }

  const start = process.hrtime.bigint();
  let totalTx = 0;
  for (let batch = 0; batch < BATCHES; batch++) {
    for (let i = 0; i < TX_PER_BATCH; i++) {
      const aid = ((batch * TX_PER_BATCH + i) % accountRows) + 1;
      const bid = aid % 100;
      await oneTx(aid, bid);
      totalTx++;
    }
  }
  const ns = Number(process.hrtime.bigint() - start);
  return { totalTx, tps: totalTx / (ns / 1e9), seconds: ns / 1e9 };
}

async function run() {
  const PGlite = await loadPglite();
  const db = new PGlite();
  try {
    const accountRows = await setup(db);

    // Warmup
    await runBench(db, Math.min(accountRows, 100));

    // Real run
    const result = await runBench(db, accountRows);

    emitWorkloadResult({
      ok: true,
      suite: 'pgbench',
      metric: { value: result.tps, unit: 'tps', higherIsBetter: true },
      meta: {
        iterationsReported: result.totalTx,
        providerNotes: `${BATCHES} batches \u00d7 ${TX_PER_BATCH} tx in ${result.seconds.toFixed(1)} s (scale=${SCALE}, accounts=${accountRows})`,
      },
    });
  } finally {
    try { await db.close(); } catch (_err) { /* ignore */ }
  }
  process.exit(0);
}

run().catch(err => {
  emitWorkloadResult({
    ok: false,
    suite: 'pgbench',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: {},
  });
  process.exit(0);
});
