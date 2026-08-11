import {
  ACTIONS_PER_SESSION,
  type ConcurrentBenchmarkResult,
  type ConcurrentStatsTriple,
} from './concurrent-types.js';

export interface ConcurrentScoringWeights {
  createMedian: number;
  taskMedian: number;
  taskP95: number;
  screenshotMedian: number;
  perSessionApsMedian: number;
}

export const DEFAULT_CONCURRENT_WEIGHTS: ConcurrentScoringWeights = {
  createMedian: 0.30,        // provisioning under load
  taskMedian: 0.25,          // per-round task time under load
  taskP95: 0.20,             // tail consistency under load
  screenshotMedian: 0.15,    // vision-agent proxy under load
  perSessionApsMedian: 0.10, // per-session throughput under load
};

/** Linear score for actions/sec — 10 actions/sec saturates at 100. */
const APS_CEILING = 10;
/** Latency ceiling in ms — anything >= this scores 0. */
const LATENCY_CEILING_MS = 30_000;

function scoreThroughput(actionsPerSecond: number): number {
  if (!Number.isFinite(actionsPerSecond) || actionsPerSecond <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (actionsPerSecond / APS_CEILING)));
}

function scoreLatency(valueMs: number): number {
  if (!Number.isFinite(valueMs)) return 0;
  return Math.max(0, 100 * (1 - valueMs / LATENCY_CEILING_MS));
}

/**
 * Compute the success rate for a concurrent benchmark result (0 to 1).
 *
 * A session counts as successful iff it completed all ACTIONS_PER_SESSION
 * actions without error. Partial completions still contribute timing data but
 * are not counted as full successes.
 */
export function computeConcurrentSuccessRate(result: ConcurrentBenchmarkResult): number {
  if (result.skipped || result.rounds.length === 0) return 0;
  let totalSessions = 0;
  let fullySuccessful = 0;
  for (const round of result.rounds) {
    for (const session of round.sessions) {
      totalSessions++;
      if (!session.error && session.actionsCompleted === ACTIONS_PER_SESSION) {
        fullySuccessful++;
      }
    }
  }
  return totalSessions > 0 ? fullySuccessful / totalSessions : 0;
}

function computeConcurrentScore(
  result: ConcurrentBenchmarkResult,
  weights: ConcurrentScoringWeights = DEFAULT_CONCURRENT_WEIGHTS,
): number {
  const screenshotMedian = result.summary.perActionType.screenshot?.median ?? 0;
  return (
    weights.createMedian * scoreLatency(result.summary.createMs.median) +
    weights.taskMedian * scoreLatency(result.summary.taskMs.median) +
    weights.taskP95 * scoreLatency(result.summary.taskMs.p95) +
    weights.screenshotMedian * scoreLatency(screenshotMedian) +
    weights.perSessionApsMedian * scoreThroughput(result.summary.perSessionActionsPerSecond.median)
  );
}

/**
 * Compute composite scores for all concurrent results and attach them.
 *
 * Formula: compositeScore = concurrentScore × successRate
 */
export function computeConcurrentCompositeScores(
  results: ConcurrentBenchmarkResult[],
  weights: ConcurrentScoringWeights = DEFAULT_CONCURRENT_WEIGHTS,
): void {
  for (const result of results) {
    const successRate = computeConcurrentSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const baseScore = computeConcurrentScore(result, weights);
    result.compositeScore = Math.round(baseScore * successRate * 100) / 100;
  }
}

/**
 * Sort concurrent benchmark results by composite score (highest first).
 * Skipped providers are always last.
 */
export function sortConcurrentByCompositeScore(
  results: ConcurrentBenchmarkResult[],
): ConcurrentBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
