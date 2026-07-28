/**
 * CLI runner for `defineBenchmark` configs. Owns all platform orchestration
 * (upsert benchmark, create run, plan + drive workers per participant) so a
 * `*.bench.ts` file only has to declare its config and task. The orchestration
 * knobs (iterations / concurrency / staggerDelayMs / groupBy) can be overridden
 * per-invocation via CLI flags.
 *
 * Two execution orderings, chosen by `groupBy`:
 *   'participant' (default) — each participant's tasks run to completion via
 *     `client.runWorker` (with its pooled concurrency + heartbeat reporting)
 *     before the next participant starts.
 *   'round' — participants take turns: every participant runs its Nth task
 *     before anyone starts their (N+1)th, so all Nth tasks happen back-to-back
 *     under the same conditions. Driven manually via one `BenchmarkReporter`
 *     per participant.
 */
import {
  BenchmarkReporter,
  createBenchmarkClient,
  filterParticipantsByEnv,
  selectParticipants,
} from '@benchsdk/client';
import type {
  BaseParticipant,
  BenchmarkClient,
  BenchmarkRun,
  JsonObject,
  RunWorkerContext,
  TaskResultRecord,
  TaskStepRecord,
} from '@benchsdk/client';
import type { BenchmarkConfig, GroupBy, TaskContext } from './bench-config.js';
import { LogBuffer, uploadWorkerLog } from './log-buffer.js';
import { loggedStep } from './logged-step.js';

export interface CliArgs {
  iterations?: number;
  concurrency?: number;
  staggerDelayMs?: number;
  groupBy?: GroupBy;
  /** Participant names from `--provider a,b` (repeatable). */
  providers?: string[];
}

export interface ResolvedRunConfig {
  iterations: number;
  concurrency: number;
  staggerDelayMs: number;
  groupBy: GroupBy;
  providers?: string[];
}

const DEFAULT_PLATFORM_URL = 'http://localhost:3000';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'ERROR';
}

function toJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

/**
 * Parses the orchestration flags this runner understands, ignoring anything
 * else. Supports both `--flag value` and `--flag=value`; `--provider` accepts
 * a comma-separated list and may be repeated.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  const readValue = (raw: string, i: number): { value: string; nextIndex: number } => {
    const eq = raw.indexOf('=');
    if (eq !== -1) return { value: raw.slice(eq + 1), nextIndex: i };
    return { value: argv[i + 1] ?? '', nextIndex: i + 1 };
  };

  const numeric = (raw: string, flag: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${flag} expects a number (got "${raw}")`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    switch (name) {
      case '--iterations': {
        const { value, nextIndex } = readValue(arg, i);
        args.iterations = numeric(value, '--iterations');
        i = nextIndex;
        break;
      }
      case '--concurrency': {
        const { value, nextIndex } = readValue(arg, i);
        args.concurrency = numeric(value, '--concurrency');
        i = nextIndex;
        break;
      }
      case '--stagger-delay-ms': {
        const { value, nextIndex } = readValue(arg, i);
        args.staggerDelayMs = numeric(value, '--stagger-delay-ms');
        i = nextIndex;
        break;
      }
      case '--group-by': {
        const { value, nextIndex } = readValue(arg, i);
        if (value !== 'participant' && value !== 'round') {
          throw new Error(`--group-by expects 'participant' or 'round' (got "${value}")`);
        }
        args.groupBy = value;
        i = nextIndex;
        break;
      }
      case '--provider': {
        const { value, nextIndex } = readValue(arg, i);
        const names = value.split(',').map((s) => s.trim()).filter(Boolean);
        args.providers = [...(args.providers ?? []), ...names];
        i = nextIndex;
        break;
      }
      default:
        break;
    }
  }

  return args;
}

/** Merges CLI overrides over config defaults, filling in knob fallbacks. */
export function mergeConfig<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  args: CliArgs,
): ResolvedRunConfig {
  return {
    iterations: args.iterations ?? config.iterations ?? 1,
    concurrency: args.concurrency ?? config.concurrency ?? 1,
    staggerDelayMs: args.staggerDelayMs ?? config.staggerDelayMs ?? 0,
    groupBy: args.groupBy ?? config.groupBy ?? 'participant',
    providers: args.providers ?? config.defaultProviders,
  };
}

type OnResult = (record: TaskResultRecord, meta: { iterations: number }) => void;

function defaultOnResult(record: TaskResultRecord, meta: { iterations: number }): void {
  const n = record.taskIndex + 1;
  if (record.status === 'success') {
    const data = record.data && Object.keys(record.data).length > 0 ? ` ${JSON.stringify(record.data)}` : '';
    console.log(`  Task ${n}/${meta.iterations}: success${data}`);
  } else {
    console.log(`  Task ${n}/${meta.iterations}: FAILED — ${record.errorCode ?? 'unknown error'}`);
  }
}

function resolvePlatform(): { baseUrl: string; orgSlug: string } {
  const root = (process.env.BENCHMARKS_PLATFORM_URL || DEFAULT_PLATFORM_URL).replace(/\/+$/, '');
  return {
    baseUrl: `${root}/api/v1`,
    orgSlug: process.env.BENCHMARKS_PLATFORM_ORG_SLUG || 'computesdk',
  };
}

/**
 * Runs `config` against `participants`. Selects participants by `--provider`
 * (if given), env-gates them, then drives them per the resolved `groupBy`.
 */
export async function runBenchmark<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  participants: T[],
  argv: string[] = [],
): Promise<void> {
  const resolved = mergeConfig(config, parseCliArgs(argv));

  const selected = selectParticipants(participants, resolved.providers);
  const { available, skipped } = filterParticipantsByEnv(selected);

  for (const s of skipped) {
    console.log(`Skipping ${s.name}: missing ${s.missing.join(', ')}`);
  }

  if (available.length === 0) {
    console.error('No participants have their required env vars set — nothing to run.');
    process.exit(1);
    return;
  }

  const { baseUrl, orgSlug } = resolvePlatform();
  const client = createBenchmarkClient({ baseUrl });

  console.log(`${config.benchmarkName} (self-contained)`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(
    `Knobs: iterations=${resolved.iterations}, concurrency=${resolved.concurrency}, ` +
      `staggerDelayMs=${resolved.staggerDelayMs}, groupBy=${resolved.groupBy}\n`,
  );

  await client.upsertBenchmark(config.benchmarkSlug, {
    name: config.benchmarkName,
    ...(config.benchmarkKind ? { kind: config.benchmarkKind } : {}),
  });

  const { run } = await client.createRun(config.benchmarkSlug, {
    name: `${config.benchmarkSlug} — ${resolved.iterations} iterations, concurrency ${resolved.concurrency}`,
    totalTasks: resolved.iterations,
    workerCount: 1,
    participants: available.map((p) => p.name),
  });

  const dashboardUrl = `${baseUrl.replace(/\/api\/v1\/?$/, '')}/${orgSlug}/benchmarks/${config.benchmarkSlug}/runs/${run.id}`;
  console.log(`Run created: ${run.id}`);
  console.log(`View at: ${dashboardUrl}\n`);

  const onResult = config.onResult ?? defaultOnResult;

  if (resolved.groupBy === 'round') {
    await runGroupedByRound(config, available, resolved, client, run, baseUrl, onResult);
  } else {
    await runGroupedByParticipant(config, available, resolved, client, run, onResult);
  }

  console.log(`All done. View at: ${dashboardUrl}`);
}

/** 'participant' ordering: one `client.runWorker` per participant, in turn. */
async function runGroupedByParticipant<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  available: T[],
  resolved: ResolvedRunConfig,
  client: BenchmarkClient,
  run: BenchmarkRun,
  onResult: OnResult,
): Promise<void> {
  for (const participant of available) {
    console.log(`${'='.repeat(70)}`);
    console.log(`  Participant: ${participant.name}`);
    console.log('='.repeat(70));

    const logBuffer = new LogBuffer();
    await client.planWorkers(config.benchmarkSlug, run.id, participant.name);

    const result = await client.runWorker({
      benchmarkSlug: config.benchmarkSlug,
      runId: run.id,
      participantSlug: participant.name,
      concurrency: resolved.concurrency,
      task: async (ctx: RunWorkerContext) => {
        if (resolved.staggerDelayMs > 0 && ctx.taskIndex > 0) {
          await sleep(ctx.taskIndex * resolved.staggerDelayMs);
        }
        return config.task({
          participant,
          taskIndex: ctx.taskIndex,
          step: (name, fn, options) => loggedStep(ctx, logBuffer, name, fn, options),
          recordStep: () => {
            /* platform worker owns step timing in 'participant' mode */
          },
        });
      },
      onResult: (record) => onResult(record, { iterations: resolved.iterations }),
      onFinish: (ctx) => uploadWorkerLog(ctx, logBuffer, participant.name),
    });

    if (!result.assignment) {
      console.error(`  No pending worker to claim for run ${run.id} — it may already be fully claimed.`);
      continue;
    }

    const ok = result.records.filter((r) => r.status === 'success').length;
    console.log(`  Done: ${ok}/${result.records.length} succeeded.\n`);
  }
}

/**
 * 'round' ordering: claim one `BenchmarkReporter` per participant up front,
 * then loop rounds, running one task per participant per round and streaming
 * each result to its reporter. Steps are built manually (no `client.runWorker`
 * to own them) via a shim that mirrors the platform's record shape.
 */
async function runGroupedByRound<T extends BaseParticipant>(
  config: BenchmarkConfig<T>,
  available: T[],
  resolved: ResolvedRunConfig,
  client: BenchmarkClient,
  run: BenchmarkRun,
  baseUrl: string,
  onResult: OnResult,
): Promise<void> {
  const reporters = new Map<string, BenchmarkReporter | null>();
  const logBuffers = new Map<string, LogBuffer>();
  const failed = new Map<string, boolean>();

  for (const participant of available) {
    logBuffers.set(participant.name, new LogBuffer());
    failed.set(participant.name, false);
    await client.planWorkers(config.benchmarkSlug, run.id, participant.name, {
      workerCount: 1,
      targetConcurrency: resolved.iterations,
    });
    const reporter = await BenchmarkReporter.claim({
      baseUrl,
      benchmarkSlug: config.benchmarkSlug,
      runId: run.id,
      participantSlug: participant.name,
      processKind: 'process',
      processKey: process.env.HOSTNAME ?? 'local',
    });
    if (!reporter) {
      console.warn(`  ${participant.name}: could not claim a platform worker — running without platform reporting.`);
    }
    reporters.set(participant.name, reporter);
  }

  console.log(`Round-robin across ${available.length} participant(s), ${resolved.iterations} round(s) each.\n`);

  for (let round = 0; round < resolved.iterations; round++) {
    if (resolved.staggerDelayMs > 0 && round > 0) {
      await sleep(resolved.staggerDelayMs);
    }
    for (const participant of available) {
      const reporter = reporters.get(participant.name) ?? null;
      const logBuffer = logBuffers.get(participant.name)!;
      const taskIndex = (reporter?.taskIndexStart ?? 0) + round;
      const record = await runTaskRecord(config.task, participant, taskIndex, logBuffer);
      if (record.status !== 'success') failed.set(participant.name, true);
      onResult(record, { iterations: resolved.iterations });
      reporter?.recordResult(record);
    }
  }

  for (const participant of available) {
    const reporter = reporters.get(participant.name) ?? null;
    const logBuffer = logBuffers.get(participant.name)!;
    if (reporter && !logBuffer.isEmpty()) {
      await reporter
        .uploadArtifact({ kind: 'coordinator.log', contentType: 'text/plain', name: 'worker.log', body: logBuffer.toText() })
        .catch(() => {});
    }
    await reporter?.finish(failed.get(participant.name) ?? false);
    console.log(`  ${participant.name}: done${failed.get(participant.name) ? ' (with errors)' : ''}.`);
  }
}

/** Runs one task for the manual 'round' path, building its `TaskResultRecord`. */
async function runTaskRecord<T extends BaseParticipant>(
  task: BenchmarkConfig<T>['task'],
  participant: T,
  taskIndex: number,
  logBuffer: LogBuffer,
): Promise<TaskResultRecord> {
  const startedAtMs = Date.now();
  const record: TaskResultRecord = {
    taskIndex,
    status: 'success',
    startedAt: new Date(startedAtMs).toISOString(),
  };
  const steps: TaskStepRecord[] = [];

  const ctx: TaskContext<T> = {
    participant,
    taskIndex,
    async step(name, fn) {
      const stepStartedAtMs = Date.now();
      const stepRecord: TaskStepRecord = {
        name,
        status: 'success',
        startedAt: new Date(stepStartedAtMs).toISOString(),
        completedAt: new Date(stepStartedAtMs).toISOString(),
        latencyMs: 0,
      };
      try {
        const result = await fn();
        logBuffer.step(taskIndex, name, {});
        return result;
      } catch (error) {
        stepRecord.status = 'error';
        stepRecord.errorCode = getErrorCode(error);
        logBuffer.step(taskIndex, name, { error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        stepRecord.completedAt = new Date().toISOString();
        stepRecord.latencyMs = Date.now() - stepStartedAtMs;
        steps.push(stepRecord);
      }
    },
    recordStep(step) {
      steps.push(step);
    },
  };

  try {
    const data = await task(ctx);
    record.data = toJsonObject(data);
  } catch (error) {
    record.status = 'error';
    record.errorCode = getErrorCode(error);
    record.data = { errorMessage: error instanceof Error ? error.message : String(error) };
  } finally {
    record.completedAt = new Date().toISOString();
    record.latencyMs = Date.now() - startedAtMs;
    record.steps = steps.length > 0 ? steps : undefined;
  }

  return record;
}
