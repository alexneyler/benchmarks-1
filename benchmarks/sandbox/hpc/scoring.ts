import type { HpcStats, HpcSuite, WorkloadResult } from './types.js';
import { percentile } from '../../src/util/stats.js';

/**
 * Compute median/min/max/p95/p99/score for a single suite+provider cell.
 *
 * Outlier handling: more aggressive than the TTI trim (5/5% each tail) because
 * HPC replicates run R=3 in dev, so dropping the bottom and top 1 (≈17% each
 * tail) gives the median reasonable robustness without going to R=12 nightly.
 * If 2σ trim leaves < 1 sample, we keep the raw median rather than splitting.
 */
export function computeHpcStats(results: WorkloadResult[], suite: HpcSuite): HpcStats {
  const successful = results.filter(isOk);
  const ok = successful.length;
  const total = results.length;

  if (ok === 0) {
    return {
      median: 0,
      p95: 0,
      p99: 0,
      min: 0,
      max: 0,
      successRate: 0,
      n: 0,
      scoreBeforeReliability: 0,
      compositeScore: 0,
      meta: lastMeta(results) ?? {},
    };
  }

  const values = successful.map(r => r.metric.value);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  const trimmed = stripOutliersBySigma(sorted, 2);
  const statsValues = trimmed.length >= 1 ? trimmed : sorted;

  const p95 = percentile(statsValues, 95);
  const p99 = percentile(statsValues, 99);

  return {
    median,
    p95,
    p99,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    successRate: ok / total,
    n: ok,
    scoreBeforeReliability: scoreMetric(median, suite),
    compositeScore: round1(scoreMetric(median, suite) * (ok / total)),
    meta: lastMeta(successful) ?? {},
  };
}

/**
 * Score a single value against the suite's calibration ceiling.
 *
 * For lower-is-better units (ms, rtt_ms): `100 × (1 − value/ceiling)`.
 * For higher-is-better units (mb/s, gb/s, iops, tps, ops/s): `100 × (value/ceiling)`.
 * Clamped to [0, 100] — values past the ceiling score 0, not negative.
 */
export function scoreMetric(value: number, suite: HpcSuite): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ratio = suite.higherIsBetter ? value / suite.ceiling : 1 - value / suite.ceiling;
  return clamp(ratio * 100, 0, 100);
}

function isOk(r: WorkloadResult): r is Extract<WorkloadResult, { ok: true }> {
  return r.ok === true;
}

function lastMeta(results: WorkloadResult[]) {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].meta) return results[i].meta;
  }
  return undefined;
}

/**
 * Drop values outside `sigma` standard deviations of the trimmed mean.
 *
 * Single-pass — does not recompute after removal, which is fine at R=3 because
 * the inner sigma is meaningless with n=1; we just keep at least one sample.
 */
function stripOutliersBySigma(sorted: number[], sigma: number): number[] {
  if (sorted.length < 4) return sorted;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return sorted;
  const lo = mean - sigma * sd;
  const hi = mean + sigma * sd;
  const trimmed = sorted.filter(v => v >= lo && v <= hi);
  return trimmed.length >= 1 ? trimmed : sorted;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
