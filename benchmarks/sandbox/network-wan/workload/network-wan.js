'use strict';

/**
 * In-sandbox workload for `hpc-network-wan`.
 *
 * WAN throughput is impossible to control without picking a target
 * endpoint, so we hard-code a small set of *static* test objects
 * ("caliper" files) hosted on Cloudflare's CDN plus our own S3 / R2
 * buckets. These objects are published into a known URL for the
 * duration of the run; if they 404 the workload reports a `gap` rather
 * than a false score.
 *
 * The metric is MB/s averaged across 3 sequential downloads of a 10 MB
 * blob (the largest size that fits in a single Cloudflare edge cache
 * tier). Cold + warm are NOT distinguished — this suite measures the
 * steady-state WAN throughput a build pipeline would see, not a CDN
 * edge hit.
 *
 * Calibration target (ceiling): 100 MB/s. Most sandboxes have egress
 * limited to <50 MB/s; e2b/daytona/blaxel/modern providers typically
 * land 50-200 MB/s.
 */

const https = require('node:https');
const http = require('node:http');
const { emitWorkloadResult } = require('./stdout.js');

const TARGETS = [
  {
    label: 'cloudflare-10mb',
    url: 'https://speed.cloudflare.com/__down?bytes=10485760',
    expectedBytes: 10_485_760,
    timeoutMs: 30_000,
  },
  {
    label: 'compute-s3-10mb',
    // Static asset we own. Update or remove if the bucket is gone.
    url: 'https://computesdk-datasets.s3.us-east-1.amazonaws.com/hpc/10mb.bin',
    expectedBytes: 10_485_760,
    timeoutMs: 30_000,
  },
];

function fetchOnce(target) {
  return new Promise((resolve, reject) => {
    const lib = target.url.startsWith('https') ? https : http;
    const req = lib.get(target.url, res => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${target.url}`));
        return;
      }
      let received = 0;
      res.on('data', chunk => { received += chunk.length; });
      res.on('end', () => resolve({ bytes: received, statusCode: res.statusCode || 0 }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(target.timeoutMs, () => req.destroy(new Error(`timeout after ${target.timeoutMs}ms`)));
  });
}

async function downloadWithRetry(target, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchOnce(target);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function run() {
  // Test reachability once; if all targets fail, fall back to gap so we
  // don't poison the leaderboard with `0` MB/s scores.
  const reachable = [];
  for (const target of TARGETS) {
    try {
      const r = await downloadWithRetry(target, 1);
      if (r.bytes >= target.expectedBytes * 0.9) {
        reachable.push(target);
      }
    } catch (_err) {
      // skip
    }
  }

  if (reachable.length === 0) {
    emitWorkloadResult({
      ok: false,
      suite: 'network-wan',
      reason: 'gap',
      error: 'no static WAN test endpoints reachable from this sandbox; skip rather than poison leaderboard',
      meta: {
        providerNotes: `targets tried: ${TARGETS.map(t => t.label).join(', ')}`,
      },
    });
    process.exit(0);
  }

  // Pick the first reachable target as primary; record all measured rates
  // in `meta.providerNotes`.
  const primary = reachable[0];
  const measurements = [];
  const startTotal = process.hrtime.bigint();
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const r = await downloadWithRetry(primary, 1);
    const ns = Number(process.hrtime.bigint() - t0);
    measurements.push({ run: i + 1, bytes: r.bytes, ms: ns / 1e6, mbps: r.bytes / (1024 * 1024) / (ns / 1e9) });
  }
  const totalNs = Number(process.hrtime.bigint() - startTotal);
  const totalBytes = measurements.reduce((s, m) => s + m.bytes, 0);
  const avgMbps = totalBytes / (1024 * 1024) / (totalNs / 1e9);

  emitWorkloadResult({
    ok: true,
    suite: 'network-wan',
    metric: { value: avgMbps, unit: 'mb_per_s', higherIsBetter: true },
    meta: {
      iterationsReported: measurements.length,
      providerNotes: `${primary.label}: ${measurements.map(m => `${m.mbps.toFixed(1)}MB/s`).join(', ')} (avg ${avgMbps.toFixed(1)}MB/s)`,
    },
  });
  process.exit(0);
}

run().catch(err => {
  emitWorkloadResult({
    ok: false,
    suite: 'network-wan',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: {},
  });
  process.exit(0);
});
