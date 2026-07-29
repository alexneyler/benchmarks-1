/**
 * Types for the cpu-node benchmark.
 *
 * Runs a single in-sandbox workload script and reads back one numeric
 * value per fresh sandbox. The ceiling turns the unit into a 0-100 score.
 */

export type SuiteUnit = 'ms';

export type SuiteId = 'cpu-node';

export type BundleKind = 'none' | 'fixture-archive';

export interface SuiteConfig {
  id: SuiteId;
  label: string;
  unit: SuiteUnit;
  higherIsBetter: boolean;
  ceiling: number;
  defaultReplicas: number;
  workloadPath: string;
  timeoutMs: number;
  bundle: BundleKind;
}

export const SUITE_CONFIG: SuiteConfig = {
  id: 'cpu-node',
  label: "CPU — node-web-tooling build",
  unit: 'ms',
  higherIsBetter: false,
  ceiling: 45000,
  defaultReplicas: 3,
  workloadPath: 'workload/cpu-node.js',
  timeoutMs: 300000,
  bundle: 'fixture-archive',
};

export interface WorkloadMeta {
  cpuCount?: number;
  memoryMb?: number;
  fixtureVersion?: string;
  workloadMs?: number;
  iterationsReported?: number;
  providerNotes?: string;
}

export type WorkloadResult =
  | {
      ok: true;
      suite: SuiteId;
      metric: { value: number; unit: SuiteUnit; higherIsBetter: boolean };
      meta: WorkloadMeta;
      notes?: string;
    }
  | {
      ok: false;
      suite: SuiteId;
      reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
      error?: string;
      meta: WorkloadMeta;
    };

export interface SuiteStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  compositeScore: number;
  meta: WorkloadMeta;
}

export interface BenchmarkResult {
  provider: string;
  suite: SuiteId;
  mode: 'cpu-node';
  iterations: WorkloadResult[];
  summary: SuiteStats;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  skipped?: boolean;
  skipReason?: string;
}
