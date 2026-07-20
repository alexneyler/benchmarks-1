/**
 * Runs the dax probe sequence (disk → CPU → pause/resume) through the
 * platform's real orchestrator API, mirroring report-run.ts's sequential
 * path but reusing the actual probe implementations from dax-benchmark.ts
 * (runDiskProbe/runCpuProbe/runPauseResumeProbe) so a reported run measures
 * exactly the same thing as the local-only `--mode dax` run.
 *
 * Unlike report-run.ts/report-run-burst.ts, these steps return real
 * measurements (e.g. diskSeqWriteMbps) as step data, not just a timing —
 * @computesdk/bench merges a step's JSON return value into the task's
 * `data`, which reaches the platform's data_json/step_data_json columns.
 * See benchmarks-platform/docs/2026-07-16-dax-custom-metrics.md for the
 * full metric catalog and what it takes to surface these on the dashboard
 * (today only latency_ms is charted there — these custom fields are stored
 * but not yet visualized).
 */
import { createBenchmarkClient, defineStep, defineTask } from '@computesdk/bench';
import type { TaskResultRecord, JsonObject } from '@computesdk/bench';
import { withTimeout } from '../util/timeout.js';
import { runDiskProbe, runCpuProbe, runPauseResumeProbe } from './dax-benchmark.js';
import { LogBuffer, uploadWorkerLog } from './log-buffer.js';
import type { ProviderConfig } from './types.js';
import type { PlatformReportConfig } from './report-run.js';

type LifecycleState = { sandbox?: any };

export async function runDaxWithPlatformReport(
  config: ProviderConfig,
  iterations: number,
  report: PlatformReportConfig,
  runId: string,
): Promise<void> {
  const { name, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000, createCompute } = config;

  const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    console.log(`\nSkipping ${name}: missing ${missingVars.join(', ')}`);
    return;
  }

  const compute = createCompute();
  const client = createBenchmarkClient({ apiKey: report.apiKey, baseUrl: report.baseUrl });
  const logBuffer = new LogBuffer();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  MODE: DAX (reporting to platform)`);
  console.log(`  Provider: ${name}  Iterations: ${iterations}`);
  console.log(`  Benchmark: ${report.benchmarkSlug}`);
  console.log('='.repeat(70));

  await client.planWorkers(report.benchmarkSlug, runId, name);

  const dashboardUrl = `${report.baseUrl.replace(/\/api\/v1\/?$/, '')}/${report.orgSlug}/benchmarks/${report.benchmarkSlug}/runs/${runId}`;

  const task = defineTask<LifecycleState>('sandbox.dax', [
    defineStep<LifecycleState>('create', async ({ state, taskIndex }) => {
      try {
        state.sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
        logBuffer.step(taskIndex, 'create', {});
      } catch (error) {
        logBuffer.step(taskIndex, 'create', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }),
    defineStep<LifecycleState>('disk-probe', async ({ state, taskIndex }) => {
      try {
        const data = await runDiskProbe(state.sandbox, timeout);
        logBuffer.step(taskIndex, 'disk-probe', { stdout: JSON.stringify(data) });
        return data as unknown as JsonObject;
      } catch (error) {
        logBuffer.step(taskIndex, 'disk-probe', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }),
    defineStep<LifecycleState>('cpu-probe', async ({ state, taskIndex }) => {
      try {
        const data = await runCpuProbe(state.sandbox, timeout);
        logBuffer.step(taskIndex, 'cpu-probe', { stdout: JSON.stringify(data) });
        return data as unknown as JsonObject;
      } catch (error) {
        logBuffer.step(taskIndex, 'cpu-probe', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }),
    defineStep<LifecycleState>('pause-resume-probe', async ({ state, taskIndex }) => {
      try {
        const data = await runPauseResumeProbe(state.sandbox, timeout);
        logBuffer.step(taskIndex, 'pause-resume-probe', { stdout: JSON.stringify(data) });
        return data as unknown as JsonObject;
      } catch (error) {
        logBuffer.step(taskIndex, 'pause-resume-probe', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }),
    defineStep<LifecycleState>('destroy', { reportConcurrency: false }, async ({ state, taskIndex }) => {
      if (!state.sandbox) return;
      try {
        await Promise.race([
          (state.sandbox as any).destroy(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timeout')), destroyTimeoutMs)),
        ]);
        logBuffer.step(taskIndex, 'destroy', {});
      } catch (error) {
        logBuffer.step(taskIndex, 'destroy', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }),
  ]);

  const result = await client.runWorker({
    benchmarkSlug: report.benchmarkSlug,
    runId,
    participantSlug: name,
    concurrency: 1,
    task,
    onResult: (record: TaskResultRecord) => {
      const n = record.taskIndex + 1;
      if (record.status === 'success') {
        const d = record.data ?? {};
        const write = typeof d.diskSeqWriteMbps === 'number' ? d.diskSeqWriteMbps.toFixed(1) : '--';
        const read = typeof d.diskSeqReadMbps === 'number' ? d.diskSeqReadMbps.toFixed(1) : '--';
        const cpu = typeof d.cpuOpsPerSec === 'number' ? d.cpuOpsPerSec.toFixed(0) : '--';
        console.log(`  Iteration ${n}/${iterations}... disk ${write}/${read} Mbps write/read, CPU ${cpu} ops/s`);
      } else {
        console.log(`  Iteration ${n}/${iterations}... FAILED: ${record.errorCode ?? 'unknown error'}`);
      }
    },
    onFinish: (ctx) => uploadWorkerLog(ctx, logBuffer, name),
  });

  if (!result.assignment) {
    console.error(`  No pending worker to claim for run ${runId} — it may already be fully claimed.`);
    return;
  }

  const ok = result.records.filter((r) => r.status === 'success').length;
  console.log(`\n  Done: ${ok}/${result.records.length} succeeded.`);
  console.log(`  View at: ${dashboardUrl}`);
}
