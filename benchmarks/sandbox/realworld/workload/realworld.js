'use strict';

/**
 * In-sandbox workload for `hpc-realworld`.
 *
 * Mimics the upstream benchmark's "realworld" phase. The pipeline we run
 * measures what a "clone + npm install + build + test" round-trip looks
 * like when expressed in pure-Node primitives that don't depend on the
 * configured heap ceiling:
 *
 *   1. Cold extract of the cpu-node fixture tree into a fresh temp dir
 *      (modelling `git clone + tar -xzf` cost on networked sandbox disk).
 *   2. Two identical "build" passes that combine (a) writing a 4 MiB file
 *      with random bytes to disk, (b) hashing it 16× with SHA-256,
 *      (c) repeating it with random content each pass. This is the same
 *      disk+crypto+iteration shape a Jest + tsc + webpack run produces.
 *   3. Sum wall-clock; spec is total ms (lower is better, ceiling 180 s).
 *
 * Compared to cpu-node this also surfaces the cost of the in-sandbox
 * tar+extract step (which some ComputeSDK providers back with networked
 * disk, making the "clone" rate-limited).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { emitWorkloadResult } = require('./stdout.js');

const BUNDLE_FIXTURE_ROOT = process.env.BENCH_FIXTURE_ROOT || '/tmp/bench/fixture';

function freshExtractRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hpc-realworld-'));
}

function extractStage(bundleRoot, destRoot) {
  // The bundle IS the unpacked fixture (cpu-node's payload). We use
  // `cp -a` to clone every file into a fresh temp tree, modelling the
  // same disk pressure as a tar -xzf on a real cold clone. This is
  // faster than re-tar+re-extract, but still isolates disk-write
  // through the boundary the way a real provider's `git clone` would.
  const t0 = process.hrtime.bigint();
  const cp = spawnSync('cp', ['-a', `${bundleRoot}/.`, destRoot], { stdio: 'pipe' });
  const ns = Number(process.hrtime.bigint() - t0);
  if (cp.status !== 0) {
    throw new Error(`cp stage failed: ${cp.stderr ? cp.stderr.toString() : 'no stderr'}`);
  }
  return ns;
}

function buildPass(workdir, passIdx) {
  // ~"npm install" + "tsc + jest" compressed into disk-write + crypto
  // round-trips. The 4 MiB blob is large enough to escape the
  // benchmark's page cache entirely, giving a steady write+read shape
  // that mirrors a JS bundler linker step.
  const file = path.join(workdir, `pass-${passIdx}.bin`);
  const buf = crypto.randomFillSync(Buffer.alloc(4 * 1024 * 1024));
  const t0 = process.hrtime.bigint();

  fs.writeFileSync(file, buf);
  // 16 SHA-256 chains of the freshly-written file mimic a build-time
  // content hashing step (Webpack, Rollup, esbuild — all of them).
  const data = fs.readFileSync(file);
  for (let h = 0; h < 16; h++) {
    crypto.createHash('sha256').update(data).digest();
  }

  return Number(process.hrtime.bigint() - t0);
}

async function run() {
  const extractRoot = freshExtractRoot();
  try {
    const extractNs = extractStage(BUNDLE_FIXTURE_ROOT, extractRoot);

    const buildNs = buildPass(extractRoot, 0) + buildPass(extractRoot, 1);
    const totalMs = (extractNs + buildNs) / 1e6;

    emitWorkloadResult({
      ok: true,
      suite: 'realworld',
      metric: { value: totalMs, unit: 'ms', higherIsBetter: false },
      meta: {
        iterationsReported: 2,
        providerNotes: `extract=${(extractNs / 1e6).toFixed(0)}ms build2x=${(buildNs / 1e6).toFixed(0)}ms total=${totalMs.toFixed(0)}ms`,
      },
    });
  } finally {
    try { fs.rmSync(extractRoot, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
  }
  process.exit(0);
}

run().catch(err => {
  emitWorkloadResult({
    ok: false,
    suite: 'realworld',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: {},
  });
  process.exit(0);
});

