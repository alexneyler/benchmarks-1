'use strict';

/**
 * Deterministic compute fixture for `hpc-cpu-node` and `hpc-realworld`.
 *
 * The fixture deliberately mixes four workload shapes the way a real
 * Node-tooling project would:
 *
 *   1. JSON shapes/parse a 2 MB synthetic AST (~50k nodes).
 *   2. SHA-256/keccak-class hashing of 64 MB input blocks.
 *   3. Regex/walk over an LCG-generated text corpus (~1 MB).
 *   4. A tight numeric loop (sum-of-primes up to 5e6).
 *
 * All four phases run a configurable `iterations` of times; the default
 * (32) is sized so a current-generation Linux container takes roughly
 * 5–15 s. The output line reports the total wall-clock (ms) the harness
 * reads as the suite metric.
 *
 * Pure stdlib — no `node_modules`, no native bindings, runs identically on
 * any Node 18+ sandbox regardless of provider.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const v = process.argv[idx + 1];
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

const iterations = readArg('--iterations', 32);
const blockBytes = readArg('--block-bytes', 1024 * 1024); // 1 MiB
const blockCount = readArg('--block-count', 64);
const astDepth = readArg('--ast-depth', 7);

// ---- Phase 1: JSON round-trip cost ---------------------------
function makeAst(depth) {
  if (depth === 0) return { kind: 'leaf', value: 'x', pos: 0, parent: null };
  return {
    kind: 'branch',
    children: Array.from({ length: 5 }, (_, i) => {
      const c = makeAst(depth - 1);
      c.parent = { idx: i, depth };
      c.pos = i;
      return c;
    }),
    pos: depth,
  };
}

function phase1(iters) {
  let total = 0;
  for (let i = 0; i < iters; i++) {
    const ast = makeAst(astDepth);
    const ser = JSON.stringify(ast);
    const parsed = JSON.parse(ser);
    total += parsed.children.length;
  }
  return total;
}

// ---- Phase 2: crypto throughput -----------------------------
function phase2(iters, bytesPerBlock, blocks) {
  let totalBytes = 0;
  const buf = crypto.randomFillSync(Buffer.alloc(bytesPerBlock));
  for (let i = 0; i < iters; i++) {
    for (let b = 0; b < blocks; b++) {
      const h = crypto.createHash('sha256');
      h.update(buf);
      h.digest();
      totalBytes += bytesPerBlock;
    }
  }
  return totalBytes;
}

// ---- Phase 3: regex + text walk -----------------------------
function makeCorpus(bytes) {
  const rng = (() => {
    let s = 0x12345678;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  })();
  const words = ['module', 'export', 'class', 'function', 'const', 'return', 'await',
    'async', 'throw', 'import', 'from', 'with', 'yield', 'new', 'extends'];
  const out = [];
  let acc = '';
  const target = bytes;
  while (acc.length < target) {
    const w = words[Math.floor(rng() * words.length)];
    acc += w + ' ';
    if (rng() < 0.05) {
      out.push(acc);
      acc = '';
    }
  }
  if (acc.length) out.push(acc);
  return out.join('\n');
}

function phase3(iters, bytes) {
  const corpus = makeCorpus(Math.max(64 * 1024, bytes));
  const patterns = [
    /function\s+\w+/g,
    /class\s+\w+\s+extends\s+\w+/g,
    /\bawait\s+\w+/g,
    /\bimport\s+.*?from\s+/g,
  ];
  let totalMatches = 0;
  for (let i = 0; i < iters; i++) {
    for (const pat of patterns) {
      pat.lastIndex = 0;
      const m = corpus.match(pat);
      if (m) totalMatches += m.length;
    }
  }
  return totalMatches;
}

// ---- Phase 4: numeric loop ----------------------------------
function sumOfPrimes(limit) {
  let total = 0;
  for (let n = 2; n <= limit; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) {
      if (n % d === 0) { prime = false; break; }
    }
    if (prime) total += n;
  }
  return total;
}

function phase4(iters) {
  let checksum = 0;
  for (let i = 0; i < iters; i++) checksum += sumOfPrimes(5_000_000);
  return checksum;
}

// ---- Driver --------------------------------------------------
const t0 = process.hrtime.bigint();
const phase1_iters = Math.max(1, Math.floor(iterations / 4));
const phase2_iters = Math.max(1, Math.floor(iterations / 8));
const phase3_iters = Math.max(1, Math.floor(iterations / 4));
const phase4_iters = Math.max(1, Math.floor(iterations / 4));

const p1 = phase1(phase1_iters);
const p2 = phase2(phase2_iters, blockBytes, blockCount);
const p3 = phase3(phase3_iters, 256 * 1024);
const p4 = phase4(phase4_iters);
const totalNs = process.hrtime.bigint() - t0;
const totalMs = Number(totalNs / 1_000_000n);

// Mirror what `tree -L 1` would print so a generic filesystem probe can pick up
// disk shape deterministically. This is what real CI runners honour via
// `Run.diskAfter`: not the empty state when the benchmark ends.
const artifactDir = path.join(process.cwd(), '.hpc-fixture-artifacts');
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(path.join(artifactDir, 'last.json'), JSON.stringify({
  iterations,
  totalMs,
  phases: { json: phase1_iters, crypto: phase2_iters, regex: phase3_iters, primes: phase4_iters },
  checksums: { p1, p2, p3, p4 },
}));

// The fixture itself never emits a WorkloadResult — the harness wrapper
// (`workload/cpu-node.js`) reads totalMs from this script via an env var or
// by inspecting the .hpc-fixture-artifacts/last.json we just wrote. Keeping
// the contract simple: just write the JSON file and exit 0.
process.exit(0);
