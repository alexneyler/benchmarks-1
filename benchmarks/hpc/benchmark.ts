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
 *   - uploads the workload script (and any upload bundle) via base64 heredoc
 *   - executes `node /tmp/hpc/<workload>.js`
 *   - parses the last WorkloadResult JSON line
 *   - destroys the sandbox unconditionally
 *
 * Per-spec the orchestrator does NOT parallelize replicates within a cell —
 * matches the upstream benchmark convention for I/O-touching suites. The
 * full nightly matrix is what fans out across providers/suites in parallel.
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

  const iterations: WorkloadResult[] = [];
  const replicateMs: number[] = [];

  for (let r = 0; r < replicas; r++) {
    console.log(`  [${provider.name}/${suite.id}] replicate ${r + 1}/${replicas}...`);
    const rStart = performance.now();

    const bundleCheck = ensureHpcBundleForRun(suite.bundle);
    if (!bundleCheck.ok) {
      iterations.push({
        ok: false,
        suite: suite.id,
        reason: 'gap',
        error: bundleCheck.reason,
        meta: {},
      });
      replicateMs.push(performance.now() - rStart);
      // Replicate gap count as wall-clock but don't try to run anything else.
      continue;
    }

    let sandbox: any = null;
    let compute: any = null;
    let fixtureUploadError: string | undefined;
    try {
      compute = provider.createCompute();
      sandbox = await withTimeout(
        compute.sandbox.create(provider.sandboxOptions),
        provider.timeout ?? 120_000,
        'Sandbox creation timed out',
      );

      // Build the workload payload (script + stdout helper + bundle), then
      // upload via separate runCommand calls so the per-call argv fits
      // typical provider limits (~256 KiB on most ComputeSDK gateways).
      const payload = buildWorkloadPayload({ suite, provider });
      if (!payload.ok) {
        iterations.push({
          ok: false,
          suite: suite.id,
          reason: 'error',
          error: payload.error,
          meta: {},
        });
        continue;
      }

      await uploadPayload(sandbox, payload.parts);

      const envExports = `HPC_FIXTURE_ROOT=/tmp/hpc/fixture${payload.fixtureVersion ? ` HPC_FIXTURE_VERSION=${payload.fixtureVersion}` : ''}`;

      const result = await withTimeout(
        sandbox.runCommand(`${envExports} node /tmp/hpc/${payload.scriptName}`, { timeout: suite.timeoutMs }),
        suite.timeoutMs,
        `${suite.id} workload timed out`,
      ) as { exitCode: number; stdout?: string; stderr?: string };

      if (result.exitCode !== 0) {
        const errTail = (result.stderr || '').slice(-500);
        iterations.push({
          ok: false,
          suite: suite.id,
          reason: 'error',
          error: `non-zero exit: ${errTail || 'no stderr'}`,
          meta: {},
        });
      } else {
        iterations.push(parseWorkloadResult(result.stdout || '', suite.id));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      iterations.push({
        ok: false,
        suite: suite.id,
        reason: classifyError(message),
        error: fixtureUploadError ? `${fixtureUploadError}: ${message}` : message,
        meta: {},
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
    median: 0,
    p95: 0,
    p99: 0,
    min: 0,
    max: 0,
    successRate: 0,
    n: 0,
    scoreBeforeReliability: 0,
    compositeScore: 0,
    meta: {},
  };
}

function classifyError(message: string): FailureReason {
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/gap|skip|not available/i.test(message)) return 'gap';
  return 'error';
}

function unitLabel(suite: HpcSuite): string {
  switch (suite.unit) {
    case 'ms':
    case 'rtt_ms': return 'ms';
    case 'mb_per_s': return ' MB/s';
    case 'gb_per_s': return ' GB/s';
    case 'iops': return ' IOPS';
    case 'tps': return ' TPS';
    case 'ops_per_s': return ' ops/s';
  }
}

// ---- Split-upload plumbing ---------------------------------------------
//
// We split the workload payload (script + stdout helper + bundle) into
// B64_CHUNK byte heredocs and emit one runCommand call per chunk. This
// stays under the typical ComputeSDK gateway argv ceiling (~256 KiB) even
// for the largest bundle (sql.js + sql-wasm.wasm at ~700 KB total).

interface PayloadPart {
  /** Remote path inside /tmp/hpc where the chunk should land. */
  targetPath: string;
  /** base64-encoded chunk content. */
  b64: string;
  /** Marker used by the heredoc — deterministic per (targetPath, idx). */
  marker: string;
}

interface WorkloadPayload {
  ok: true;
  scriptName: string;          // path inside /tmp/hpc (e.g. 'cpu-node.js')
  parts: PayloadPart[];
  fixtureVersion?: string;
}
interface WorkloadPayloadErr {
  ok: false;
  error: string;
}

const B64_CHUNK = 60 * 1024; // 60 KiB per heredoc -> safe under 256 KiB argv

function buildWorkloadPayload(opts: {
  suite: HpcSuite;
  provider: ProviderConfig;
}): WorkloadPayload | WorkloadPayloadErr {
  const workloadPath = path.join(WORKLOAD_DIR, path.basename(opts.suite.workloadPath));
  if (!fs.existsSync(workloadPath)) {
    return { ok: false, error: `Workload script missing on disk: ${workloadPath}` };
  }
  const scriptB64 = Buffer.from(fs.readFileSync(workloadPath, 'utf8'), 'utf8').toString('base64');
  const stdoutPath = path.join(WORKLOAD_DIR, 'stdout.js');
  const stdoutB64 = fs.existsSync(stdoutPath)
    ? Buffer.from(fs.readFileSync(stdoutPath, 'utf8'), 'utf8').toString('base64')
    : null;

  let bundleB64: string | null = null;
  if (opts.suite.bundle !== 'none') {
    const bundlePath = getBundlePath(opts.suite.bundle as 'fixture-archive');
    if (!fs.existsSync(bundlePath)) {
      return {
        ok: false,
        error: `Bundle missing on disk: ${bundlePath}. Run \`pnpm run build:hpc-bundles\`.`,
      };
    }
    bundleB64 = fs.readFileSync(bundlePath).toString('base64');
  }

  const parts: PayloadPart[] = [];
  pushChunks(opts.suite.workloadPath, scriptB64, parts);
  if (stdoutB64 !== null) pushChunks('stdout.js', stdoutB64, parts);
  if (bundleB64 !== null) pushChunks('bundle.tar.gz', bundleB64, parts);

  const fixtureVersion = opts.suite.bundle === 'fixture-archive' ? getFixtureVersion() : undefined;
  return {
    ok: true,
    scriptName: path.basename(opts.suite.workloadPath),
    parts,
    fixtureVersion,
  };
}

const WORKLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'workload');

function pushChunks(targetPath: string, b64: string, out: PayloadPart[]) {
  const cleaned = b64.replace(/\s+/g, '');
  for (let i = 0; i < cleaned.length; i += B64_CHUNK) {
    const idx = Math.floor(i / B64_CHUNK);
    out.push({
      targetPath,
      b64: cleaned.slice(i, i + B64_CHUNK),
      marker: `__HPC_${targetPath.replace(/[^A-Za-z0-9]/g, '_')}_${idx.toString(36)}_${Math.random().toString(36).slice(2, 8)}__`,
    });
  }
}

async function uploadPayload(sandbox: any, parts: PayloadPart[]): Promise<void> {
  // Group parts by target so we send one `: > file.b64` truncate followed
  // by `--MARKER heredoc --MARKER` chunks. We also append a `base64 -d`
  // post-step via a final runCommand for each destination.
  const grouped = new Map<string, PayloadPart[]>();
  for (const p of parts) {
    if (!grouped.has(p.targetPath)) grouped.set(p.targetPath, []);
    grouped.get(p.targetPath)!.push(p);
  }

  // Create the target directory first — fresh sandboxes don't have /tmp/hpc.
  await sandbox.runCommand('mkdir -p /tmp/hpc');

  for (const [targetPath, chunks] of grouped) {
    // 1. Truncate the temp file. Use : > /tmp/hpc/<name>.b64 (no-op if missing).
    await sandbox.runCommand(`: > /tmp/hpc/${targetPath}.b64`);
    // 2. Append each chunk via heredoc.
    for (const chunk of chunks) {
      const cmd = `cat >> /tmp/hpc/${targetPath}.b64 <<'${chunk.marker}'\n${chunk.b64}\n${chunk.marker}`;
      await sandbox.runCommand(cmd);
    }
    // 3. base64 -d to materialize the actual file.
    await sandbox.runCommand(`base64 -d /tmp/hpc/${targetPath}.b64 > /tmp/hpc/${targetPath}`);
    if (targetPath.endsWith('.js')) {
      await sandbox.runCommand(`chmod +x /tmp/hpc/${targetPath} || true`);
    }
    // 4. Free the .b64 temp file.
    await sandbox.runCommand(`rm /tmp/hpc/${targetPath}.b64`);
  }

  // 5. If a bundle was uploaded, extract it now.
  const bundle = grouped.has('bundle.tar.gz');
  if (bundle) {
    await sandbox.runCommand(`mkdir -p /tmp/hpc/fixture && tar -xzf /tmp/hpc/bundle.tar.gz -C /tmp/hpc/fixture && rm /tmp/hpc/bundle.tar.gz`);
  }
}
