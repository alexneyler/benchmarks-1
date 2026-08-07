import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderConfig } from './types.js';
import { percentile } from '../src/util/stats.js';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { ensureBundleForRun } from '../scripts/ensure-bundle.js';

// ---------------------------------------------------------------------------
// Suite configuration
// ---------------------------------------------------------------------------

const SUITE_CONFIG = {
  id: 'pgbench' as const,
  label: 'Database pgbench (PGlite)',
  unit: 'tps' as const,
  higherIsBetter: true,
  ceiling: 1500,
  defaultReplicas: 3,
  workloadPath: 'pgbench-workload.js',
  timeoutMs: 300_000,
};

const BENCH_SCRIPT_PATH = path.resolve(import.meta.dirname, '../scripts/pgbench-workload.js');
const BENCH_STDOUT_PATH = path.resolve(import.meta.dirname, '../scripts/pgbench-stdout.js');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PgbenchWorkloadMeta {
  cpuCount?: number;
  memoryMb?: number;
  workloadMs?: number;
  iterationsReported?: number;
  providerNotes?: string;
}

export type PgbenchWorkloadResult =
  | {
      ok: true;
      suite: 'pgbench';
      metric: { value: number; unit: 'tps'; higherIsBetter: boolean };
      meta: PgbenchWorkloadMeta;
      notes?: string;
    }
  | {
      ok: false;
      suite: 'pgbench';
      reason: 'timeout' | 'error' | 'gap' | 'no_tool' | 'unexpected';
      error?: string;
      meta: PgbenchWorkloadMeta;
    };

export interface PgbenchSuiteStats {
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  successRate: number;
  n: number;
  scoreBeforeReliability: number;
  compositeScore: number;
  meta: PgbenchWorkloadMeta;
}

export interface PgbenchBenchmarkResult {
  provider: string;
  suite: 'pgbench';
  mode: 'pgbench';
  iterations: PgbenchWorkloadResult[];
  summary: PgbenchSuiteStats;
  wallClockMs: number;
  replicateMs: number[];
  compositeScore: number;
  skipped?: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single value against the suite's calibration ceiling.
 * Higher is better: 100 * (value/ceiling). Clamped to [0, 100].
 */
export function scoreMetric(value: number, suite: typeof SUITE_CONFIG): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ratio = suite.higherIsBetter ? value / suite.ceiling : 1 - value / suite.ceiling;
  return clamp(ratio * 100, 0, 100);
}

/**
 * Compute median/min/max/p95/p99/score for a single provider cell.
 * 2-sigma outlier trim. If trim leaves < 1 sample, keep the raw median.
 */
export function computeStats(results: PgbenchWorkloadResult[], suite: typeof SUITE_CONFIG): PgbenchSuiteStats {
  const successful = results.filter(r => r.ok === true);
  const ok = successful.length;
  const total = results.length;

  if (ok === 0) {
    return {
      median: 0, p95: 0, p99: 0, min: 0, max: 0,
      successRate: 0, n: 0, scoreBeforeReliability: 0,
      compositeScore: 0, meta: {},
    };
  }

  const values = successful.map(r => r.metric.value);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length === 0
    ? 0
    : sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

  const trimmed = stripOutliersBySigma(sorted, 2);
  const statsValues = trimmed.length >= 1 ? trimmed : sorted;

  const p95 = percentile(statsValues, 95);
  const p99 = percentile(statsValues, 99);

  return {
    median, p95, p99,
    min: sorted[0], max: sorted[sorted.length - 1],
    successRate: ok / total, n: ok,
    scoreBeforeReliability: scoreMetric(median, suite),
    compositeScore: round1(scoreMetric(median, suite) * (ok / total)),
    meta: lastMeta(successful) ?? {},
  };
}

// ---------------------------------------------------------------------------
// Stdout parsing
// ---------------------------------------------------------------------------

/**
 * Read the last JSON line of stdout. Returns a gap WorkloadResult if
 * no line parses — never throws.
 */
export function parseWorkloadResult(stdout: string): PgbenchWorkloadResult {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as PgbenchWorkloadResult;
      if (!parsed || typeof parsed !== 'object') continue;
      if (typeof parsed.suite !== 'string' || parsed.suite !== 'pgbench') continue;
      return parsed;
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    suite: 'pgbench',
    reason: 'unexpected',
    error: 'no parseable WorkloadResult JSON line found in stdout',
    meta: {},
  };
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

/**
 * Run the pgbench benchmark for one provider at the given replicate count.
 *
 * Each replicate:
 *   - creates a fresh sandbox via ComputeSDK
 *   - uploads the workload script, stdout helper, and PGlite bundle
 *     via heredoc/chunked base64 and executes
 *     node in a SINGLE runCommand call
 *   - parses the last WorkloadResult JSON line from stdout
 *   - destroys the sandbox unconditionally
 */
export async function runPgbenchBenchmark(
  config: ProviderConfig & { replicas?: number },
): Promise<PgbenchBenchmarkResult> {
  const { name, replicas = SUITE_CONFIG.defaultReplicas, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;
  const suite = SUITE_CONFIG;

  const t0 = performance.now();

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name, suite: suite.id, mode: suite.id,
      iterations: [], summary: emptyStats(), wallClockMs: 0,
      replicateMs: [], compositeScore: 0,
      skipped: true, skipReason: 'Missing: ' + missingVars.join(', '),
    };
  }

  const payload = buildPayload();
  if (!payload.ok) {
    return {
      provider: name, suite: suite.id, mode: suite.id,
      iterations: [{ ok: false, suite: suite.id, reason: 'error', error: payload.error, meta: {} }],
      summary: emptyStats(), wallClockMs: 0, replicateMs: [], compositeScore: 0,
    };
  }

  const iterations: PgbenchWorkloadResult[] = [];
  const replicateMs: number[] = [];

  for (let r = 0; r < replicas; r++) {
    console.log('  [' + name + '/' + suite.id + '] replicate ' + (r + 1) + '/' + replicas + '...');
    const rStart = performance.now();

    let sandbox: any = null;
    let phase = 'sandbox creation';
    try {
      const compute = config.createCompute();
      sandbox = await withTimeout(
        compute.sandbox.create(sandboxOptions),
        timeout,
        'Sandbox creation timed out',
      );

      phase = 'bundle filesystem upload';
      if (payload.bundleB64) {
        await uploadBundle(sandbox, payload.bundleB64);
      }

      phase = 'bundle extraction';
      await runCheckedCommand(
        sandbox,
        'mkdir -p /tmp/bench/fixture && tar -tzf /tmp/bench/pglite.tar.gz >/dev/null && tar -xzf /tmp/bench/pglite.tar.gz -C /tmp/bench/fixture && rm -f /tmp/bench/pglite.tar.gz',
        'bundle extraction',
      );

      phase = 'PGlite preflight';
      await runCheckedCommand(
        sandbox,
        `test -f /tmp/bench/fixture/node_modules/@electric-sql/pglite/package.json && node -e 'import("file:///tmp/bench/fixture/node_modules/@electric-sql/pglite/dist/index.js").then(() => console.log("PGLITE_IMPORT_OK")).catch(e => { console.error(e.stack || e); process.exit(1); })'`,
        'PGlite import preflight',
      );

      phase = 'pgbench workload';
      const shellCmd = buildSingleCommand(suite, payload);
      const result = await withTimeout(
        sandbox.runCommand(shellCmd, { timeout: suite.timeoutMs }),
        suite.timeoutMs,
        suite.id + ' workload timed out',
      ) as { exitCode: number; stdout?: string; stderr?: string };

      if (result.exitCode !== 0) {
        const errTail = (result.stderr || '').slice(-500);
        iterations.push({ ok: false, suite: suite.id, reason: 'error', error: 'non-zero exit: ' + (errTail || 'no stderr'), meta: {} });
      } else {
        const parsed = parseWorkloadResult(result.stdout || '');
        if (!parsed.ok && parsed.reason === 'unexpected') {
          const stderrTail = (result.stderr || '').slice(-200);
          parsed.error = stderrTail
            ? parsed.error + '; stderr: ' + stderrTail
            : parsed.error + '; stdout was empty (exitCode=0) — provider may not wait for command completion';
        }
        iterations.push(parsed);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      iterations.push({ ok: false, suite: suite.id, reason: classifyError(message), error: phase + ': ' + message, meta: {} });
    } finally {
      replicateMs.push(performance.now() - rStart);
      if (sandbox) {
        try {
          await Promise.race([
            sandbox.destroy(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('destroy timeout')), destroyTimeoutMs)),
          ]);
        } catch (err) {
          console.warn('    [cleanup] destroy failed: ' + formatError(err));
        }
      }
    }
  }

  const summary = computeStats(iterations, suite);
  const wallClockMs = performance.now() - t0;

  console.log('  [' + name + '/' + suite.id + '] ' + summary.n + '/' + replicas + ' OK · median ' + summary.median.toFixed(1) + ' TPS · score ' + summary.compositeScore);

  return {
    provider: name, suite: suite.id, mode: suite.id,
    iterations, summary, wallClockMs, replicateMs,
    compositeScore: summary.compositeScore,
  };
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------

export async function writePgbenchResultsJson(results: PgbenchBenchmarkResult[], outPath: string): Promise<void> {
  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => {
      if (i.ok) {
        return {
          ok: true,
          suite: i.suite,
          metric: { value: round(i.metric.value), unit: i.metric.unit, higherIsBetter: i.metric.higherIsBetter },
          meta: i.meta,
          ...(i.notes ? { notes: i.notes } : {}),
        };
      }
      return {
        ok: false,
        suite: i.suite,
        reason: i.reason,
        ...(i.error ? { error: i.error } : {}),
        meta: i.meta,
      };
    }),
    summary: {
      median: round(r.summary.median),
      p95: round(r.summary.p95),
      p99: round(r.summary.p99),
      min: round(r.summary.min),
      max: round(r.summary.max),
      successRate: round(r.summary.successRate),
      n: r.summary.n,
      scoreBeforeReliability: round(r.summary.scoreBeforeReliability),
      compositeScore: round(r.summary.compositeScore),
      meta: r.summary.meta,
    },
    wallClockMs: round(r.wallClockMs),
    replicateMs: r.replicateMs.map(round),
    compositeScore: round(r.compositeScore),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: os.platform(), arch: os.arch() },
    config: { mode: 'pgbench', ceiling: SUITE_CONFIG.ceiling, unit: SUITE_CONFIG.unit, timeoutMs: SUITE_CONFIG.timeoutMs },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Results written to ' + outPath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyStats(): PgbenchSuiteStats {
  return { median: 0, p95: 0, p99: 0, min: 0, max: 0, successRate: 0, n: 0, scoreBeforeReliability: 0, compositeScore: 0, meta: {} };
}

type FailureReason = Extract<PgbenchWorkloadResult, { ok: false }>['reason'];

function classifyError(message: string): FailureReason {
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/gap|skip|not available/i.test(message)) return 'gap';
  return 'error';
}

interface Payload {
  ok: true; scriptName: string; scriptContent: string; stdoutContent: string;
  bundleB64: string;
}
interface PayloadErr { ok: false; error: string }

function buildPayload(): Payload | PayloadErr {
  if (!fs.existsSync(BENCH_SCRIPT_PATH)) {
    return { ok: false, error: 'Workload script missing on pgbench: ' + BENCH_SCRIPT_PATH };
  }
  const scriptContent = fs.readFileSync(BENCH_SCRIPT_PATH, 'utf8');
  const stdoutContent = fs.existsSync(BENCH_STDOUT_PATH) ? fs.readFileSync(BENCH_STDOUT_PATH, 'utf8') : '';
  const bundleReady = ensureBundleForRun('pglite');
  if (!bundleReady.ok) {
    return { ok: false, error: bundleReady.reason || 'PGlite bundle is unavailable' };
  }
  const manifestPath = path.resolve(import.meta.dirname, '../../dist/bundles/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { pglite?: { path?: string } };
  const bundlePath = manifest.pglite?.path
    ? path.resolve(import.meta.dirname, '../../dist/bundles', manifest.pglite.path)
    : '';
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    return { ok: false, error: 'PGlite bundle missing after build: ' + bundlePath };
  }
  const bundleB64 = fs.readFileSync(bundlePath).toString('base64');

  return {
    ok: true,
    scriptName: SUITE_CONFIG.workloadPath,
    scriptContent, stdoutContent,
    bundleB64,
  };
}

function randomMarker(prefix: string): string {
  return '__BENCH_' + prefix + '_' + Math.random().toString(36).slice(2, 10) + '__';
}

function buildSingleCommand(suite: typeof SUITE_CONFIG, payload: Payload): string {
  const lines: string[] = [];
  lines.push('set -e');
  lines.push('mkdir -p /tmp/bench');

  if (payload.stdoutContent) {
    const m1 = randomMarker('STDOUT');
    lines.push('cat > /tmp/bench/stdout.js <<\'' + m1 + '\'');
    lines.push(payload.stdoutContent);
    lines.push(m1);
  }

  const m2 = randomMarker('WORKLOAD');
  lines.push('cat > /tmp/bench/' + payload.scriptName + ' <<\'' + m2 + '\'');
  lines.push(payload.scriptContent);
  lines.push(m2);

  lines.push('BENCH_FIXTURE_ROOT=/tmp/bench/fixture BENCH_SUITE=' + suite.id + ' node /tmp/bench/' + payload.scriptName);

  return lines.join('\n');
}

async function uploadBundle(sandbox: any, bundleB64: string): Promise<void> {
  const cleaned = bundleB64.replace(/\s+/g, '');
  if (!sandbox.filesystem || typeof sandbox.filesystem.writeFile !== 'function') {
    throw new Error('provider does not expose the universal filesystem.writeFile API');
  }
  await sandbox.filesystem.mkdir('/tmp/bench').catch(() => undefined);
  await sandbox.filesystem.writeFile('/tmp/bench/pglite.tar.gz.b64', cleaned);
  await runCheckedCommand(sandbox, 'base64 -d /tmp/bench/pglite.tar.gz.b64 > /tmp/bench/pglite.tar.gz', 'decode uploaded bundle');
  await runCheckedCommand(sandbox, 'rm /tmp/bench/pglite.tar.gz.b64', 'remove encoded bundle');
}

async function runCheckedCommand(sandbox: any, command: string, label: string): Promise<void> {
  const result = await sandbox.runCommand(command, { timeout: 120_000 }) as { exitCode?: number; stdout?: string; stderr?: string };
  if (result.exitCode !== 0) {
    const stderr = (result.stderr || '').slice(-1000);
    const stdout = (result.stdout || '').slice(-500);
    throw new Error(`${label} failed (exit ${result.exitCode ?? 'unknown'})${stderr ? `; stderr: ${stderr}` : ''}${stdout ? `; stdout: ${stdout}` : ''}`);
  }
}

function lastMeta(results: PgbenchWorkloadResult[]): PgbenchWorkloadMeta | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].meta) return results[i].meta;
  }
  return undefined;
}

function stripOutliersBySigma(sorted: number[], sigma: number): number[] {
  if (sorted.length < 4) return sorted;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return sorted;
  const lo = mean - sigma * sd;
  const hi = mean + sigma * sd;
  const trimmed = sorted.filter(v => v >= lo && v <= hi);
  return trimmed.length >= 1 ? trimmed : sorted;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Export SUITE_CONFIG for smoke test and SVG generator
export { SUITE_CONFIG };
