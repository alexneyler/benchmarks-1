/**
 * Dax benchmark: disk write/read throughput + fsync latency, CPU throughput +
 * steal%, and a pause/resume round-trip, run once per provider. The in-sandbox
 * probe code lives here; all platform orchestration is owned by @benchsdk/cli's
 * runBenchmark.
 *
 * Run directly:
 *   tsx benchmarks/sandbox/dax.bench.ts
 *   tsx benchmarks/sandbox/dax.bench.ts --provider e2b,modal
 */
import '../src/env.js';
import { defineBenchmark, runBenchmark } from '@benchsdk/cli';
import type { TaskContext } from '@benchsdk/cli';
import type { JsonObject, TaskResultRecord } from '@benchsdk/client';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';

const timeout = 120_000;
const destroyTimeoutMs = 15_000;

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
// Task — one dax probe pass inside a freshly created sandbox.
// ---------------------------------------------------------------------------

async function daxTask(ctx: TaskContext<ProviderConfig>): Promise<JsonObject> {
  const { participant, step } = ctx;
  const compute = participant.createCompute();

  const sandbox = await step<any>('create', () =>
    withTimeout(compute.sandbox.create(participant.sandboxOptions), participant.timeout ?? timeout, 'Sandbox creation timed out'),
  );
  try {
    const disk = await step('disk-probe', () => runDiskProbe(sandbox));
    const cpu = await step('cpu-probe', () => runCpuProbe(sandbox));
    const pauseResume = await step('pause-resume-probe', () => runPauseResumeProbe(sandbox));
    return { ...disk, ...cpu, ...pauseResume } as unknown as JsonObject;
  } finally {
    await step('destroy', () =>
      withTimeout(sandbox.destroy(), participant.destroyTimeoutMs ?? destroyTimeoutMs, 'Destroy timeout'),
      { reportConcurrency: false },
    ).catch((err) => console.warn(`    [cleanup] destroy failed: ${formatError(err)}`));
  }
}

function logDax(record: TaskResultRecord, meta: { iterations: number }): void {
  const n = record.taskIndex + 1;
  if (record.status === 'success') {
    const d = record.data ?? {};
    const write = typeof d.diskSeqWriteMbps === 'number' ? d.diskSeqWriteMbps.toFixed(1) : '--';
    const read = typeof d.diskSeqReadMbps === 'number' ? d.diskSeqReadMbps.toFixed(1) : '--';
    const cpu = typeof d.cpuOpsPerSec === 'number' ? d.cpuOpsPerSec.toFixed(0) : '--';
    console.log(`  Task ${n}/${meta.iterations}: disk ${write}/${read} Mbps write/read, CPU ${cpu} ops/s`);
  } else {
    console.log(`  Task ${n}/${meta.iterations}: FAILED — ${record.errorCode ?? 'unknown error'}`);
  }
}

const config = defineBenchmark({
  benchmarkSlug: 'sandbox-dax-local',
  benchmarkName: 'Dax sandbox benchmark (local)',
  benchmarkKind: 'sandbox',
  iterations: 1,
  concurrency: 1,
  defaultProviders: ['e2b', 'modal', 'tensorlake'],
  task: daxTask,
  onResult: logDax,
});

runBenchmark(config, providers, process.argv.slice(2))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
