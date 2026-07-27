/**
 * Self-contained dax benchmark: config, orchestration, and the actual
 * in-sandbox probe code all live in this one file, built directly on
 * @benchsdk/client — no bench-config.ts, no run.ts dispatch, no separate
 * "report-run" file. Always reports to benchmarks-platform (no local-only
 * JSON mode).
 *
 * Run directly:
 *   tsx benchmarks/sandbox/dax.bench.ts
 *
 * This is the reference pattern for migrating sequential/staggered/burst off
 * the run.ts + sandbox/{benchmark,staggered,concurrent,dax-benchmark}.ts +
 * sandbox/report-run*.ts split. Once verified against real credentials, the
 * old `bench:dax`/`bench:dax:report` path (run.ts's dax handling,
 * sandbox/dax-benchmark.ts, sandbox/report-run-dax.ts, configs/example.dax.ts)
 * can be deleted in favor of this file.
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
const benchmarkSlug = 'sandbox-dax-local';
const benchmarkName = 'Dax sandbox benchmark (local)';
const providerNames = ['e2b', 'modal', 'tensorlake'];
const iterations = 1;
const timeout = 120_000;
const destroyTimeoutMs = 15_000;

const baseUrl = (process.env.BENCHMARKS_PLATFORM_URL || 'http://localhost:3000').replace(/\/+$/, '') + '/api/v1';
const orgSlug = process.env.BENCHMARKS_PLATFORM_ORG_SLUG || 'computesdk';
const client = createBenchmarkClient({ baseUrl });

// ---------------------------------------------------------------------------
// Task — the actual code this benchmark measures inside each sandbox.
// (moved in from sandbox/dax-benchmark.ts: disk write/read throughput + fsync
// latency, CPU throughput + steal%, and a pause/resume round-trip)
// ---------------------------------------------------------------------------
const DISK_FILE_SIZE_MB = 256;
const FSYNC_SAMPLE_COUNT = 20;
const CPU_PROBE_DURATION_MS = 1000;
const STEAL_SAMPLE_WINDOW_MS = 1000;

const DISK_PROBE_SCRIPT = `
const fs = require('fs');
const path = '/tmp/.dax_disk_' + process.pid;
try {
  const chunk = Buffer.alloc(1024 * 1024);
  const totalMB = ${DISK_FILE_SIZE_MB};

  const wStart = process.hrtime.bigint();
  const wfd = fs.openSync(path, 'w');
  for (let i = 0; i < totalMB; i++) fs.writeSync(wfd, chunk);
  fs.fsyncSync(wfd);
  fs.closeSync(wfd);
  const wEnd = process.hrtime.bigint();

  const readBuf = Buffer.alloc(1024 * 1024);
  const rStart = process.hrtime.bigint();
  const rfd = fs.openSync(path, 'r');
  while (fs.readSync(rfd, readBuf, 0, readBuf.length, null) > 0) {}
  fs.closeSync(rfd);
  const rEnd = process.hrtime.bigint();

  const writeSec = Number(wEnd - wStart) / 1e9;
  const readSec = Number(rEnd - rStart) / 1e9;
  const totalBytes = totalMB * 1024 * 1024;

  const fsyncLatencyMs = [];
  for (let i = 0; i < ${FSYNC_SAMPLE_COUNT}; i++) {
    const p = path + '.fsync' + i;
    const small = Buffer.alloc(4096, 1);
    const s0 = process.hrtime.bigint();
    const fd = fs.openSync(p, 'w');
    fs.writeSync(fd, small);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    const s1 = process.hrtime.bigint();
    fsyncLatencyMs.push(Number(s1 - s0) / 1e6);
    fs.unlinkSync(p);
  }

  fs.unlinkSync(path);

  console.log(JSON.stringify({
    writeMbps: (totalBytes * 8) / writeSec / 1e6,
    readMbps: (totalBytes * 8) / readSec / 1e6,
    fsyncLatencyMs,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: String(err && err.message || err) }));
}
`.trim();

const CPU_PROBE_SCRIPT = `
(async () => {
  const fs = require('fs');
  const crypto = require('crypto');

  function readStat() {
    try {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\\n')[0];
      const parts = line.trim().split(/\\s+/).slice(1).map(Number);
      const steal = parts[7] || 0;
      const total = parts.reduce((a, b) => a + b, 0);
      return { steal, total };
    } catch {
      return null;
    }
  }

  const data = crypto.randomBytes(1024);
  const start = process.hrtime.bigint();
  let count = 0;
  while (Number(process.hrtime.bigint() - start) / 1e6 < ${CPU_PROBE_DURATION_MS}) {
    crypto.createHash('sha256').update(data).digest();
    count++;
  }
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  const opsPerSec = count / elapsedSec;

  const s0 = readStat();
  await new Promise((r) => setTimeout(r, ${STEAL_SAMPLE_WINDOW_MS}));
  const s1 = readStat();
  let stealPercent;
  if (s0 && s1) {
    const totalDelta = s1.total - s0.total;
    const stealDelta = s1.steal - s0.steal;
    stealPercent = totalDelta > 0 ? (stealDelta / totalDelta) * 100 : 0;
  }

  let model, cores;
  try {
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const m = cpuinfo.match(/model name\\s*:\\s*(.+)/);
    model = m ? m[1].trim() : undefined;
    const c = cpuinfo.match(/^processor\\s*:/gm);
    cores = c ? c.length : undefined;
  } catch {}

  console.log(JSON.stringify({ opsPerSec, stealPercent, model, cores }));
})();
`.trim();

interface DiskProbeOutput {
  writeMbps: number;
  readMbps: number;
  fsyncLatencyMs: number[];
  error?: string;
}

interface CpuProbeOutput {
  opsPerSec: number;
  stealPercent?: number;
  model?: string;
  cores?: number;
}

function parseJsonStdout<T>(stdout: string | undefined): T {
  const trimmed = (stdout || '').trim();
  const lastLine = trimmed.split('\n').filter(Boolean).pop();
  if (!lastLine) throw new Error('Probe produced no output');
  return JSON.parse(lastLine) as T;
}

/** base64-wraps the script so no shell-quoting of newlines/quotes/backticks is needed across shell dialects. */
function toNodeEvalCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

async function runDiskProbe(sandbox: any): Promise<{ diskSeqWriteMbps: number; diskSeqReadMbps: number; diskFsyncLatencyMs: number[] }> {
  const result = (await withTimeout(
    sandbox.runCommand(toNodeEvalCommand(DISK_PROBE_SCRIPT)),
    timeout,
    'Disk probe timed out',
  )) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`Disk probe failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const parsed = parseJsonStdout<DiskProbeOutput>(result.stdout);
  if (parsed.error) throw new Error(`Disk probe error: ${parsed.error}`);

  return {
    diskSeqWriteMbps: parsed.writeMbps,
    diskSeqReadMbps: parsed.readMbps,
    diskFsyncLatencyMs: parsed.fsyncLatencyMs,
  };
}

async function runCpuProbe(sandbox: any): Promise<{ cpuOpsPerSec: number; cpuStealPercent?: number; cpuModel?: string; cpuCores?: number }> {
  const result = (await withTimeout(
    sandbox.runCommand(toNodeEvalCommand(CPU_PROBE_SCRIPT)),
    timeout,
    'CPU probe timed out',
  )) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`CPU probe failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const parsed = parseJsonStdout<CpuProbeOutput>(result.stdout);

  return {
    cpuOpsPerSec: parsed.opsPerSec,
    cpuStealPercent: parsed.stealPercent,
    cpuModel: parsed.model,
    cpuCores: parsed.cores,
  };
}

/**
 * Real pause/resume round-trip via `sandbox.pause()`/`sandbox.resume()`.
 * Providers that don't support it throw, which is treated the same as any
 * other pause/resume failure: `pauseResumeSupported: false` with the reason.
 */
async function runPauseResumeProbe(sandbox: any): Promise<{ pauseMs?: number; resumeMs?: number; pauseResumeSupported: boolean; pauseResumeSkipReason?: string }> {
  const pausable = sandbox as { pause?: (options?: any) => Promise<void>; resume?: () => Promise<void> };

  if (typeof pausable.pause !== 'function' || typeof pausable.resume !== 'function') {
    return { pauseResumeSupported: false, pauseResumeSkipReason: 'pause/resume not available on this sandbox object' };
  }

  const markerPath = `/tmp/.dax_pause_marker_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const token = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;

  try {
    const writeResult = (await withTimeout(
      sandbox.runCommand(`printf '%s' '${token}' > ${markerPath}`),
      30_000,
      'Marker file write timed out',
    )) as { exitCode: number; stderr?: string };
    if (writeResult.exitCode !== 0) {
      throw new Error(`Marker file write failed: ${writeResult.stderr || 'Unknown error'}`);
    }

    const pauseStart = performance.now();
    await withTimeout(pausable.pause(), timeout, 'Pause timed out');
    const pauseMs = performance.now() - pauseStart;

    const resumeStart = performance.now();
    await withTimeout(pausable.resume(), timeout, 'Resume timed out');
    const resumeMs = performance.now() - resumeStart;

    const readResult = (await withTimeout(
      sandbox.runCommand(`cat ${markerPath} 2>/dev/null || true`),
      30_000,
      'Marker file read timed out',
    )) as { exitCode: number; stdout?: string };
    const survived = (readResult.stdout || '').trim() === token;

    if (!survived) {
      throw new Error('Marker file did not survive pause/resume round-trip — this was a cold rebuild, not a real pause');
    }

    return { pauseMs, resumeMs, pauseResumeSupported: true };
  } catch (err) {
    return { pauseResumeSupported: false, pauseResumeSkipReason: formatError(err) };
  }
}

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
    const sandbox = await loggedStep<any>(ctx, logBuffer, 'create', () =>
      withTimeout(compute.sandbox.create(providerConfig.sandboxOptions), timeout, 'Sandbox creation timed out'),
    );
    try {
      const disk = await loggedStep(ctx, logBuffer, 'disk-probe', () => runDiskProbe(sandbox));
      const cpu = await loggedStep(ctx, logBuffer, 'cpu-probe', () => runCpuProbe(sandbox));
      const pauseResume = await loggedStep(ctx, logBuffer, 'pause-resume-probe', () => runPauseResumeProbe(sandbox));
      return { ...disk, ...cpu, ...pauseResume } as unknown as JsonObject;
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
        const d = record.data ?? {};
        const write = typeof d.diskSeqWriteMbps === 'number' ? d.diskSeqWriteMbps.toFixed(1) : '--';
        const read = typeof d.diskSeqReadMbps === 'number' ? d.diskSeqReadMbps.toFixed(1) : '--';
        const cpu = typeof d.cpuOpsPerSec === 'number' ? d.cpuOpsPerSec.toFixed(0) : '--';
        console.log(`  Iteration ${n}/${iterations}... disk ${write}/${read} Mbps write/read, CPU ${cpu} ops/s`);
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

  console.log('ComputeSDK Dax Benchmark (self-contained)');
  console.log(`Date: ${new Date().toISOString()}\n`);

  await client.upsertBenchmark(benchmarkSlug, { name: benchmarkName, kind: 'sandbox' });

  const { run } = await client.createRun(benchmarkSlug, {
    name: `dax — ${iterations} iterations`,
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
