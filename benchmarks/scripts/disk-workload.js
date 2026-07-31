'use strict';

/**
 * In-sandbox workload for the disk benchmark.
 *
 * Three phases of pre-allocated buffer IO, timed in parallel via fs:
 *
 *   1. Sequential write: one 64 MiB file written in 1 MiB chunks.
 *   2. Sequential read:  the same file read back in 1 MiB chunks.
 *   3. Random write: 4 KiB writes to a 64 MiB file at random offsets.
 *
 * Reported metric: average MB/s across the three phases (random-write
 * weighted at 50%, see averaging rationale in scoring). We deliberately
 * avoid sync I/O so the metric reflects bandwidth-not-latency — most
 * ComputeSDK sandboxes return sub-millisecond per-call latency, which
 * would inflate the score on small-phase benchmarks.
 *
 * Calibration target (ceiling): 2500 MB/s. S3-backed networked disks
 * drop well below this; tmpfs-backed providers trivially clear 5+ GB/s.
 *
 * Pure CommonJS / Node stdlib — no node_modules, no native bindings,
 * runs identically on any Node 18+ sandbox regardless of provider.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { emitWorkloadResult } = require('./stdout.js');

const FILE_BYTES = 64 * 1024 * 1024;        // 64 MiB
const CHUNK_BYTES = 1 * 1024 * 1024;         // 1 MiB chunk size
const RANDOM_BYTES = 4 * 1024;               // 4 KiB random-write unit
const RANDOM_ITERATIONS = 4096;             // 4096 × 4 KiB = 16 MiB

function makeSequentialBuffer() {
  // Random-looking buffer fills the page cache less predictably than a
  // constant bit pattern, so a same-provider repeat doesn't compress.
  return crypto.randomFillSync(Buffer.alloc(CHUNK_BYTES));
}

async function sequentialWrite(filePath, bytes, chunkBytes) {
  const buf = makeSequentialBuffer();
  const writes = Math.ceil(bytes / chunkBytes);
  let written = 0;
  const start = process.hrtime.bigint();
  const handle = await fs.promises.open(filePath, 'w');
  try {
    for (let i = 0; i < writes; i++) {
      await handle.write(buf, 0, chunkBytes);
      written += chunkBytes;
    }
  } finally {
    await handle.close();
  }
  const ns = Number(process.hrtime.bigint() - start);
  const actualBytes = Math.min(written, bytes);
  return { bytes: actualBytes, seconds: ns / 1e9 };
}

async function sequentialRead(filePath, bytes, chunkBytes) {
  const reads = Math.ceil(bytes / chunkBytes);
  let read = 0;
  const start = process.hrtime.bigint();
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(chunkBytes);
    for (let i = 0; i < reads; i++) {
      await handle.read(buf, 0, chunkBytes, i * chunkBytes);
      read += chunkBytes;
    }
  } finally {
    await handle.close();
  }
  const ns = Number(process.hrtime.bigint() - start);
  const actualBytes = Math.min(read, bytes);
  return { bytes: actualBytes, seconds: ns / 1e9 };
}

async function randomWrite(filePath, fileBytes, unitBytes, iterations) {
  const unitBuf = crypto.randomFillSync(Buffer.alloc(unitBytes));
  const start = process.hrtime.bigint();
  const handle = await fs.promises.open(filePath, 'w');
  try {
    for (let i = 0; i < iterations; i++) {
      const offset = Math.floor(Math.random() * ((fileBytes - unitBytes) / unitBytes)) * unitBytes;
      await handle.write(unitBuf, 0, unitBytes, offset);
    }
  } finally {
    await handle.close();
  }
  const ns = Number(process.hrtime.bigint() - start);
  return { bytes: iterations * unitBytes, seconds: ns / 1e9 };
}

function mbPerSec(bytes, seconds) {
  if (seconds <= 0) return 0;
  return bytes / (1024 * 1024) / seconds;
}

async function run() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bench-disk-'));
  const seqFile = path.join(dir, 'seq.bin');

  const w = await sequentialWrite(seqFile, FILE_BYTES, CHUNK_BYTES);
  const r = await sequentialRead(seqFile, FILE_BYTES, CHUNK_BYTES);

  const randomFile = path.join(dir, 'rand.bin');
  const rw = await randomWrite(randomFile, FILE_BYTES, RANDOM_BYTES, RANDOM_ITERATIONS);

  // Best-effort cleanup; ok if this races with sandbox destroy.
  try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }

  const wMb = mbPerSec(w.bytes, w.seconds);
  const rMb = mbPerSec(r.bytes, r.seconds);
  const rwMb = mbPerSec(rw.bytes, rw.seconds);

  // Average read+write throughput; random-write weighed at 50% because
  // a single random-write phase is a 16 MiB sample (smaller than the 64
  // MiB reads/writes) and is dominated by per-call latency on networked
  // disks. Without the discount, the metric would unfairly reward
  // providers with low fsync overhead.
  const avg = (wMb + rMb + rwMb * 2) / 4;

  emitWorkloadResult({
    ok: true,
    suite: 'disk',
    metric: { value: avg, unit: 'mb_per_s', higherIsBetter: true },
    meta: {
      iterationsReported: Math.ceil(FILE_BYTES / CHUNK_BYTES) * 2 + RANDOM_ITERATIONS,
      workloadMs: undefined,
      providerNotes: `seq_w=${wMb.toFixed(1)} seq_r=${rMb.toFixed(1)} rnd_w=${rwMb.toFixed(1)} MB/s`,
    },
  });
  process.exit(0);
}

run().catch(err => {
  emitWorkloadResult({
    ok: false,
    suite: 'disk',
    reason: 'error',
    error: err && err.message ? err.message : String(err),
    meta: {},
  });
  process.exit(0);
});
