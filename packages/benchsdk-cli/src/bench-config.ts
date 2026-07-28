/**
 * Declarative config for a self-contained `*.bench.ts` file. A benchmark
 * declares its identity plus three orchestration knobs and a `task`; the CLI
 * runner (see runner.ts) turns that into platform runs. There is no "mode":
 * all orchestration shapes emerge from the knobs.
 *
 *   iterations       total tasks to run (default 1)
 *   concurrency      max tasks in flight at once — 1 = sequential, N = burst (default 1)
 *   staggerDelayMs   delay each task's start by taskIndex * staggerDelayMs (default 0)
 *
 * Common shapes:
 *   sequential  { iterations: N, concurrency: 1 }
 *   burst       { iterations: N, concurrency: N }
 *   staggered   { iterations: N, concurrency: N, staggerDelayMs: 200 }
 */
import type {
  BaseParticipant,
  DefineStepOptions,
  JsonObject,
  TaskResultRecord,
  TaskStepRecord,
} from '@benchsdk/client';

/** How tasks are ordered across participants. */
export type GroupBy = 'participant' | 'round';

/** Context handed to a benchmark `task` for a single iteration. */
export interface TaskContext<T extends BaseParticipant = BaseParticipant> {
  /** The participant this task is running for. */
  participant: T;
  /** Zero-based index of this task within the run. */
  taskIndex: number;
  /**
   * Runs `fn` as a named platform step and mirrors its outcome into the
   * per-worker log buffer. Mirrors `@benchsdk/client`'s `RunWorkerContext.step`.
   */
  step<R>(name: string, fn: () => Promise<R> | R, options?: DefineStepOptions): Promise<R>;
  /**
   * Attaches a pre-measured step (e.g. socket-phase timings that can't be
   * timed via `step`). Only persisted in `groupBy: 'round'` runs; a no-op in
   * `groupBy: 'participant'` runs, where the platform worker owns step timing.
   */
  recordStep(step: TaskStepRecord): void;
}

export type BenchmarkTask<T extends BaseParticipant = BaseParticipant> = (
  ctx: TaskContext<T>,
) => Promise<JsonObject | void> | JsonObject | void;

export interface BenchmarkConfig<T extends BaseParticipant = BaseParticipant> {
  /** Stable platform slug for this benchmark (e.g. 'sandbox-tti-local'). */
  benchmarkSlug: string;
  /** Human-readable name shown on the platform. */
  benchmarkName: string;
  /** Optional platform benchmark kind (e.g. 'sandbox'). */
  benchmarkKind?: string;
  /** Total tasks to run per participant. Default: 1. */
  iterations?: number;
  /** Max tasks in flight at once. 1 = sequential, N = burst. Default: 1. */
  concurrency?: number;
  /** Delay each task's start by `taskIndex * staggerDelayMs`. Default: 0. */
  staggerDelayMs?: number;
  /**
   * Task ordering across participants. Default: 'participant' (run each
   * participant's tasks to completion, then the next). 'round' takes turns:
   * every participant runs its Nth task before anyone runs their (N+1)th, so
   * all participants' Nth tasks happen back-to-back under the same conditions.
   */
  groupBy?: GroupBy;
  /**
   * Default participant names to run when `--provider` is not passed. Omit to
   * run all env-available participants. `--provider` always overrides this.
   */
  defaultProviders?: string[];
  /**
   * Optional per-record logger, called as each task result finalizes. When
   * omitted the runner prints a generic success/failure line.
   */
  onResult?: (record: TaskResultRecord, meta: { iterations: number }) => void;
  /** The workload run once per task. */
  task: BenchmarkTask<T>;
}

function assertPositiveInt(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer >= 1 (got ${value})`);
  }
}

/** Validates `config` at file-evaluation time so mistakes surface immediately. */
export function defineBenchmark<T extends BaseParticipant = BaseParticipant>(
  config: BenchmarkConfig<T>,
): BenchmarkConfig<T> {
  if (!config.benchmarkSlug || typeof config.benchmarkSlug !== 'string') {
    throw new Error('benchmarkSlug is required');
  }
  if (!config.benchmarkName || typeof config.benchmarkName !== 'string') {
    throw new Error('benchmarkName is required');
  }
  if (typeof config.task !== 'function') {
    throw new Error('task must be a function');
  }
  assertPositiveInt(config.iterations, 'iterations');
  assertPositiveInt(config.concurrency, 'concurrency');
  if (config.staggerDelayMs !== undefined && (!Number.isFinite(config.staggerDelayMs) || config.staggerDelayMs < 0)) {
    throw new Error(`staggerDelayMs must be a number >= 0 (got ${config.staggerDelayMs})`);
  }
  if (config.groupBy !== undefined && config.groupBy !== 'participant' && config.groupBy !== 'round') {
    throw new Error(`groupBy must be 'participant' or 'round' (got ${config.groupBy})`);
  }
  return config;
}
