/**
 * Types for the HPC (throughput-after-boot) benchmark mode.
 *
 * Each HPC suite runs a single in-sandbox workload script and reads back one
 * numeric value per fresh sandbox. Suites are the dimensions we measure
 * (cpu-node, memory, disk, network, …); the per-suite `ceiling` lets us turn
 * the heterogeneous unit (ms vs MB/s vs …) into a comparable 0–100 score.
 */

export type HpcUnit =
  | 'ms' // time / latency (lower is better)
  | 'mb_per_s' // throughput (higher is better)
  | 'gb_per_s' // throughput (higher is better)
  | 'iops' // IOPS (higher is better)
  | 'tps' // transactions/sec (higher is better)
  | 'rtt_ms' // round-trip time (lower is better)
  | 'ops_per_s'; // operations/sec (higher is better)

export type HpcSuiteId =
  | 'cpu-node'
  | 'memory'
  | 'system'
  | 'disk'
  | 'network-localhost'
  | 'network-wan'
  | 'pgbench'
  | 'realworld'
  | 'latency'
  | 'dns'
  | 'download';

export const HPC_SUITE_IDS: readonly HpcSuiteId[] = [
  'cpu-node',
  'memory',
  'system',
  'disk',
  'network-localhost',
  'network-wan',
  'pgbench',
  'realworld',
  'latency',
  'dns',
  'download',
] as const;

/**
 * Bundle uploaded alongside the in-sandbox script.
 *
 * - `none`: no bundle (default for scripts that only need Node)
 * - `fixture-archive`: tarball of benchmarks/sandbox/hpc/fixtures/node-tooling
 *   (used by both cpu-node and realworld — realworld adds cold clone + extract)
 * - `sql-wasm`: WASM SQLite (system suite)
 * - `pglite`: packed pglite (pgbench suite)
 */
export type HpcBundleKind = 'none' | 'fixture-archive' | 'sql-wasm' | 'pglite';

export interface HpcSuite {
  id: HpcSuiteId;
  label: string;
  unit: HpcUnit;
  higherIsBetter: boolean;
  /** Score=0 when value == ceiling. Score=100 at zero (or higher-is-better floors). */
  ceiling: number;
  /** Replicas for dev (`--hpc-replicas`, default 3). Tier shift for nightly sets this higher. */
  defaultReplicas: number;
  /** Relative path under benchmarks/sandbox/hpc/workload/ that implements the suite. */
  workloadPath: string;
  /** Hard wall-clock timeout per replicate. */
  timeoutMs: number;
  bundle: HpcBundleKind;
  /** Skip if this precondition isn't met (recorded as a gap, not a failure). */
  gapIf?: string[];
}

export interface WorkloadMeta {
  cpuCount?: number;
  memoryMb?: number;
  /** `benchmarks/sandbox/hpc/fixtures/node-tooling/BENCH_VERSION.txt` when a fixture is involved. */
  fixtureVersion?: string;
  /** Wall-clock inside the sandbox as observed by the workload. */
  workloadMs?: number;
  iterationsReported?: number;
  providerNotes?: string;
}

/** Discriminated union emitted by every workload as the last stdout line. */
export type WorkloadResult =
  | {
      ok: true;
      suite: HpcSuiteId;
      metric: { value: number; unit: HpcUnit; higherIsBetter: boolean };
      meta: WorkloadMeta;
      notes?: string;
    }
  | {
      ok: false;
      suite: HpcSuiteId;
      reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
      error?: string;
      meta: WorkloadMeta;
    };

/** Stats aggregate over replicates. */
export interface HpcStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  /** 0–100 score against `suite.ceiling`. */
  scoreBeforeReliability: number;
  /** `scoreBeforeReliability * successRate`, rounded to one decimal. */
  compositeScore: number;
  meta: WorkloadMeta;
}

export interface HpcBenchmarkResult {
  provider: string;
  suite: HpcSuiteId;
  mode: 'hpc';
  iterations: WorkloadResult[];
  summary: HpcStats;
  /** Wall-clock of the whole `runHpcBenchmark` call in ms (excludes shell setup). */
  wallClockMs: number;
  /** Per-replicate wall-clock excluding sandbox create/destroy. */
  replicateMs: number[];
  /** `compositeScore` returned here for symmetry with other modes. */
  compositeScore: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface HpcRunMeta {
  /** CLI parallelism (ignored for now — replicates run sequentially per suite provider cell). */
  generateSweepKey: () => string;
  /** Fixture version observed at the start of the run, used to tag every result. */
  fixtureVersion: string;
}
