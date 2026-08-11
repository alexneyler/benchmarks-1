/**
 * Types for the browser concurrent sessions benchmark.
 *
 * Each "round" creates N browser sessions in parallel, waits for all to be
 * alive + connected (barrier), runs a fixed 10-action loop on every session
 * simultaneously, then releases all. The runner's `--iterations` controls how
 * many rounds execute; the custom `--concurrency-level` flag (parsed from
 * argv, like storage's `--file-size`) controls N — the number of sessions
 * active at the same time.
 *
 * Results are organized by concurrency level, mirroring the storage
 * benchmark's per-file-size directories:
 *
 *   results/browser-concurrent/c1/latest.json   (baseline, 1 session at a time)
 *   results/browser-concurrent/c5/latest.json   (5 sessions concurrently)
 *   results/browser-concurrent/c10/latest.json  (10 sessions concurrently)
 *   results/browser-concurrent/c25/latest.json  (25 sessions concurrently)
 *   results/browser-concurrent/c50/latest.json  (50 sessions concurrently)
 */

/** How many times the fixed action loop repeats within a single session. */
export const LOOPS_PER_SESSION = 1;
/** Number of discrete actions in one loop (matches throughput benchmark). */
export const ACTIONS_PER_LOOP = 10;
/** Total actions a session runs end-to-end. */
export const ACTIONS_PER_SESSION = LOOPS_PER_SESSION * ACTIONS_PER_LOOP;

export type ActionType = 'navigate' | 'waitForSelector' | 'screenshot' | 'textContent' | 'click' | 'goBack';

export const ACTION_TYPES: ActionType[] = [
  'navigate',
  'waitForSelector',
  'screenshot',
  'textContent',
  'click',
  'goBack',
];

/** Concurrency levels sweeped for the degradation curve. */
export const CONCURRENCY_LEVELS = [1, 5, 10, 25, 50] as const;
export type ConcurrencyLevel = (typeof CONCURRENCY_LEVELS)[number];

export interface ActionResult {
  /** 1-based index of the action within the session (1-10) */
  index: number;
  type: ActionType;
  durationMs: number;
  success: boolean;
  error?: string;
}

/** Per-session timing data collected during one barrier round. */
export interface SessionResult {
  /** Provider session ID */
  sessionId: string;
  /** Time to create this session in ms (parallel with N-1 others) */
  createMs: number;
  /** Time to CDP-connect this session in ms */
  connectMs: number;
  /** Sum of action durations for this session */
  taskMs: number;
  /** How many of 10 actions succeeded */
  actionsCompleted: number;
  /** actionsCompleted / (taskMs / 1000) */
  actionsPerSecond: number;
  /** Per-action results, in order */
  actions: ActionResult[];
  /** Error message if this session failed before actions */
  error?: string;
}

/** Per-round (one barrier protocol execution) timing data. */
export interface RoundResult {
  /** How many sessions were attempted (= concurrency level) */
  sessionsAttempted: number;
  /** How many sessions survived create + connect */
  sessionsAlive: number;
  /** Wall clock to create all N sessions in parallel */
  createMs: number;
  /** Wall clock to CDP-connect all N sessions in parallel */
  connectMs: number;
  /** Wall clock for all N action loops to complete in parallel */
  taskMs: number;
  /** Wall clock to release all N sessions in parallel */
  releaseMs: number;
  /** Total round wall clock */
  totalMs: number;
  /** Aggregate actions/sec across all N sessions */
  aggregateActionsPerSecond: number;
  /** Per-session results */
  sessions: SessionResult[];
  /** Error message if the entire round failed */
  error?: string;
}

export interface ConcurrentStatsTriple {
  median: number;
  p95: number;
  p99: number;
}

export interface ConcurrentStats {
  /** Sessions alive per round */
  sessionsAlive: ConcurrentStatsTriple;
  /** Parallel create wall clock */
  createMs: ConcurrentStatsTriple;
  /** Parallel connect wall clock */
  connectMs: ConcurrentStatsTriple;
  /** Parallel action loop wall clock */
  taskMs: ConcurrentStatsTriple;
  /** Aggregate actions/sec across all sessions */
  actionsPerSecond: ConcurrentStatsTriple;
  /** Per-session actions/sec (the degradation signal) */
  perSessionActionsPerSecond: ConcurrentStatsTriple;
  /** Per-action-type stats, aggregated across all sessions in all rounds */
  perActionType: Record<ActionType, ConcurrentStatsTriple>;
}

export interface ConcurrentBenchmarkResult {
  provider: string;
  mode: 'browser-concurrent';
  /** Concurrency level (N sessions per round) */
  concurrencyLevel: number;
  /** Barrier rounds executed */
  rounds: RoundResult[];
  summary: ConcurrentStats;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface ConcurrentProviderConfig {
  name: string;
  iterations?: number;
  timeout?: number;
  requiredEnvVars: string[];
  createBrowserProvider: () => any;
  sessionCreateOptions?: Record<string, unknown>;
}
