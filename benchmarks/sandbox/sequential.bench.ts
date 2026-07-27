/**
 * Self-contained sequential TTI benchmark: config, orchestration, and the
 * actual in-sandbox check all live in this one file, built directly on
 * @benchsdk/client — no bench-config.ts, no run.ts dispatch, no separate
 * "report-run" file. Always reports to benchmarks-platform (no local-only
 * JSON mode).
 *
 * Run directly:
 *   tsx benchmarks/sandbox/sequential.bench.ts
 *
 * `iterations` sandboxes are created one at a time (concurrency: 1) per
 * provider; each iteration measures time-to-interactive: sandbox create
 * through the first command (`node -v`) succeeding, excluding destroy.
 *
 * See dax.bench.ts for the reference pattern this follows.
 */
import '../src/env.js';
import { createBenchmarkClient } from '@benchsdk/client';
import type { JsonObject, RunWorkerContext, TaskResultRecord } from '@benchsdk/client';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { LogBuffer, uploadWorkerLog, loggedStep } from '@benchsdk/cli';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';

// ---------------------------------------------------------------------------
// Config — everything about *this* benchmark run.
// ---------------------------------------------------------------------------
const benchmarkSlug = 'sandbox-tti-local';
const benchmarkName = 'Sandbox TTI (local)';
const providerNames = ['e2b'];
const iterations = 2;
const timeout = 120_000;
const destroyTimeoutMs = 15_000;

const baseUrl = (process.env.BENCHMARKS_PLATFORM_URL || 'http://localhost:3000').replace(/\/+$/, '') + '/api/v1';
const orgSlug = process.env.BENCHMARKS_PLATFORM_ORG_SLUG || 'computesdk';
const client = createBenchmarkClient({ baseUrl });

// ---------------------------------------------------------------------------
// Orchestration — loop the configured providers, each as its own participant
// on one shared platform run.
// ---------------------------------------------------------------------------

async function runProvider(providerConfig: ProviderConfig, runId: string): Promise<void> {
  const missing = providerConfig.requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.log(`\nSkipping ${providerConfig.name}: missing ${missing.join(', ')}`);
    return;
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Provider: ${providerConfig.name}  Iterations: ${iterations}`);
  console.log('='.repeat(70));

  const compute = providerConfig.createCompute();
  const logBuffer = new LogBuffer();

  await client.planWorkers(benchmarkSlug, runId, providerConfig.name);

  const task = async (ctx: RunWorkerContext): Promise<JsonObject> => {
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
      return { ttiMs };
    } finally {
      await loggedStep(ctx, logBuffer, 'destroy', () => withTimeout(sandbox.destroy(), destroyTimeoutMs, 'Destroy timeout'), { reportConcurrency: false })
        .catch((err) => console.warn(`    [cleanup] destroy failed: ${formatError(err)}`));
    }
  };

  const result = await client.runWorker({
    benchmarkSlug,
    runId,
    participantSlug: providerConfig.name,
    concurrency: 1,
    task,
    onResult: (record: TaskResultRecord) => {
      const n = record.taskIndex + 1;
      if (record.status === 'success') {
        const ttiMs = typeof record.data?.ttiMs === 'number' ? record.data.ttiMs : undefined;
        console.log(`  Iteration ${n}/${iterations}... TTI: ${ttiMs !== undefined ? (ttiMs / 1000).toFixed(2) + 's' : '--'}`);
      } else {
        console.log(`  Iteration ${n}/${iterations}... FAILED: ${record.errorCode ?? 'unknown error'}`);
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

  console.log('ComputeSDK Sequential TTI Benchmark (self-contained)');
  console.log(`Date: ${new Date().toISOString()}\n`);

  await client.upsertBenchmark(benchmarkSlug, { name: benchmarkName, kind: 'sandbox' });

  const { run } = await client.createRun(benchmarkSlug, {
    name: `sequential — ${iterations} iterations`,
    totalTasks: iterations,
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
