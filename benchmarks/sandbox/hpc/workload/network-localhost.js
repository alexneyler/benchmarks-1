'use strict';

/**
 * In-sandbox workload for `hpc-network-localhost`.
 *
 * Pure Node HTTP loopback. We bind an `http.Server` on an ephemeral port
 * then run a `request()` GET against `localhost:<port>` repeatedly while
 * streaming a fixed 4 MiB payload back. The metric is the bytes-per-second
 * diameter of the loopback network stack (loopback in most Linux configs
 * adds virtual NIC overhead; on gVisor-backed microVMs this is often
 * gated by IPC path rather than memory copy).
 *
 * Calibration target (ceiling): 5 GB/s. Pure socket back-and-forth at
 * 4 MiB payloads typically tops out around 8 GB/s on native Linux (the
 * loopback BW ceiling). 5 GB/s is a sane "near-perfect" floor.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const { emitWorkloadResult } = require('./stdout.js');

const PAYLOAD_BYTES = 4 * 1024 * 1024;       // 4 MiB per request
const REQUESTS = 64;                         // 64 × 4 MiB = 256 MiB transferred

function makePayloadBuffer() {
  return crypto.randomFillSync(Buffer.alloc(PAYLOAD_BYTES));
}

function startServer(payload) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Drain request then write a single Content-Length response.
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(payload.length),
        });
        res.end(payload);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('server failed to bind'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function onceServerReady(server, port) {
  return new Promise(resolve => {
    const probe = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET' },
      res => {
        res.resume();
        res.on('end', () => resolve(undefined));
      },
    );
    probe.on('error', () => resolve(undefined));
    probe.end();
  });
}

async function run() {
  const payload = makePayloadBuffer();
  const { server, port } = await startServer(payload);

  try {
    // One warm-up request to make sure the server is fully accepting and
    // the listener is in EPOLLEXCLUSIVE / direct accept state. Discard.
    await onceServerReady(server, port);

    const start = process.hrtime.bigint();
    let totalBytes = 0;
    for (let i = 0; i < REQUESTS; i++) {
      await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/', method: 'GET' },
          res => {
            let received = 0;
            res.on('data', chunk => { received += chunk.length; });
            res.on('end', () => { totalBytes += received; resolve(undefined); });
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end();
      });
    }
    const ns = Number(process.hrtime.bigint() - start);

    // Each byte we received was sent by the server AND received by us, so
    // the bytes-per-second is approximately 2× totalBytes / seconds.
    const seconds = ns / 1e9;
    const bytesPerSec = (totalBytes * 2) / seconds;
    const gbPerSec = bytesPerSec / (1024 * 1024 * 1024);

    emitWorkloadResult({
      ok: true,
      suite: 'network-localhost',
      metric: { value: gbPerSec, unit: 'gb_per_s', higherIsBetter: true },
      meta: {
        iterationsReported: REQUESTS,
        providerNotes: `${REQUESTS} \u00d7 ${PAYLOAD_BYTES / 1024} KiB loopback requests in ${seconds.toFixed(2)} s`,
      },
    });
  } finally {
    server.close();
  }
  process.exit(0);
}

run().catch(err => {
  emitWorkloadResult({
    ok: false,
    suite: 'network-localhost',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: {},
  });
  process.exit(0);
});
