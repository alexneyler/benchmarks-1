/**
 * Self-contained staggered TTI benchmark: config, orchestration, and the
 * actual in-sandbox check all live in this one file, built directly on
 * @computesdk/bench — no bench-config.ts, no run.ts dispatch, no separate
 * "report-run" file. Always reports to benchmarks-platform (no local-only
 * JSON mode).
 *
 * Run directly:
 *   tsx src/benchmarks/staggered.bench.ts
 *
 * NOTE: unlike sequential/burst/dax, staggered mode never had a platform-
 * reporting implementation before this file — sandbox/staggered.ts only ever
 * wrote local JSON, and bench-config.ts's defineBenchmark() explicitly
 * rejected `report` + mode "staggered". @computesdk/bench's runWorker has no
 * built-in "launch with a delay between each" primitive (its `concurrency`
 * option bounds parallelism, it doesn't stagger start times), so the ramp is
 * reproduced here by giving every task a pool slot up front (concurrency ==
 * total count, so nothing queues) and having each task wait
 * `taskIndex * staggerDelayMs` before it actually creates its sandbox. Sanity
 * check the resulting ramp on the dashboard before relying on it.
 *
 * See dax.bench.ts for the reference pattern this follows.
 */
import '../env.js';
import { createBenchmarkClient } from '@computesdk/bench';
import type { JsonObject, RunWorkerContext, DefineStepOptions, TaskResultRecord } from '@computesdk/bench';
import { withTimeout } from '../util/timeout.js';
import { formatError } from '../util/error.js';
import { LogBuffer, uploadWorkerLog } from '../sandbox/log-buffer.js';
import { providers } from '../sandbox/providers.js';
import type { ProviderConfig } from '../sandbox/types.js';

// ---------------------------------------------------------------------------
// Config — everything about *this* benchmark run.
// ---------------------------------------------------------------------------
const benchmarkSlug = 'sandbox-staggered-local';
const benchmarkName = 'Sandbox staggered TTI (local)';
const providerNames = ['e2b'];
const concurrency = 3;
const staggerDelayMs = 200;
const timeout = 120_000;
const destroyTimeoutMs = 15_000;

const baseUrl = (process.env.BENCHMARKS_PLATFORM_URL || 'http://localhost:3000').replace(/\/+$/, '') + '/api/v1';
const orgSlug = process.env.BENCHMARKS_PLATFORM_ORG_SLUG || 'computesdk';
const client = createBenchmarkClient({ baseUrl });

// ---------------------------------------------------------------------------
// Orchestration — loop the configured providers, each as its own participant
// on one shared platform run.
// ---------------------------------------------------------------------------

/** Runs `fn` through both the platform step reporter and the local log buffer, so failures show up in both places without duplicating the try/catch at every call site. */
async function loggedStep<T>(
  ctx: RunWorkerContext,
  logBuffer: LogBuffer,
  name: string,
  fn: () => Promise<T>,
  options?: DefineStepOptions,
): Promise<T> {
  try {
    const result = await ctx.step(name, fn, options);
    logBuffer.step(ctx.taskIndex, name, {});
    return result;
  } catch (error) {
    logBuffer.step(ctx.taskIndex, name, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function runProvider(providerConfig: ProviderConfig, runId: string): Promise<void> {
  const missing = providerConfig.requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.log(`\nSkipping ${providerConfig.name}: missing ${missing.join(', ')}`);
    return;
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Provider: ${providerConfig.name}  Concurrency: ${concurrency}  Stagger delay: ${staggerDelayMs}ms`);
  console.log('='.repeat(70));

  const compute = providerConfig.createCompute();
  const logBuffer = new LogBuffer();

  await client.planWorkers(benchmarkSlug, runId, providerConfig.name);

  const task = async (ctx: RunWorkerContext): Promise<JsonObject> => {
    const launchedAtMs = ctx.taskIndex * staggerDelayMs;
    if (launchedAtMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, launchedAtMs));
    }

    const start = performance.now();
    const sandbox = await loggedStep<any>(ctx, logBuffer, 'create', () =>
      withTimeout(compute.sandbox.create(providerConfig.sandboxOptions), timeout, 'Sandbox creation timed out'),
    );
    try {
      await loggedStep(ctx, logBuffer, 'exec.task', async () => {
        const result = (await withTimeout(
          sandbox.runCommand('node -v'),
          30_000,
          'First command execution timed out',
        )) as { exitCode: number; stderr?: string };
        if (result.exitCode !== 0) {
          throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
        }
      });
      const ttiMs = performance.now() - start;
      return { ttiMs, launchedAtMs };
    } finally {
      await loggedStep(ctx, logBuffer, 'destroy', () => withTimeout(sandbox.destroy(), destroyTimeoutMs, 'Destroy timeout'), { reportConcurrency: false })
        .catch((err) => console.warn(`    [cleanup] destroy failed: ${formatError(err)}`));
    }
  };

  const result = await client.runWorker({
    benchmarkSlug,
    runId,
    participantSlug: providerConfig.name,
    // Pool width == total count so every task gets picked up immediately;
    // the stagger itself happens *inside* the task (see `launchedAtMs` above).
    concurrency,
    task,
    onResult: (record: TaskResultRecord) => {
      const n = record.taskIndex + 1;
      if (record.status === 'success') {
        const ttiMs = typeof record.data?.ttiMs === 'number' ? record.data.ttiMs : undefined;
        const launchedAtMs = typeof record.data?.launchedAtMs === 'number' ? record.data.launchedAtMs : undefined;
        console.log(
          `  Sandbox ${n}/${concurrency}: TTI ${ttiMs !== undefined ? (ttiMs / 1000).toFixed(2) + 's' : '--'}` +
          ` (launched at +${launchedAtMs !== undefined ? (launchedAtMs / 1000).toFixed(2) : '?'}s)`,
        );
      } else {
        console.log(`  Sandbox ${n}/${concurrency}: FAILED — ${record.errorCode ?? 'unknown error'}`);
      }
    },
    onFinish: (ctx) => uploadWorkerLog(ctx, logBuffer, providerConfig.name),
  });

  if (!result.assignment) {
    console.error(`  No pending worker to claim for run ${runId} — it may already be fully claimed.`);
    return;
  }

  const ok = result.records.filter((r) => r.status === 'success').length;
  console.log(`  Done: ${ok}/${result.records.length} succeeded.`);
}

async function main(): Promise<void> {
  const toRun = providers.filter((p) => providerNames.includes(p.name));
  if (toRun.length === 0) {
    console.error(`No matching providers for: ${providerNames.join(', ')}`);
    process.exit(1);
  }

  console.log('ComputeSDK Staggered TTI Benchmark (self-contained)');
  console.log(`Date: ${new Date().toISOString()}\n`);

  await client.upsertBenchmark(benchmarkSlug, { name: benchmarkName, kind: 'sandbox' });

  const { run } = await client.createRun(benchmarkSlug, {
    name: `staggered — concurrency ${concurrency}, ${staggerDelayMs}ms apart`,
    totalTasks: concurrency,
    workerCount: 1,
    participants: toRun.map((p) => p.name),
  });

  const dashboardUrl = `${baseUrl.replace(/\/api\/v1\/?$/, '')}/${orgSlug}/benchmarks/${benchmarkSlug}/runs/${run.id}`;
  console.log(`Run created: ${run.id}`);
  console.log(`View at: ${dashboardUrl}\n`);

  for (const providerConfig of toRun) {
    await runProvider(providerConfig, run.id);
  }

  console.log(`\nAll done. View at: ${dashboardUrl}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
