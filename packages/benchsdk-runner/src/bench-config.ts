/**
 * A `*.bench.ts` file is the composition of a **config** and a **task**:
 *
 *   export const config = defineBenchmarkConfig({ benchmarkSlug, iterations, ... });
 *   export default defineTask(async (ctx) => { await ctx.step('work', () => ...); });
 *
 * `defineBenchmarkConfig` holds the orchestration knobs; `defineTask` holds the
 * workload. The runner (see runner.ts) turns that pair into platform runs.
 * There is no "mode": all orchestration shapes emerge from the knobs.
 *
 *   iterations       total tasks to run (default 1)
 *   concurrency      max tasks in flight at once — 1 = sequential, N = burst (default 1)
 *   staggerDelayMs   delay each task's start by taskIndex * staggerDelayMs (default 0)
 *
 * Common shapes:
 *   sequential  { iterations: N, concurrency: 1 }
 *   burst       { iterations: N, concurrency: N }
 *   staggered   { iterations: N, concurrency: N, staggerDelayMs: 200 }
 *
 * A task is comprised of steps. The primary way to declare steps is `ctx.step`
 * inside a task function — it supports closures, conditionals and try/finally,
 * so values (a created sandbox, say) flow naturally between steps. For simple
 * benchmarks whose steps are independent, `defineTask` also accepts a
 * `defineStep[]` array (see defineTask below).
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

/**
 * What a task returns: whatever it measured itself. This replaces the
 * assumption that the framework owns all timing. A plain data payload is
 * written explicitly as `{ data: {...} }`.
 */
export interface TaskResult {
  /** Free-form domain payload attached to the record (tokens, receipts, ...). */
  data?: JsonObject;
  /**
   * Pre-measured steps the task timed itself (e.g. socket phases).
   * Only honored in `groupBy: 'round'` runs, where the runner builds records
   * manually. In `groupBy: 'participant'` runs the platform worker
   * (`client.runWorker`) owns steps, so `steps` and `latencyMs` are ignored.
   */
  steps?: TaskStepRecord[];
  /** Task-owned overall latency; overrides framework wall-clock (round mode only). */
  latencyMs?: number;
}

/**
 * Throw this from a task to record a failure while preserving domain data and
 * any pre-measured steps (a plain thrown Error loses them).
 */
export class TaskError extends Error {
  readonly code?: string;
  readonly data?: JsonObject;
  readonly steps?: TaskStepRecord[];
  constructor(message: string, opts?: { code?: string; data?: JsonObject; steps?: TaskStepRecord[] }) {
    super(message);
    this.name = 'TaskError';
    this.code = opts?.code;
    this.data = opts?.data;
    this.steps = opts?.steps;
  }
}

/** Context handed to a benchmark `task` for a single iteration. */
export interface TaskContext<T extends BaseParticipant = BaseParticipant> {
  /** The participant this task is running for. */
  participant: T;
  /** Zero-based global task ordinal (matches the platform record's taskIndex). */
  taskIndex: number;
  /** Current phase name, when the benchmark declares `phases`. */
  phase?: string;
  /**
   * Runs `fn` as a named platform step and mirrors its outcome into the
   * per-worker log buffer. Mirrors `@benchsdk/client`'s `RunWorkerContext.step`.
   */
  step<R>(name: string, fn: () => Promise<R> | R, options?: DefineStepOptions): Promise<R>;
}

export type BenchmarkTask<T extends BaseParticipant = BaseParticipant> = (
  ctx: TaskContext<T>,
) => Promise<TaskResult | void> | TaskResult | void;

/**
 * A named run segment with its own iteration count. Phases run in order; each
 * record is tagged with the phase name via `data.phase`, and `ctx.phase` lets
 * the task branch on identity instead of index arithmetic.
 */
export interface Phase {
  /** Phase name, tagged onto every record produced in this phase. */
  name: string;
  /** Iterations to run in this phase. */
  iterations: number;
}

/**
 * Orchestration config for a benchmark. Holds identity + the knobs only — the
 * workload lives in a separate `defineTask` (passed to `runBenchmark`), so the
 * same config shape works for both local runs and `bench deploy`.
 */
export interface BenchmarkConfig<T extends BaseParticipant = BaseParticipant> {
  /** Stable platform slug for this benchmark (e.g. 'sandbox-tti-local'). */
  benchmarkSlug: string;
  /** Human-readable name shown on the platform. */
  benchmarkName: string;
  /** Optional platform benchmark kind (e.g. 'sandbox'). */
  benchmarkKind?: string;
  /**
   * Total tasks to run per participant. Default: 1. Mutually exclusive with
   * `phases` — when `phases` is set, total iterations = sum of phase iterations.
   */
  iterations?: number;
  /**
   * Named run segments (e.g. cold/warm). Runs in order; each record is tagged
   * with the phase name via `data.phase`. Mutually exclusive with `iterations`.
   */
  phases?: Phase[];
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
}

function assertPositiveInt(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer >= 1 (got ${value})`);
  }
}

/** Validates `config` at file-evaluation time so mistakes surface immediately. */
export function defineBenchmarkConfig<T extends BaseParticipant = BaseParticipant>(
  config: BenchmarkConfig<T>,
): BenchmarkConfig<T> {
  if (!config.benchmarkSlug || typeof config.benchmarkSlug !== 'string') {
    throw new Error('benchmarkSlug is required');
  }
  if (!config.benchmarkName || typeof config.benchmarkName !== 'string') {
    throw new Error('benchmarkName is required');
  }
  if (config.phases !== undefined) {
    if (config.iterations !== undefined) {
      throw new Error('phases and iterations are mutually exclusive');
    }
    if (!Array.isArray(config.phases) || config.phases.length === 0) {
      throw new Error('phases must be a non-empty array');
    }
    const seen = new Set<string>();
    for (const phase of config.phases) {
      if (!phase.name || typeof phase.name !== 'string') {
        throw new Error('each phase requires a non-empty name');
      }
      if (seen.has(phase.name)) {
        throw new Error(`duplicate phase name: ${phase.name}`);
      }
      seen.add(phase.name);
      assertPositiveInt(phase.iterations, `phase '${phase.name}' iterations`);
    }
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

/** Shared mutable state threaded across the steps of a single task run. */
export type StepState = Record<string, unknown>;

/** Context handed to each step of an array-form `defineTask`. */
export interface StepContext<T extends BaseParticipant = BaseParticipant, S extends StepState = StepState> {
  /** The participant this task is running for. */
  participant: T;
  /** Zero-based task ordinal within the schedule. */
  taskIndex: number;
  /** Current phase name, when the benchmark declares `phases`. */
  phase?: string;
  /** Per-run mutable bag for passing values between steps of the same task. */
  state: S;
}

/** One named step of an array-form task. Build with {@link defineStep}. */
export interface DefinedStep<T extends BaseParticipant = BaseParticipant, S extends StepState = StepState> {
  name: string;
  options?: DefineStepOptions;
  fn: (ctx: StepContext<T, S>) => Promise<JsonObject | void> | JsonObject | void;
}

/**
 * A benchmark task, normalized to a single function the runner invokes once per
 * iteration. Produced by {@link defineTask} from either a task function or a
 * `defineStep[]` array.
 */
export interface DefinedTask<T extends BaseParticipant = BaseParticipant> {
  run: BenchmarkTask<T>;
}

/**
 * Declares one named step for the array form of {@link defineTask}. `fn` may
 * return a `JsonObject` to merge into the task's `data`, or nothing.
 *
 *   defineStep('upload', () => { ... })
 *   defineStep('upload', { reportConcurrency: false }, () => { ... })
 */
export function defineStep<T extends BaseParticipant = BaseParticipant, S extends StepState = StepState>(
  name: string,
  optionsOrFn: DefineStepOptions | DefinedStep<T, S>['fn'],
  maybeFn?: DefinedStep<T, S>['fn'],
): DefinedStep<T, S> {
  if (name.trim() === '') {
    throw new Error('Benchmark step name must be non-empty.');
  }
  const hasOptions = typeof optionsOrFn !== 'function';
  const fn = hasOptions ? maybeFn : optionsOrFn;
  if (!fn) {
    throw new Error('Benchmark step function is required.');
  }
  return { name, options: hasOptions ? optionsOrFn : undefined, fn };
}

/**
 * Declares the workload for a benchmark. Two forms:
 *
 *   // function form (primary) — steps via `ctx.step`, closures/try-finally OK
 *   export default defineTask(async (ctx) => {
 *     const sandbox = await ctx.step('create', () => provider.create());
 *     try { await ctx.step('exec', () => sandbox.run('node -v')); }
 *     finally { await ctx.step('destroy', () => sandbox.destroy()); }
 *   });
 *
 *   // array form (sugar) — independent steps, values shared via `ctx.state`
 *   export default defineTask([
 *     defineStep('upload', () => s3.upload(file)),
 *   ]);
 *
 * The array form can't pass values between steps with closures — thread them
 * through the shared `state` bag. Anything with real data flow between steps
 * should use the function form.
 */
export function defineTask<T extends BaseParticipant = BaseParticipant, S extends StepState = StepState>(
  taskOrSteps: BenchmarkTask<T> | DefinedStep<T, S>[],
): DefinedTask<T> {
  if (typeof taskOrSteps === 'function') {
    return { run: taskOrSteps };
  }
  const steps = taskOrSteps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('defineTask requires a task function or a non-empty step array.');
  }
  const names = new Set<string>();
  for (const step of steps) {
    if (names.has(step.name)) {
      throw new Error(`Benchmark task step names must be unique. Duplicate step: "${step.name}".`);
    }
    names.add(step.name);
  }
  const run: BenchmarkTask<T> = async (ctx) => {
    const state = {} as S;
    let data: JsonObject | undefined;
    for (const step of steps) {
      const stepData = await ctx.step(
        step.name,
        () => step.fn({ participant: ctx.participant, taskIndex: ctx.taskIndex, phase: ctx.phase, state }),
        step.options,
      );
      if (stepData && typeof stepData === 'object') {
        data = { ...(data ?? {}), ...stepData };
      }
    }
    return data ? { data } : undefined;
  };
  return { run };
}
