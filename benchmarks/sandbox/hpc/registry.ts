import type { HpcSuite, HpcSuiteId, HpcBundleKind } from './types.js';

/**
 * Static registry of every HPC suite. To add a suite:
 *   1. Drop a workload script at benchmarks/sandbox/hpc/workload/<id>.ts exporting {@link HpcWorkloadRun}.
 *   2. Append an entry below.
 *   3. Add an SCript in package.json's bench:hpc:<id>.
 *   4. Update README / METHODOLOGY.
 *
 * The ceiling numbers are CALIBRATION targets — they bound the worst-case score to 0.
 * They are deliberately generous; the first nightly pass will be used to tighten them
 * from observed data.
 */
const SUITES: HpcSuite[] = [
  {
    id: 'cpu-node',
    label: 'CPU — node-web-tooling build',
    unit: 'ms',
    higherIsBetter: false,
    ceiling: 60_000,
    defaultReplicas: 3,
    workloadPath: 'workload/cpu-node.js',
    timeoutMs: 5 * 60_000,
    bundle: 'fixture-archive',
  },
  {
    id: 'memory',
    label: 'Memory bandwidth',
    unit: 'mb_per_s',
    higherIsBetter: true,
    ceiling: 50_000,
    defaultReplicas: 3,
    workloadPath: 'workload/memory.js',
    timeoutMs: 60_000,
    bundle: 'none',
  },
  {
    id: 'system',
    label: 'System — SQLite speedtest',
    unit: 'ops_per_s',
    higherIsBetter: true,
    ceiling: 100_000,
    defaultReplicas: 3,
    workloadPath: 'workload/system.js',
    timeoutMs: 2 * 60_000,
    bundle: 'sql-wasm',
  },
  {
    id: 'disk',
    label: 'Disk throughput',
    unit: 'mb_per_s',
    higherIsBetter: true,
    ceiling: 200,
    defaultReplicas: 3,
    workloadPath: 'workload/disk.js',
    timeoutMs: 90_000,
    bundle: 'none',
  },
  {
    id: 'network-localhost',
    label: 'Network — localhost loopback',
    unit: 'gb_per_s',
    higherIsBetter: true,
    ceiling: 5,
    defaultReplicas: 3,
    workloadPath: 'workload/network-localhost.js',
    timeoutMs: 30_000,
    bundle: 'none',
  },
  {
    id: 'network-wan',
    label: 'Network — WAN download',
    unit: 'mb_per_s',
    higherIsBetter: true,
    ceiling: 100,
    defaultReplicas: 3,
    workloadPath: 'workload/network-wan.js',
    timeoutMs: 60_000,
    bundle: 'none',
  },
  {
    id: 'pgbench',
    label: 'Database — pgbench (pglite)',
    unit: 'tps',
    higherIsBetter: true,
    ceiling: 5_000,
    defaultReplicas: 3,
    workloadPath: 'workload/pgbench.js',
    timeoutMs: 5 * 60_000,
    bundle: 'pglite',
  },
  {
    id: 'realworld',
    label: 'Realworld — cold install + build',
    unit: 'ms',
    higherIsBetter: false,
    ceiling: 180_000,
    defaultReplicas: 1,
    workloadPath: 'workload/realworld.js',
    timeoutMs: 10 * 60_000,
    bundle: 'fixture-archive',
  },
  {
    id: 'latency',
    label: 'Network — edge RTT probe',
    unit: 'rtt_ms',
    higherIsBetter: false,
    ceiling: 500,
    defaultReplicas: 3,
    workloadPath: 'workload/latency.js',
    timeoutMs: 20_000,
    bundle: 'none',
  },
  {
    id: 'dns',
    label: 'DNS resolution probe',
    unit: 'ms',
    higherIsBetter: false,
    ceiling: 500,
    defaultReplicas: 3,
    workloadPath: 'workload/dns.js',
    timeoutMs: 20_000,
    bundle: 'none',
  },
  {
    id: 'download',
    label: 'Static download probe',
    unit: 'mb_per_s',
    higherIsBetter: true,
    ceiling: 100,
    defaultReplicas: 3,
    workloadPath: 'workload/download.js',
    timeoutMs: 30_000,
    bundle: 'none',
  },
];

export const HPC_SUITES: ReadonlyMap<HpcSuiteId, HpcSuite> = new Map(
  SUITES.map(s => [s.id, s] as const),
);

export function getSuite(id: HpcSuiteId): HpcSuite {
  const suite = HPC_SUITES.get(id);
  if (!suite) {
    throw new Error(`Unknown HPC suite: ${id}`);
  }
  return suite;
}

export function getSuiteIds(): HpcSuiteId[] {
  return Array.from(HPC_SUITES.keys());
}

export function getWorkloadBundle(id: HpcSuiteId): HpcBundleKind {
  return HPC_SUITES.get(id)?.bundle ?? 'none';
}
