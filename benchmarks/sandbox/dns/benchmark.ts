import type { ProviderConfig } from '../types.js';
import type { SuiteConfig, BenchmarkResult, WorkloadResult } from './types.js';
import { SUITE_CONFIG } from './types.js';
type FailureReason = Extract<WorkloadResult, { ok: false }>['reason'];
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats } from './scoring.js';
import { withTimeout } from '../../src/util/timeout.js';
import { formatError } from '../../src/util/error.js';
import { parseWorkloadResult } from './util/parse-stdout.js';
import { ensureBundleForRun } from '../../scripts/ensure-bundle.js';

/**
 * Run one (provider) cell at the given replicate count for dns.
 *
 * Each replicate:
 *   - creates a fresh sandbox via ComputeSDK
 *   - uploads the workload script (+ stdout helper + bundle) and executes
 *     node in a SINGLE runCommand call
 *   - parses the last WorkloadResult JSON line from stdout
 *   - destroys the sandbox unconditionally
 */
export async function runBenchmark(opts: {
  provider: ProviderConfig;
  replicas: number;
}): Promise<BenchmarkResult> {
  const suite = SUITE_CONFIG;
  const { provider, replicas } = opts;

  const t0 = performance.now();

  const missingVars = provider.requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: provider.name, suite: suite.id, mode: suite.id,
      iterations: [], summary: emptyStats(), wallClockMs: 0,
      replicateMs: [], compositeScore: 0,
      skipped: true, skipReason: 'Missing: ' + missingVars.join(', '),
    };
  }

  const payload = buildPayload();
  if (!payload.ok) {
    return {
      provider: provider.name, suite: suite.id, mode: suite.id,
      iterations: [{ ok: false, suite: suite.id, reason: 'error', error: payload.error, meta: {} }],
      summary: emptyStats(), wallClockMs: 0, replicateMs: [], compositeScore: 0,
    };
  }

  const iterations: WorkloadResult[] = [];
  const replicateMs: number[] = [];

  for (let r = 0; r < replicas; r++) {
    console.log('  [' + provider.name + '/' + suite.id + '] replicate ' + (r + 1) + '/' + replicas + '...');
    const rStart = performance.now();

    const bundleCheck = ensureBundleForRun(suite.bundle);
    if (!bundleCheck.ok) {
      iterations.push({ ok: false, suite: suite.id, reason: 'gap', error: bundleCheck.reason, meta: {} });
      replicateMs.push(performance.now() - rStart);
      continue;
    }

    let sandbox: any = null;
    try {
      const compute = provider.createCompute();
      sandbox = await withTimeout(
        compute.sandbox.create(provider.sandboxOptions),
        provider.timeout ?? 120_000,
        'Sandbox creation timed out',
      );

      if (payload.bundleLarge) {
        await uploadBundleChunked(sandbox, payload.bundleB64!);
      }

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
        const parsed = parseWorkloadResult(result.stdout || '', suite.id);
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
      iterations.push({ ok: false, suite: suite.id, reason: classifyError(message), error: message, meta: {} });
    } finally {
      replicateMs.push(performance.now() - rStart);
      if (sandbox) {
        try {
          await Promise.race([
            sandbox.destroy(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('destroy timeout')), provider.destroyTimeoutMs ?? 15_000)),
          ]);
        } catch (err) {
          console.warn('    [cleanup] destroy failed: ' + formatError(err));
        }
      }
    }
  }

  const summary = computeStats(iterations, suite);
  const wallClockMs = performance.now() - t0;

  console.log('  [' + provider.name + '/' + suite.id + '] ' + summary.n + '/' + replicas + ' OK · median ' + summary.median.toFixed(1) + unitLabel(suite) + ' · score ' + summary.compositeScore);

  return {
    provider: provider.name, suite: suite.id, mode: suite.id,
    iterations, summary, wallClockMs, replicateMs,
    compositeScore: summary.compositeScore,
  };
}

function emptyStats() {
  return { median: 0, p95: 0, p99: 0, min: 0, max: 0, successRate: 0, n: 0, scoreBeforeReliability: 0, compositeScore: 0, meta: {} };
}

function classifyError(message: string): FailureReason {
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/gap|skip|not available/i.test(message)) return 'gap';
  return 'error';
}

function unitLabel(suite: SuiteConfig): string {
  switch (suite.unit as string) {
    case 'ms': case 'rtt_ms': return 'ms';
    case 'mb_per_s': return ' MB/s';
    case 'gb_per_s': return ' GB/s';
    case 'iops': return ' IOPS';
    case 'tps': return ' TPS';
    case 'ops_per_s': return ' ops/s';
    default: return '';
  }
}

const WORKLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'workload');
const BUNDLE_INLINE_LIMIT = 180 * 1024;

interface Payload {
  ok: true; scriptName: string; scriptContent: string; stdoutContent: string;
  bundleB64: string | null; bundleLarge: boolean; fixtureVersion?: string;
}
interface PayloadErr { ok: false; error: string }

function buildPayload(): Payload | PayloadErr {
  const workloadPath = path.join(WORKLOAD_DIR, path.basename(SUITE_CONFIG.workloadPath));
  if (!fs.existsSync(workloadPath)) {
    return { ok: false, error: 'Workload script missing on disk: ' + workloadPath };
  }
  const scriptContent = fs.readFileSync(workloadPath, 'utf8');
  const stdoutPath = path.join(WORKLOAD_DIR, 'stdout.js');
  const stdoutContent = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';

  const fixtureVersion = undefined;

  return {
    ok: true,
    scriptName: path.basename(SUITE_CONFIG.workloadPath),
    scriptContent, stdoutContent,
    bundleB64: null, bundleLarge: false, fixtureVersion,
  };
}

function randomMarker(prefix: string): string {
  return '__BENCH_' + prefix + '_' + Math.random().toString(36).slice(2, 10) + '__';
}

function buildSingleCommand(suite: SuiteConfig, payload: Payload): string {
  const lines: string[] = [];
  lines.push('set -e');
  lines.push('mkdir -p /tmp/bench /tmp/bench/fixture');

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

  if (payload.bundleB64 && !payload.bundleLarge) {
    const m3 = randomMarker('BUNDLE');
    lines.push('base64 -d <<\'' + m3 + '\' > /tmp/bench/bundle.tar.gz');
    lines.push(payload.bundleB64);
    lines.push(m3);
    lines.push('tar -xzf /tmp/bench/bundle.tar.gz -C /tmp/bench/fixture && rm -f /tmp/bench/bundle.tar.gz || { echo "BUNDLE_EXTRACT_FAILED"; exit 1; }');
  } else if (payload.bundleB64 && payload.bundleLarge) {
    lines.push('tar -xzf /tmp/bench/bundle.tar.gz -C /tmp/bench/fixture && rm -f /tmp/bench/bundle.tar.gz || { echo "BUNDLE_EXTRACT_FAILED"; exit 1; }');
  }

  const env = 'BENCH_FIXTURE_ROOT=/tmp/bench/fixture' + (payload.fixtureVersion ? ' BENCH_FIXTURE_VERSION=' + payload.fixtureVersion : '') + ' BENCH_SUITE=' + suite.id;
  lines.push(env + ' node /tmp/bench/' + payload.scriptName);

  return lines.join('\n');
}

const B64_CHUNK = 128 * 1024;

async function uploadBundleChunked(sandbox: any, bundleB64: string): Promise<void> {
  const cleaned = bundleB64.replace(/\s+/g, '');
  await sandbox.runCommand('mkdir -p /tmp/bench');
  await sandbox.runCommand(': > /tmp/bench/bundle.tar.gz.b64');

  for (let i = 0; i < cleaned.length; i += B64_CHUNK) {
    const idx = Math.floor(i / B64_CHUNK);
    const chunk = cleaned.slice(i, i + B64_CHUNK);
    const marker = '__BENCH_BUNDLE_' + idx.toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '__';
    const cmd = 'cat >> /tmp/bench/bundle.tar.gz.b64 <<\'' + marker + '\'\n' + chunk + '\n' + marker;
    await sandbox.runCommand(cmd);
  }

  await sandbox.runCommand('base64 -d /tmp/bench/bundle.tar.gz.b64 > /tmp/bench/bundle.tar.gz');
  await sandbox.runCommand('rm /tmp/bench/bundle.tar.gz.b64');
}
