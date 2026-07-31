'use strict';

/**
 * In-sandbox workload for the memory benchmark.
 *
 * Pure Node.js (no native deps, no native code) STREAM-style memory
 * bandwidth probe. We run four phases (Copy / Scale / Add / Triad) over
 * fixed-size Float64Array buffers sized so the working set exceeds the
 * Linux page cache on default sandboxes; the metric is the byte-rate
 * averaged across all four phases, reported in MB/s.
 *
 * Calibration target (ceiling): 30000 MB/s. A multi-threaded native
 * STREAM run on modern x86 does ~30 GB/s, but a single-threaded JS loop
 * over typed arrays sits well below 5 GB/s; the ceiling is deliberately
 * generous so a fast JIT tier scores close to 100.
 *
 * Pure CommonJS / Node stdlib — no node_modules, no native bindings,
 * runs identically on any Node 18+ sandbox regardless of provider.
 */

const { emitWorkloadResult } = require('./stdout.js');

const ARRAY_BYTES = 64 * 1024 * 1024;       // 64 MiB working set per buffer
const ELEMENTS = ARRAY_BYTES / 8;           // Float64Array element count
const ITERATIONS_PER_PHASE = 30;

function allocate() {
  return new Float64Array(ELEMENTS);
}

function nowNs() {
  return process.hrtime.bigint();
}

function copyBytesPerSec(a, b) {
  const t0 = nowNs();
  for (let it = 0; it < ITERATIONS_PER_PHASE; it++) {
    b.set(a);                              // Copy: b = a
  }
  const ns = Number(nowNs() - t0);
  return (ITERATIONS_PER_PHASE * ARRAY_BYTES * 2) / (ns / 1e9); // bytes_in + bytes_out
}

function scaleBytesPerSec(a, b, scalar) {
  const t0 = nowNs();
  for (let it = 0; it < ITERATIONS_PER_PHASE; it++) {
    for (let i = 0; i < a.length; i++) b[i] = scalar * a[i];     // Scale: b = scalar * a
  }
  const ns = Number(nowNs() - t0);
  return (ITERATIONS_PER_PHASE * ARRAY_BYTES * 2) / (ns / 1e9);
}

function addBytesPerSec(a, b, c) {
  const t0 = nowNs();
  for (let it = 0; it < ITERATIONS_PER_PHASE; it++) {
    for (let i = 0; i < a.length; i++) c[i] = a[i] + b[i];       // Add: c = a + b
  }
  const ns = Number(nowNs() - t0);
  return (ITERATIONS_PER_PHASE * ARRAY_BYTES * 3) / (ns / 1e9); // reads a,b; writes c
}

function triadBytesPerSec(a, b, c, scalar) {
  const t0 = nowNs();
  for (let it = 0; it < ITERATIONS_PER_PHASE; it++) {
    for (let i = 0; i < a.length; i++) a[i] = b[i] + scalar * c[i]; // Triad: a = b + scalar * c
  }
  const ns = Number(nowNs() - t0);
  return (ITERATIONS_PER_PHASE * ARRAY_BYTES * 3) / (ns / 1e9);
}

function run() {
  const a = allocate();
  const b = allocate();
  const c = allocate();

  // Initialize deterministically (constant pattern; cells stay hot).
  for (let i = 0; i < a.length; i++) {
    a[i] = i * 0.5 + 1;
    b[i] = i * 0.25 + 2;
    c[i] = i * 0.125 + 3;
  }
  const scalar = 0.4;

  // Run each phase once for JIT warm-up; the second pass is what we report
  // so measurements are post-warm-up.
  copyBytesPerSec(a, b);
  scaleBytesPerSec(a, b, scalar);
  addBytesPerSec(a, b, c);
  triadBytesPerSec(a, b, c, scalar);

  const phases = {
    copy: copyBytesPerSec(a, b),
    scale: scaleBytesPerSec(a, b, scalar),
    add: addBytesPerSec(a, b, c),
    triad: triadBytesPerSec(a, b, c, scalar),
  };

  const phaseArr = [phases.copy, phases.scale, phases.add, phases.triad];
  const avg = phaseArr.reduce((s, v) => s + v, 0) / phaseArr.length;
  const avgMbPerSec = avg / (1024 * 1024);

  emitWorkloadResult({
    ok: true,
    suite: 'memory',
    metric: { value: avgMbPerSec, unit: 'mb_per_s', higherIsBetter: true },
    meta: {
      iterationsReported: ITERATIONS_PER_PHASE,
      workloadMs: undefined,
      providerNotes: `phases (bytes/s): copy=${phases.copy.toFixed(0)} scale=${phases.scale.toFixed(0)} add=${phases.add.toFixed(0)} triad=${phases.triad.toFixed(0)}`,
    },
  });
  process.exit(0);
}

try {
  run();
} catch (err) {
  emitWorkloadResult({
    ok: false,
    suite: 'memory',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: { note: 'Possible OOM — 192 MiB allocation may exceed sandbox memory limit' },
  });
  process.exit(0);
}
