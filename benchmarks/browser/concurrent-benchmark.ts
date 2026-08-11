/**
 * Concurrent benchmark result summarization + legacy JSON writer.
 * Mirrors throughput-benchmark.ts but works with rounds (barrier protocol
 * executions) instead of individual sessions.
 */
import {
  ACTION_TYPES,
  ACTIONS_PER_SESSION,
  type ActionType,
  type ConcurrentBenchmarkResult,
  type ConcurrentStats,
  type ConcurrentStatsTriple,
  type RoundResult,
  type SessionResult,
  type ActionResult,
} from './concurrent-types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

function computeStats(values: number[]): ConcurrentStatsTriple {
  if (values.length === 0) return { median: 0, p95: 0, p99: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.05);
  const trimmed = trimCount > 0 && sorted.length - 2 * trimCount > 0
    ? sorted.slice(trimCount, sorted.length - trimCount)
    : sorted;

  const mid = Math.floor(trimmed.length / 2);
  const median = trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid];

  return {
    median,
    p95: percentile(trimmed, 95),
    p99: percentile(trimmed, 99),
  };
}

/**
 * Summarize rounds into aggregate stats. Per-action-type stats are computed
 * across all sessions in all rounds — this is the degradation signal.
 */
export function summarizeRounds(rounds: RoundResult[]): ConcurrentStats {
  const createValues = rounds.map(r => r.createMs).filter(v => v > 0);
  const connectValues = rounds.map(r => r.connectMs).filter(v => v > 0);
  const taskValues = rounds.map(r => r.taskMs).filter(v => v > 0);
  const sessionsAliveValues = rounds.map(r => r.sessionsAlive).filter(v => v > 0);
  const aggregateApsValues = rounds.map(r => r.aggregateActionsPerSecond).filter(v => v > 0);

  // Per-session APS across all rounds
  const perSessionApsValues: number[] = [];
  for (const round of rounds) {
    for (const session of round.sessions) {
      if (session.actionsPerSecond > 0) perSessionApsValues.push(session.actionsPerSecond);
    }
  }

  // Per-action-type stats across all sessions in all rounds
  const perActionType = {} as Record<ActionType, ConcurrentStatsTriple>;
  for (const type of ACTION_TYPES) {
    const values: number[] = [];
    for (const round of rounds) {
      for (const session of round.sessions) {
        for (const a of session.actions) {
          if (a.type === type && a.success) values.push(a.durationMs);
        }
      }
    }
    perActionType[type] = computeStats(values);
  }

  return {
    sessionsAlive: computeStats(sessionsAliveValues),
    createMs: computeStats(createValues),
    connectMs: computeStats(connectValues),
    taskMs: computeStats(taskValues),
    actionsPerSecond: computeStats(aggregateApsValues),
    perSessionActionsPerSecond: computeStats(perSessionApsValues),
    perActionType,
  };
}

export function emptySummary(): ConcurrentStats {
  const empty: ConcurrentStatsTriple = { median: 0, p95: 0, p99: 0 };
  const perActionType = {} as Record<ActionType, ConcurrentStatsTriple>;
  for (const t of ACTION_TYPES) perActionType[t] = { ...empty };
  return {
    sessionsAlive: { ...empty },
    createMs: { ...empty },
    connectMs: { ...empty },
    taskMs: { ...empty },
    actionsPerSecond: { ...empty },
    perSessionActionsPerSecond: { ...empty },
    perActionType,
  };
}

function roundStats(s: ConcurrentStatsTriple): ConcurrentStatsTriple {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export async function writeConcurrentResultsJson(
  results: ConcurrentBenchmarkResult[],
  outPath: string,
  options: { concurrencyLevel?: number; timeoutMs?: number } = {},
): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    concurrencyLevel: r.concurrencyLevel,
    rounds: r.rounds.map(round => ({
      sessionsAttempted: round.sessionsAttempted,
      sessionsAlive: round.sessionsAlive,
      createMs: roundNum(round.createMs),
      connectMs: roundNum(round.connectMs),
      taskMs: roundNum(round.taskMs),
      releaseMs: roundNum(round.releaseMs),
      totalMs: roundNum(round.totalMs),
      aggregateActionsPerSecond: roundNum(round.aggregateActionsPerSecond),
      sessions: round.sessions.map(s => ({
        sessionId: s.sessionId,
        createMs: roundNum(s.createMs),
        connectMs: roundNum(s.connectMs),
        taskMs: roundNum(s.taskMs),
        actionsCompleted: s.actionsCompleted,
        actionsPerSecond: roundNum(s.actionsPerSecond),
        actions: s.actions.map(a => ({
          index: a.index,
          type: a.type,
          durationMs: roundNum(a.durationMs),
          success: a.success,
          ...(a.error ? { error: a.error } : {}),
        })),
        ...(s.error ? { error: s.error } : {}),
      })),
      ...(round.error ? { error: round.error } : {}),
    })),
    summary: {
      sessionsAlive: roundStats(r.summary.sessionsAlive),
      createMs: roundStats(r.summary.createMs),
      connectMs: roundStats(r.summary.connectMs),
      taskMs: roundStats(r.summary.taskMs),
      actionsPerSecond: roundStats(r.summary.actionsPerSecond),
      perSessionActionsPerSecond: roundStats(r.summary.perSessionActionsPerSecond),
      perActionType: Object.fromEntries(
        ACTION_TYPES.map(t => [t, roundStats(r.summary.perActionType[t])]),
      ),
    },
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const rounds = results.reduce((max, r) => Math.max(max, r.rounds.length), 0);

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      concurrencyLevel: options.concurrencyLevel ?? results[0]?.concurrencyLevel ?? 0,
      rounds,
      actionsPerSession: ACTIONS_PER_SESSION,
      timeoutMs: options.timeoutMs ?? 120_000,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}

function roundNum(n: number): number {
  return Math.round(n * 100) / 100;
}
