import type { ProviderConfig } from '../sandbox/types.js';
import type { HpcSuite, HpcBenchmarkResult, WorkloadResult } from './types.js';
type FailureReason = Extract<WorkloadResult, { ok: false }>['reason'];
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSuite } from './registry.js';
import { computeHpcStats } from './scoring.js';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { parseWorkloadResult } from './util/parse-stdout.js';
import {
  getBundlePath,
  getFixtureVersion,
} from './util/upload-bundle.js';
import { ensureHpcBundleForRun } from '../scripts/ensure-hpc-bundle.js';

/**
 * Run one (suite, provider) cell at the given replicate count.
 *
 * Each replicate:
 *   - creates a fresh sandbox via ComputeSDK
 *   - uploads the workload script (+ stdout helper + bundle) and executes
 *     `node /tmp/hpc/<workload>.js` in a SINGLE runCommand call (matching
 *     the dax.ts pattern — multiple runCommand calls don't reliably share
 *     filesystem state on all providers)
 *   - parses the last WorkloadResult JSON line from stdout
 *   - destroys the sandbox unconditionally
 */
export async function runHpcBenchmark(opts: {
  provider: ProviderConfig;
  suiteId: string;
  replicas: number;
}): Promise<HpcBenchmarkResult> {
  const suite = getSuite(opts.suiteId as HpcSuite['id']);
  const { provider, replicas } = opts;

  const t0 = performance.now();

  const missingVars = provider.requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: provider.name,
      suite: suite.id,
      mode: 'hpc',
      iterations: [],
      summary: emptyStats(suite),
      wallClockMs: 0,
      replicateMs: [],
      compositeScore: 0,
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  // Pre-read all payload files ONCE (outside the replicate loop) so
  // repeated replicates don't re-read from disk.
  const payload = buildPayload(suite);
  if (!payload.ok) {
    return {
      provider: provider.name,
      suite: suite.id,
      mode: 'hpc',
      iterations: [{
        ok: false, suite: suite.id, reason: 'error',
        error: payload.error, meta: {},
      }],
      summary: emptyStats(suite),
      wallClockMs: 0,
      replicateMs: [],
      compositeScore: 0,
    };
  }

  const iterations: WorkloadResult[] = [];
  const replicateMs: number[] = [];

  for (let r = 0; r < replicas; r++) {
    console.log(`  [${provider.name}/${suite.id}] replicate ${r + 1}/${replicas}...`);
    const rStart = performance.now();

    const bundleCheck = ensureHpcBundleForRun(suite.bundle);
    if (!bundleCheck.ok) {
      iterations.push({
        ok: false, suite: suite.id, reason: 'gap',
        error: bundleCheck.reason, meta: {},
      });
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

      // If the bundle is too large for a single heredoc, upload it
      // separately first via chunked runCommand calls.
      if (payload.bundleLarge) {
        await uploadBundleChunked(sandbox, payload.bundleB64!);
      }

      // Build the single shell command that writes scripts via heredocs,
      // extracts the bundle (if small enough to inline), and runs node.
      const shellCmd = buildSingleCommand(suite, payload);
      const result = await withTimeout(
        sandbox.runCommand(shellCmd, { timeout: suite.timeoutMs }),
        suite.timeoutMs,
        `${suite.id} workload timed out`,
      ) as { exitCode: number; stdout?: string; stderr?: string };

      if (result.exitCode !== 0) {
        const errTail = (result.stderr || '').slice(-500);
        iterations.push({
          ok: false, suite: suite.id, reason: 'error',
          error: `non-zero exit: ${errTail || 'no stderr'}`, meta: {},
        });
      } else {
        iterations.push(parseWorkloadResult(result.stdout || '', suite.id));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      iterations.push({
        ok: false, suite: suite.id, reason: classifyError(message),
        error: message, meta: {},
      });
    } finally {
      replicateMs.push(performance.now() - rStart);
      if (sandbox) {
        try {
          await Promise.race([
            sandbox.destroy(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('destroy timeout')), provider.destroyTimeoutMs ?? 15_000),
            ),
          ]);
        } catch (err) {
          console.warn(`    [cleanup] destroy failed: ${formatError(err)}`);
        }
      }
    }
  }

  const summary = computeHpcStats(iterations, suite);
  const wallClockMs = performance.now() - t0;

  console.log(
    `  [${provider.name}/${suite.id}] ${summary.n}/${replicas} OK · ` +
    `median ${summary.median.toFixed(1)}${unitLabel(suite)} · ` +
    `score ${summary.compositeScore}`,
  );

  return {
    provider: provider.name,
    suite: suite.id,
    mode: 'hpc',
    iterations,
    summary,
    wallClockMs,
    replicateMs,
    compositeScore: summary.compositeScore,
  };
}

function emptyStats(suite: HpcSuite) {
  return {
    median: 0, p95: 0, p99: 0, min: 0, max: 0,
    successRate: 0, n: 0, scoreBeforeReliability: 0,
    compositeScore: 0, meta: {},
  };
}

function classifyError(message: string): FailureReason {
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/gap|skip|not available/i.test(message)) return 'gap';
  return 'error';
}

function unitLabel(suite: HpcSuite): string {
  switch (suite.unit) {
    case 'ms': case 'rtt_ms': return 'ms';
    case 'mb_per_s': return ' MB/s';
    case 'gb_per_s': return ' GB/s';
    case 'iops': return ' IOPS';
    case 'tps': return ' TPS';
    case 'ops_per_s': return ' ops/s';
  }
}

// ---- Payload + single-command builder ----------------------------------

const WORKLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'workload');
const BUNDLE_INLINE_LIMIT = 180 * 1024; // 180 KiB base64 — safe under 256 KiB argv

interface Payload {
  ok: true;
  scriptName: string;
  scriptContent: string;
  stdoutContent: string;
  bundleB64: string | null;
  bundleLarge: boolean;     // true → upload separately before the main command
  fixtureVersion?: string;
}
interface PayloadErr { ok: false; error: string }

function buildPayload(suite: HpcSuite): Payload | PayloadErr {
  const workloadPath = path.join(WORKLOAD_DIR, path.basename(suite.workloadPath));
  if (!fs.existsSync(workloadPath)) {
    return { ok: false, error: `Workload script missing on disk: ${workloadPath}` };
  }
  const scriptContent = fs.readFileSync(workloadPath, 'utf8');
  const stdoutPath = path.join(WORKLOAD_DIR, 'stdout.js');
  const stdoutContent = fs.existsSync(stdoutPath)
    ? fs.readFileSync(stdoutPath, 'utf8') : '';

  let bundleB64: string | null = null;
  let bundleLarge = false;
  if (suite.bundle !== 'none') {
    const bundlePath = getBundlePath(suite.bundle as 'fixture-archive');
    if (!fs.existsSync(bundlePath)) {
      return {
        ok: false,
        error: `Bundle missing on disk: ${bundlePath}. Run \`pnpm run build:hpc-bundles\`.`,
      };
    }
    bundleB64 = fs.readFileSync(bundlePath).toString('base64');
    bundleLarge = bundleB64.length > BUNDLE_INLINE_LIMIT;
  }

  const fixtureVersion = suite.bundle === 'fixture-archive' ? getFixtureVersion() : undefined;
  return {
    ok: true,
    scriptName: path.basename(suite.workloadPath),
    scriptContent,
    stdoutContent,
    bundleB64,
    bundleLarge,
    fixtureVersion,
  };
}

function randomMarker(prefix: string): string {
  return `__HPC_${prefix}_${Math.random().toString(36).slice(2, 10)}__`;
}

/**
 * Build a single shell command that:
 *   1. Creates /tmp/hpc and /tmp/hpc/fixture
 *   2. Writes stdout.js and the workload script via raw heredocs
 *   3. If the bundle is small enough, decodes it from an inline base64 heredoc
 *      and extracts it to /tmp/hpc/fixture
 *   4. Runs `node /tmp/hpc/<script>` with the appropriate env vars
 *
 * This matches the dax.ts pattern: one runCommand call that does everything.
 * For large bundles (> 180 KiB base64), the bundle is uploaded separately
 * via uploadBundleChunked() before this command runs; the command then
 * just extracts the already-uploaded tarball.
 */
function buildSingleCommand(suite: HpcSuite, payload: Payload): string {
  const lines: string[] = [];
  lines.push('mkdir -p /tmp/hpc /tmp/hpc/fixture');

  // Write stdout.js helper (raw heredoc — it's a text file)
  if (payload.stdoutContent) {
    const m1 = randomMarker('STDOUT');
    lines.push(`cat > /tmp/hpc/stdout.js <<'${m1}'`);
    lines.push(payload.stdoutContent);
    lines.push(m1);
  }

  // Write workload script (raw heredoc)
  const m2 = randomMarker('WORKLOAD');
  lines.push(`cat > /tmp/hpc/${payload.scriptName} <<'${m2}'`);
  lines.push(payload.scriptContent);
  lines.push(m2);

  // Bundle handling
  if (payload.bundleB64 && !payload.bundleLarge) {
    // Small bundle: inline as base64 heredoc, decode, extract
    const m3 = randomMarker('BUNDLE');
    lines.push(`base64 -d <<'${m3}' > /tmp/hpc/bundle.tar.gz`);
    lines.push(payload.bundleB64);
    lines.push(m3);
    lines.push('tar -xzf /tmp/hpc/bundle.tar.gz -C /tmp/hpc/fixture && rm -f /tmp/hpc/bundle.tar.gz');
  } else if (payload.bundleB64 && payload.bundleLarge) {
    // Large bundle was already uploaded via uploadBundleChunked — just extract
    lines.push('tar -xzf /tmp/hpc/bundle.tar.gz -C /tmp/hpc/fixture && rm -f /tmp/hpc/bundle.tar.gz');
  }

  // Execute the workload
  const env = `HPC_FIXTURE_ROOT=/tmp/hpc/fixture${payload.fixtureVersion ? ` HPC_FIXTURE_VERSION=${payload.fixtureVersion}` : ''}`;
  lines.push(`${env} node /tmp/hpc/${payload.scriptName}`);

  return lines.join('\n');
}

// ---- Chunked bundle upload (for large bundles only) --------------------

const B64_CHUNK = 60 * 1024;

async function uploadBundleChunked(sandbox: any, bundleB64: string): Promise<void> {
  const cleaned = bundleB64.replace(/\s+/g, '');
  await sandbox.runCommand('mkdir -p /tmp/hpc');
  await sandbox.runCommand(': > /tmp/hpc/bundle.tar.gz.b64');

  for (let i = 0; i < cleaned.length; i += B64_CHUNK) {
    const idx = Math.floor(i / B64_CHUNK);
    const chunk = cleaned.slice(i, i + B64_CHUNK);
    const marker = `__HPC_BUNDLE_${idx.toString(36)}_${Math.random().toString(36).slice(2, 8)}__`;
    const cmd = `cat >> /tmp/hpc/bundle.tar.gz.b64 <<'${marker}'\n${chunk}\n${marker}`;
    await sandbox.runCommand(cmd);
  }

  await sandbox.runCommand('base64 -d /tmp/hpc/bundle.tar.gz.b64 > /tmp/hpc/bundle.tar.gz');
  await sandbox.runCommand('rm /tmp/hpc/bundle.tar.gz.b64');
}
