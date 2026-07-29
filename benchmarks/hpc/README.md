# HPC Benchmarks

> Inspired by and modeled after the [HPC Sandbox Benchmarks](https://github.com/starslingdev/hpc-sandbox-benchmarks) by [starsling.dev](https://starsling.dev). The suite structure, scoring approach, and workload dimensions follow their design. This implementation is built from scratch in pure Node.js with no upstream code dependency.

Throughput-after-boot benchmarks that measure raw hardware performance inside ComputeSDK sandboxes. Each suite runs a self-contained Node.js workload script inside a fresh sandbox, captures one numeric metric, and scores it against a calibration ceiling on a 0-100 scale.

## What these benchmarks test

The HPC suites answer a different question than the TTI (time-to-first-command) benchmarks: **not "how fast does the sandbox boot?"** but **"how fast does the sandbox compute once it's running?"**

A provider with excellent cold-start performance can still have poor CPU throughput, limited memory bandwidth, slow disk I/O, or a constrained network position. The HPC suites expose those dimensions so that users picking a ComputeSDK provider for compute-heavy workloads (build pipelines, data processing, embedded databases) can compare them on a level playing field.

## The 11 suites

### cpu-node

Runs a vendored Node.js fixture through four phases that mirror a real `tsc + webpack + jest` build pipeline:

1. **JSON AST round-trip** — builds a 5^7-node synthetic AST (~78k objects), `JSON.stringify`s it, then `JSON.parse`s the result. Exercises V8's object allocator, string serializer, and parser.
2. **SHA-256 hashing** — hashes a 1 MiB buffer 64 times. Exercises `crypto` throughput (native OpenSSL binding).
3. **Regex + text walk** — generates a 256 KiB synthetic code corpus via an LCG, then runs 4 regex patterns over it. Exercises V8's Irregexp engine.
4. **Prime sieve** — sums all primes up to 5,000,000. Exercises tight integer loop performance and JIT branch prediction.

**Metric:** total wall-clock (ms, lower is better). **Ceiling:** 60,000 ms.
**What it reveals:** overall CPU + JIT performance. A sandbox with 0.5 vCPU will take 3-4x longer than one with 4 vCPU. Providers that throttle CPU after boot score poorly here.

### memory

STREAM-like memory bandwidth probe using `Float64Array`. Runs four classic STREAM phases over a 64 MiB working set:

- **Copy:** `b[i] = a[i]`
- **Scale:** `b[i] = a[i] * scalar`
- **Add:** `c[i] = a[i] + b[i]`
- **Triad:** `c[i] = a[i] + b[i] * scalar`

Reports the geometric mean of the four bandwidths.

**Metric:** MB/s (higher is better). **Ceiling:** 50,000 MB/s.
**What it reveals:** memory bandwidth per core. Sandboxes on shared-memory hypervisors or ARM Graviton instances score lower than dedicated x86 cores. The 64 MiB working set is large enough to blow L2/L3 cache, so this measures DRAM-to-register bandwidth, not cache hit rate.

### system

SQLite speedtest via `sql.js` (WASM-compiled SQLite). Runs 3 phases x 3 rounds x 5,000 INSERT/SELECT/UPDATE/DELETE operations against an in-memory database.

**Metric:** operations/sec (higher is better). **Ceiling:** 100,000 ops/s.
**What it reveals:** WASM execution speed and the overhead of the sandbox's virtualization layer. gVisor-backed sandboxes add syscall interception overhead that shows up clearly here. Pure-WASM SQLite on native x86 typically hits 150-250k ops/s; throttled containers land under 80k.

### disk

Three-phase disk throughput test on a 64 MiB file:

1. **Sequential write** — 1 MiB chunks via `fs.writeFile`
2. **Sequential read** — same file read back in 1 MiB chunks
3. **Random write** — 4,096 x 4 KiB writes at random offsets

Reports the weighted average: `(write + read + 2 x randomWrite) / 4`.

**Metric:** MB/s (higher is better). **Ceiling:** 200 MB/s.
**What it reveals:** whether the sandbox's filesystem is tmpfs-backed (scores 500+ MB/s, hits ceiling), local SSD (200-500 MB/s), or networked storage like S3/EBS (50-150 MB/s). The random-write phase is weighted double because it's the phase that most differentiates storage backends.

### network-localhost

Pure Node.js HTTP loopback. Binds an `http.Server` on an ephemeral port, then fires 64 x 4 MiB GET requests against `localhost:<port>`. Reports total bytes transferred per second.

**Metric:** GB/s (higher is better). **Ceiling:** 5 GB/s.
**What it reveals:** the loopback bandwidth of the sandbox's virtual network stack. Native Linux loopback typically does 8+ GB/s; gVisor and other userspace network stacks add IPC overhead that caps this at 1-3 GB/s. This is a proxy for inter-process communication overhead inside the sandbox.

### network-wan

Downloads a 10 MB static blob from a CDN endpoint (Cloudflare or S3) with 3 retries. Reports average MB/s across 3 sequential downloads.

**Metric:** MB/s (higher is better). **Ceiling:** 100 MB/s.
**What it reveals:** egress bandwidth from the sandbox to the public internet. Sandboxes in well-connected datacenters (Cloudflare Workers, e2b) typically see 100-200 MB/s; regional VPS providers may see 20-50 MB/s. Gaps (score 0) if no endpoint is reachable, which itself is a signal about the sandbox's network policy.

### pgbench

Embedded Postgres via `@electric-sql/pglite` (WASM-compiled Postgres). Runs a scaled-down pgbench workload:

- Schema setup + bulk INSERT of 10,000 accounts
- 4 x 2,000 read-write transactions (UPDATE + SELECT + INSERT per tx)
- Reports transactions-per-second

**Metric:** TPS (higher is better). **Ceiling:** 5,000 TPS.
**What it reveals:** database transaction throughput under WASM. pglite typically lands 1,000-3,000 TPS on modern x86. This suite is the most CPU-intensive of the 11 and is sensitive to both vCPU count and WASM execution overhead. Providers that throttle CPU see TPS drop proportionally.

### realworld

Models a `git clone + npm install + build` round-trip using pure-Node primitives:

1. **Cold extract** — `cp -a` the fixture tree into a fresh temp directory (models `git clone` disk pressure)
2. **Build pass 1 + 2** — write a 4 MiB random file, hash it 16x with SHA-256, repeat with fresh random content

**Metric:** total wall-clock (ms, lower is better). **Ceiling:** 180,000 ms.
**What it reveals:** the combined cost of disk writes, crypto throughput, and process spawning inside the sandbox. Unlike `cpu-node` which is purely CPU-bound, `realworld` mixes disk I/O with compute, so it surfaces providers where disk is the bottleneck (networked storage, throttled I/O).

### latency

TLS handshake probes to 3 public endpoints (Cloudflare 1.1.1.1, Google, GitHub raw) x 3 retries each. Times each `tls.connect` `secureConnect` event. Reports the median RTT across all successful probes.

**Metric:** rtt_ms (lower is better). **Ceiling:** 500 ms.
**What it reveals:** the sandbox's network distance to the public internet. Edge-adjacent sandboxes (Cloudflare, Vercel) see <10 ms; regional datacenters see 20-80 ms; sandboxes behind NAT or in remote regions can see 150-300 ms. Gaps if all probes fail, which indicates a restrictive network policy.

### dns

`dns.resolve4` over 5 fixed domains (cloudflare.com, github.com, npmjs.com, registry.npmjs.org, compute-sdk.com) x 3 lookups each. Reports the mean latency.

**Metric:** ms (lower is better). **Ceiling:** 500 ms.
**What it reveals:** DNS resolver performance. Sandboxes that use a local resolver cache score <1 ms; sandboxes that hit an upstream resolver see 5-50 ms. DNS latency compounds in build pipelines that fetch many packages, so a slow resolver can add seconds to `npm install` even when bandwidth is high.

### download

Downloads a 1 MB CDN blob 3 times. Distinct from `network-wan` (10 MB): `download` measures per-call overhead rather than sustained throughput. The 1 MB size is representative of individual package downloads in a build pipeline.

**Metric:** MB/s (higher is better). **Ceiling:** 100 MB/s.
**What it reveals:** the gap between sustained throughput (`network-wan`) and per-call throughput. A sandbox with 200 MB/s on 10 MB but only 25 MB/s on 1 MB has high per-connection overhead (TLS handshake, TCP slow start). This is the metric that most directly predicts `npm install` wall-clock for small-package projects.

## Scoring

### Ceiling-based normalization

Each suite has a **calibration ceiling** — the value at which the score hits 0. This normalizes heterogeneous units (ms, MB/s, TPS) into a single 0-100 scale.

- **Lower is better** (ms, rtt_ms): `score = 100 x (1 - value / ceiling)`, clamped [0, 100]
- **Higher is better** (MB/s, GB/s, TPS, ops/s): `score = 100 x (value / ceiling)`, clamped [0, 100]

### Composite score

The **composite score** multiplies the metric score by the **success rate** (`successful replicates / total replicates`). A provider that runs 2/3 replicates at score 80 gets `80 x 0.667 = 53.3`, not 80. This penalizes flaky providers — a sandbox that crashes 1 out of 3 times is not a good compute platform even when it works.

### Outlier handling

A 2-sigma trim removes values more than 2 standard deviations from the mean before computing the median. At R=3 (dev/smoke) this is conservative (keeps at least 1 sample); at R=12 (nightly) it filters outliers more aggressively. The trim is single-pass (does not recompute after removal) which is sufficient for the replicate counts in use.

## Architecture

```
run.ts (CLI dispatch)
  └── runHpcBenchmark()          orchestrator (benchmark.ts)
        ├── provider.createCompute()
        ├── compute.sandbox.create()
        ├── buildSingleCommand()  writes scripts via heredoc + runs node
        ├── sandbox.runCommand()  single call: upload + execute
        ├── parseWorkloadResult() parses last JSON line from stdout
        └── sandbox.destroy()
```

### Single-command upload pattern

The orchestrator writes the workload script, the `stdout.js` helper, and any bundle (fixture archive, sql.js WASM, pglite) into the sandbox via a **single `runCommand` call** that uses shell heredocs.

For large bundles (sql.js at 333 KB, pglite at 9.5 MB), the bundle is uploaded separately via chunked base64 heredocs (60 KB per chunk) before the main command runs. The main command then just does `tar -xzf` on the pre-uploaded bundle.

### Workload contract

Every workload script is a pure CommonJS `.js` file (no TypeScript, no transpile step — sandboxes don't have `tsx`). It does its work, then calls `emitWorkloadResult()` from `stdout.js` which writes a single JSON line as the last line of stdout. The orchestrator's `parseWorkloadResult()` scans stdout backward for the first parseable JSON line matching the suite ID.

### Bundles

| Bundle kind | Size | Suites | Contents |
|-------------|------|---------|----------|
| `none` | 0 | memory, disk, network-*, latency, dns, download | No bundle needed |
| `fixture-archive` | 2.8 KB | cpu-node, realworld | Vendored Node.js fixture (package.json, src/index.js, BENCH_VERSION.txt) |
| `sql-wasm` | 333 KB | system | sql.js package + sql-wasm.wasm |
| `pglite` | 9.5 MB | pgbench | @electric-sql/pglite package |

Bundles are built by `pnpm run build:hpc-bundles` and stored in `dist/hpc-bundles/`. The CI workflow runs this step before the matrix.

## Running

### Local smoke test (no cloud)

```bash
pnpm run hpc:smoke -- --suite=cpu-node
pnpm run hpc:smoke -- --suite=all
```

Runs all workloads locally (no sandbox creation, no ComputeSDK). Validates that each workload script emits a parseable `WorkloadResult` and that scoring works. This is the fastest dev signal.

### Single provider via CLI

```bash
pnpm run bench -- --provider e2b --mode hpc-cpu-node --hpc-replicas 3
```

Runs one suite against one provider at R=3. Requires the provider's API keys to be in the environment.

### All suites for one provider

```bash
pnpm run bench -- --provider e2b --mode hpc-all --hpc-replicas 3
```

### CI workflow (GitHub Actions)

The workflow at `.github/workflows/bench-hpc.yml` runs weekly (Friday 00:00 UTC) across all 23 ComputeSDK providers x 11 suites at R=3. Manual dispatch supports comma-separated provider and suite filters:

```bash
gh workflow run bench-hpc.yml --ref master \
  -f replicas=1 \
  -f provider="e2b,daytona,modal" \
  -f suite_id="cpu-node"
```

### Unit tests

```bash
pnpm run test:hpc
```

29 tests covering scoring (ceiling normalization, 2-sigma trim, composite score with success rate), parse-stdout (backward JSON scan, malformed input, missing suite ID), and registry (suite coverage, workload script existence).

## Results

Results land in `results/hpc_<suite>/latest.json` with the following shape per provider:

```json
{
  "provider": "modal",
  "suite": "cpu-node",
  "compositeScore": 30.9,
  "summary": {
    "median": 41436,
    "p95": 41436,
    "p99": 41436,
    "successRate": 1.0,
    "n": 1
  },
  "iterations": [...],
  "wallClockMs": 42089
}
```

SVG charts are generated by `pnpm run generate-hpc-svg`:
- `hpc_<suite>.svg` — horizontal bar chart per suite, one bar per provider
- `hpc_all.svg` — cross-provider x cross-suite leaderboard grid with mean composite per provider

The CI `collect` job regenerates these SVGs after every run and commits them back to the repo on schedule triggers.

## File layout

```
benchmarks/hpc/
  benchmark.ts          orchestrator: sandbox lifecycle + upload + parse
  generate-svg.ts       per-suite bar charts + leaderboard grid
  providers.ts          pass-through to sandbox/providers.ts
  registry.ts           11 suite definitions (ceiling, unit, bundle, timeout)
  scoring.ts            ceiling normalization + 2-sigma trim + composite score
  types.ts              HpcSuite, WorkloadResult, HpcStats, HpcBenchmarkResult
  stdout.js             CJS helper: emitWorkloadResult (last JSON line on stdout)
  fixtures/
    node-tooling/       vendored fixture for cpu-node + realworld
  workload/
    cpu-node.js         spawn fixture, read wall-clock from artifact JSON
    memory.js           STREAM Copy/Scale/Add/Triad over 64 MiB Float64Array
    system.js           sql.js SQLite speedtest (INSERT/SELECT/UPDATE/DELETE)
    disk.js             sequential + random 64 MiB file I/O
    network-localhost.js  HTTP loopback 64 x 4 MiB
    network-wan.js      10 MB CDN download x 3
    pgbench.js          pglite embedded Postgres TPS
    realworld.js        cold extract + 2x build passes (disk + crypto)
    latency.js          TLS handshake RTT to 3 public endpoints
    dns.js              dns.resolve4 over 5 domains x 3
    download.js         1 MB CDN download x 3
  util/
    parse-stdout.ts     backward JSON line scanner
    upload-bundle.ts    bundle path + fixture version helpers
  __tests__/
    scoring.test.ts     6 tests
    parse-stdout.test.ts  10 tests
    registry.test.ts    13 tests
```
