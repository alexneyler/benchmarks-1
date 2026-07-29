'use strict';

/**
 * In-sandbox workload for `hpc-dns`.
 *
 * Node `dns.resolve4` over a fixed set of well-known authoritative
 * domains. Captures end-to-end DNS lookup latency (resolver cache miss
 * + UDP round-trip + response). Median over 3 lookups per domain.
 *
 * Calibration target (ceiling): 500 ms. From a Cloudflare edge the
 * median is usually <20 ms; from a customer's home broadband it can
 * regularly exceed 100 ms on a cold resolver.
 */

const dns = require('node:dns').promises;

const { emitWorkloadResult } = require('./stdout.js');

const TARGETS = [
  'cloudflare.com',
  'github.com',
  'npmjs.com',
  'registry.npmjs.org',
  'compute-sdk.com',
];

async function probe(label) {
  const t0 = process.hrtime.bigint();
  try {
    await dns.resolve4(label, { ttl: true });
  } catch (err) {
    return { label, error: err && err.message ? err.message : String(err) };
  }
  return { label, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

async function run() {
  const measurements = [];
  for (const target of TARGETS) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const r = await probe(target);
      if (!r.error) runs.push(r.ms);
    }
    if (runs.length === 0) {
      measurements.push({ label: target, error: 'all 3 lookups failed' });
    } else {
      runs.sort((a, b) => a - b);
      measurements.push({ label: target, ms: runs[Math.floor(runs.length / 2)] });
    }
  }

  const ok = measurements.filter(m => !m.error);
  if (ok.length === 0) {
    emitWorkloadResult({
      ok: false,
      suite: 'dns',
      reason: 'gap',
      error: 'no DNS lookup succeeded from this sandbox',
      meta: { providerNotes: measurements.map(m => `${m.label}: ${m.error}`).join(' ') },
    });
    process.exit(0);
  }

  const mean = ok.reduce((s, m) => s + m.ms, 0) / ok.length;

  emitWorkloadResult({
    ok: true,
    suite: 'dns',
    metric: { value: mean, unit: 'ms', higherIsBetter: false },
    meta: {
      iterationsReported: ok.length,
      providerNotes: ok.map(m => `${m.label}=${m.ms.toFixed(1)}ms`).join(' '),
    },
  });
  process.exit(0);
}

run().catch(err => {
  emitWorkloadResult({
    ok: false,
    suite: 'dns',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: {},
  });
  process.exit(0);
});
