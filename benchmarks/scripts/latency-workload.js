'use strict';

/**
 * In-sandbox workload for `hpc-latency`.
 *
 * Pure-Node TCP+TLS RTT probe. We open a `tls.connect` to a fixed set of
 * public endpoints and time each `secureConnect` event. Median across all
 * probes is the metric (single outlier doesn't poison the score).
 *
 * Targets are stable, absolute RPS endpoints (Cloudflare 1.1.1.1 DNS over
 * HTTPS, Google JSON metadata, and a GitHub raw endpoint). They are NOT
 * iperf targets — this measures what the sandbox sees from itself, with
 * real CLOSE-PCAP-style moments (DNS + TCP + TLS handshake).
 *
 * Calibration target (ceiling): 500 ms. From a Cloudflare edge datacenter
 * the median is usually <80 ms; from a private VPS in a remote region it
 * can easily exceed 200 ms.
 */

const tls = require('node:tls');

const { emitWorkloadResult } = require('./stdout.js');

const TARGETS = [
  { host: 'one.one.one.one', port: 443, label: 'cloudflare-1111' },
  { host: 'www.google.com', port: 443, label: 'google-front' },
  { host: 'raw.githubusercontent.com', port: 443, label: 'github-raw' },
];

function probeRTT(target) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const sock = tls.connect({ host: target.host, port: target.port, servername: target.host, ALPNProtocols: ['http/1.1'] }, () => {
      const ns = Number(process.hrtime.bigint() - t0);
      sock.end();
      resolve(ns);
    });
    sock.on('error', err => {
      sock.destroy();
      reject(err);
    });
    // Hard timeout so a half-open TCP doesn't hang the whole suite.
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error(`probe timeout: ${target.label}`));
    });
  });
}

async function run() {
  const measurements = [];
  for (const target of TARGETS) {
    try {
      for (let i = 0; i < 3; i++) {
        const ns = await probeRTT(target);
        measurements.push({ label: target.label, ms: ns / 1e6 });
      }
    } catch (err) {
      measurements.push({ label: target.label, error: err && err.message ? err.message : String(err) });
    }
  }

  const ok = measurements.filter(m => !m.error);
  if (ok.length === 0) {
    emitWorkloadResult({
      ok: false,
      suite: 'latency',
      reason: 'gap',
      error: 'no TCP+TLS probe reached any endpoint from this sandbox',
      meta: { providerNotes: measurements.map(m => `${m.label}: ${m.error ?? m.ms.toFixed(1) + 'ms'}`).join(' ') },
    });
    process.exit(0);
  }

  const sorted = ok.map(m => m.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  emitWorkloadResult({
    ok: true,
    suite: 'latency',
    metric: { value: median, unit: 'rtt_ms', higherIsBetter: false },
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
    suite: 'latency',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: {},
  });
  process.exit(0);
});
