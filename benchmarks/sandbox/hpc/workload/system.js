'use strict';

/**
 * In-sandbox workload for `hpc-system`.
 *
 * SQLite Speedtest via the vendored `sql.js` package (the upstream project
 * uses PTS's SQLite Speedtest; we use sql.js + a deterministic schema
 * that exercises INSERT / SELECT / UPDATE / DELETE churn without external
 * dependencies). The metric is total operations per second across the
 * four phases.
 *
 * The bundle kind is `sql-wasm` and the runtime reads:
 *   /tmp/hpc/fixture/node_modules/sql.js/dist/sql-wasm.{js,wasm}
 *
 * Calibration target (ceiling): 100_000 ops/sec. Pure-WASM SQLite against
 * an in-memory database hits ~150-250k ops/sec on modern x86; a slower
 * gVisor-backed provider typically lands well under 80k.
 */

const fs = require('node:fs');
const path = require('node:path');

const { emitWorkloadResult } = require('./stdout.js');

const BUNDLE_FIXTURE_ROOT = process.env.HPC_FIXTURE_ROOT || '/tmp/hpc/fixture';
const SQLJS_PATH = path.join(BUNDLE_FIXTURE_ROOT, 'node_modules', 'sql.js');

async function loadSqlJs() {
  // sql.js may be CJS or ESM depending on version; use dynamic import()
  // with a file:// URL for maximum compatibility across providers.
  const mod = await import('file://' + path.join(SQLJS_PATH, 'dist', 'sql-wasm.js'));
  const initSqlJs = mod.default || mod.initSqlJs || mod;
  if (typeof initSqlJs !== 'function') {
    throw new Error(`sql.js init not a function at ${SQLJS_PATH}; got ${typeof initSqlJs}`);
  }
  return initSqlJs({ locateFile: () => path.join(SQLJS_PATH, 'dist', 'sql-wasm.wasm') });
}

async function run() {
  // Setup
  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE bench (id INTEGER PRIMARY KEY, val INTEGER NOT NULL, name TEXT);`);
  db.run(`CREATE INDEX idx_val ON bench (val);`);
  const SEED_ROWS = 5_000;
  const seedStmt = db.prepare('INSERT INTO bench (val, name) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < SEED_ROWS; i++) {
    seedStmt.run([i % 100, `name_${i.toString(36)}`]);
  }
  seedStmt.free();
  db.exec('COMMIT');

  // Phase 1: INSERT 5000 fresh rows
  // Phase 2: range SELECT with index
  // Phase 3: UPDATE every val by +1
  // Phase 4: DELETE 1000 rows
  const OPS_PER_PHASE = 5_000;

  function phase1() {
    const stmt = db.prepare('INSERT INTO bench (val, name) VALUES (?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < OPS_PER_PHASE; i++) {
      stmt.run([i % 100, `insert_${i.toString(36)}`]);
    }
    stmt.free();
    db.exec('COMMIT');
  }

  function phase2() {
    const stmt = db.prepare('SELECT COUNT(*) FROM bench WHERE val >= ? AND val < ?');
    for (let i = 0; i < OPS_PER_PHASE; i++) stmt.get([Math.random() * 100 | 0, (Math.random() * 100 | 0) + 10]);
    stmt.free();
  }

  function phase3() {
    const stmt = db.prepare('UPDATE bench SET val = val + 1 WHERE id = ?');
    db.exec('BEGIN');
    for (let i = 0; i < OPS_PER_PHASE; i++) stmt.run([(Math.random() * SEED_ROWS | 0) + 1]);
    stmt.free();
    db.exec('COMMIT');
  }

  function phase4() {
    db.exec(`DELETE FROM bench WHERE id IN (SELECT id FROM bench LIMIT 1000)`);
    // Re-seed to keep the schema roughly steady between phases.
    db.exec('BEGIN');
    const stmt = db.prepare('INSERT INTO bench (val, name) VALUES (?, ?)');
    for (let i = 0; i < 1_000; i++) stmt.run([i % 100, `respawn_${i.toString(36)}`]);
    stmt.free();
    db.exec('COMMIT');
  }

  function timeIt(label, fn) {
    const t0 = process.hrtime.bigint();
    fn();
    const ns = Number(process.hrtime.bigint() - t0);
    return { label, ns, ms: ns / 1e6 };
  }

  const warmup = timeIt('warmup', () => {
    phase1(); phase2(); phase3(); phase4();
  });
  // Discarded — first run warms the JIT and the WASM runtime; we want
  // representative numbers from the steady-state third+ iteration.
  void warmup;

  let totalOps = 0;
  const phases = [];
  const startNs = process.hrtime.bigint();
  for (let run = 0; run < 3; run++) {
    const t1 = timeIt('p1', phase1);
    const t2 = timeIt('p2', phase2);
    const t3 = timeIt('p3', phase3);
    const t4 = timeIt('p4', phase4);
    if (run === 2) {
      phases.push(t1, t2, t3, t4);
      totalOps += OPS_PER_PHASE * 4;
    }
  }
  const totalNs = Number(process.hrtime.bigint() - startNs);
  const opsPerSec = (totalOps * 3) / (totalNs / 1e9); // 3 runs above

  // Save export into a small artifact for debug.
  try {
    fs.writeFileSync(path.join(BUNDLE_FIXTURE_ROOT, 'system-stats.json'), JSON.stringify({
      totalOps, opsPerSec, phases: phases.map(p => ({ label: p.label, ms: p.ms })),
    }, null, 2));
  } catch (_err) { /* ignore */ }

  emitWorkloadResult({
    ok: true,
    suite: 'system',
    metric: { value: opsPerSec, unit: 'ops_per_s', higherIsBetter: true },
    meta: {
      iterationsReported: totalOps,
      providerNotes: phases.map(p => `${p.label}=${p.ms.toFixed(1)}ms`).join(' '),
    },
  });
  db.close();
  process.exit(0);
}

run().catch(err => {
  emitWorkloadResult({
    ok: false,
    suite: 'system',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: {},
  });
  process.exit(0);
});
