'use strict';

/**
 * In-sandbox workload for `hpc-cpu-node`.
 *
 * Invoked by the orchestrator after uploading the fixture archive to
 * /tmp/bench/fixture. Runs `node src/index.js` of the fixture once, reads
 * its emitted `.hpc-fixture-artifacts/last.json`, and posts the total
 * wall-clock value as the suite metric.
 */

const fs = require('node:fs');
const path = require('node:path');
const { emitWorkloadResult } = require('./stdout.js');

const FIXTURE_ROOT = process.env.BENCH_FIXTURE_ROOT || '/tmp/bench/fixture';
const ARTIFACTS_FILE = path.join(FIXTURE_ROOT, '.hpc-fixture-artifacts', 'last.json');

const t0 = process.hrtime.bigint();

// Check if node binary is available before spawning. Some providers (e.g.
// beam with runtime: 'node') may not have a separate `node` binary in PATH.
const { spawnSync } = require('node:child_process');
const nodeCheck = spawnSync('which', ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (nodeCheck.status !== 0 || !nodeCheck.stdout.trim()) {
  emitWorkloadResult({
    ok: false,
    suite: 'cpu-node',
    reason: 'gap',
    error: 'node binary not found in PATH — cannot spawn fixture',
    meta: { fixtureVersion: process.env.BENCH_FIXTURE_VERSION },
  });
  process.exit(0);
}

// Run the fixture directly. The fixture handles its own --iterations.
// Increased to 64 (vs the default 32) to give a wider distribution without
// blowing past the suite's 5-minute wall-clock ceiling on slow providers.
const result = spawnSync(
  'node',
  [path.join(FIXTURE_ROOT, 'src', 'index.js'), '--iterations', '64'],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
);
const wallMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);

if (result.error) {
  emitWorkloadResult({
    ok: false,
    suite: 'cpu-node',
    reason: 'error',
    error: `fixture spawn failed: ${result.error.message}`,
    meta: { fixtureVersion: process.env.BENCH_FIXTURE_VERSION, workloadMs: wallMs },
  });
  process.exit(0);
}

if (typeof result.status === 'number' && result.status !== 0) {
  emitWorkloadResult({
    ok: false,
    suite: 'cpu-node',
    reason: 'error',
    error: `fixture exited ${result.status}: ${(result.stderr || '').slice(0, 500)}`,
    meta: { fixtureVersion: process.env.BENCH_FIXTURE_VERSION, workloadMs: wallMs },
  });
  process.exit(0);
}

let totalMs = wallMs;
let notes = undefined;
try {
  const stats = JSON.parse(fs.readFileSync(ARTIFACTS_FILE, 'utf8'));
  if (typeof stats.totalMs === 'number' && stats.totalMs > 0) {
    totalMs = stats.totalMs;
  } else {
    notes = 'fixture artifact missing totalMs; falling back to harness wall-clock';
  }
} catch (err) {
  notes = `fixture artifact unreadable: ${err && err.message ? err.message : String(err)}; falling back to harness wall-clock`;
}

emitWorkloadResult({
  ok: true,
  suite: 'cpu-node',
  metric: { value: totalMs, unit: 'ms', higherIsBetter: false },
  meta: {
    fixtureVersion: process.env.BENCH_FIXTURE_VERSION,
    workloadMs: wallMs,
    iterationsReported: 64,
  },
  ...(notes ? { notes } : {}),
});
process.exit(0);
