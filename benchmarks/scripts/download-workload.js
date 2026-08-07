'use strict';

/**
 * In-sandbox workload for `hpc-download`.
 *
 * Smaller-object focused end-to-end download probe. Distinct from
 * `network-wan` (which uses a 10 MB blob to test sustained throughput):
 * `download` exercises a 1 MB blob three times to measure the per-call
 * overhead that compounds in build pipelines (cargo update, npm install,
 * pip download).
 *
 * Calibration target (ceiling): 100 MB/s. Most sandboxes see 50-200 MB/s
 * per-call egress; the gap between mean and per-call is the metric that's
 * actionable.
 */

const https = require('node:https');

const { emitWorkloadResult } = require('./stdout.js');

const TARGETS = [
  // Owned static asset; remove or update if bucket is decommissioned.
  {
    label: 'compute-s3-1mb',
    url: 'https://computesdk-datasets.s3.us-east-1.amazonaws.com/hpc/1mb.bin',
    expectedBytes: 1_048_576,
  },
  // Cloudflare's CDN serves a 1 MB body from any path.
  {
    label: 'cloudflare-1mb',
    url: 'https://speed.cloudflare.com/__down?bytes=1048576',
    expectedBytes: 1_048_576,
  },
];

function fetchOnce(target) {
  return new Promise((resolve, reject) => {
    const lib = target.url.startsWith('https') ? https : require('node:http');
    const req = lib.get(target.url, res => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${target.url}`));
        return;
      }
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; });
      res.on('end', () => resolve({ bytes, statusCode: res.statusCode || 0 }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
  });
}

async function run() {
  const reachable = [];
  for (const target of TARGETS) {
    try {
      const r = await fetchOnce(target);
      if (r.bytes >= target.expectedBytes * 0.9) {
        reachable.push({ ...target, bytes: r.bytes });
      }
    } catch (_err) {
      // try the next
    }
  }
  if (reachable.length === 0) {
    emitWorkloadResult({
      ok: false,
      suite: 'download',
      reason: 'gap',
      error: 'no static download endpoint reachable',
      meta: { providerNotes: `tried: ${TARGETS.map(t => t.label).join(', ')}` },
    });
    process.exit(0);
  }

  const target = reachable[0];
  const measurements = [];
  const startTotal = process.hrtime.bigint();
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const r = await fetchOnce(target);
    const ns = Number(process.hrtime.bigint() - t0);
    measurements.push({ run: i + 1, ms: ns / 1e6, mbps: r.bytes / (1024 * 1024) / (ns / 1e9) });
  }
  const totalNs = Number(process.hrtime.bigint() - startTotal);
  const totalBytes = measurements.reduce((s, m) => s + target.bytes, 0);
  const avgMbps = totalBytes / (1024 * 1024) / (totalNs / 1e9);

  emitWorkloadResult({
    ok: true,
    suite: 'download',
    metric: { value: avgMbps, unit: 'mb_per_s', higherIsBetter: true },
    meta: {
      iterationsReported: measurements.length,
      providerNotes: `${target.label}: ${measurements.map(m => `${m.mbps.toFixed(1)}MB/s`).join(', ')} (avg ${avgMbps.toFixed(1)}MB/s)`,
    },
  });
  process.exit(0);
}

run().catch(err => {
  emitWorkloadResult({
    ok: false,
    suite: 'download',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: {},
  });
  process.exit(0);
});
