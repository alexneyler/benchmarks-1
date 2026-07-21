// Load .env before any other imports so env vars are available at module evaluation time
import './env.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createBenchmarkClient } from '@computesdk/bench';
import { runBenchmark } from './sandbox/benchmark.js';
import { runConcurrentBenchmark } from './sandbox/concurrent.js';
import { runStaggeredBenchmark } from './sandbox/staggered.js';
import { runSequentialWithPlatformReport } from './sandbox/report-run.js';
import { runBurstWithPlatformReport } from './sandbox/report-run-burst.js';
import { runDaxBenchmark, writeDaxResultsJson } from './sandbox/dax-benchmark.js';
import { computeDaxCompositeScores } from './sandbox/dax-scoring.js';
import { runDaxWithPlatformReport } from './sandbox/report-run-dax.js';
import { runStorageBenchmark, writeStorageResultsJson } from './storage/benchmark.js';
import {
  runSnapshotForkBenchmark,
  writeSnapshotForkResultsJson,
  computeSnapshotForkCompositeScores,
} from './storage/snapshot-fork-benchmark.js';
import { runBrowserBenchmark, writeBrowserResultsJson } from './browser/benchmark.js';
import {
  emptySummary,
  navUrlForIteration,
  runThroughputBenchmark,
  runThroughputIteration,
  summarizeIterations,
  writeThroughputResultsJson,
} from './browser/throughput-benchmark.js';
import { printResultsTable, writeResultsJson } from './sandbox/table.js';
import type { BenchmarkConfig } from './sandbox/bench-config.js';
import { providers } from './sandbox/providers.js';
import { storageProviders } from './storage/providers.js';
import { browserProviders } from './browser/providers.js';
import { throughputProviders } from './browser/throughput-providers.js';
import { computeCompositeScores } from './sandbox/scoring.js';
import { computeStorageCompositeScores } from './storage/scoring.js';
import { computeBrowserCompositeScores } from './browser/scoring.js';
import { computeThroughputCompositeScores } from './browser/throughput-scoring.js';
import type { BenchmarkResult, BenchmarkMode } from './sandbox/types.js';
import type { DaxBenchmarkResult } from './sandbox/dax-types.js';
import type { StorageBenchmarkResult } from './storage/types.js';
import type { SnapshotForkBenchmarkResult } from './storage/snapshot-fork-types.js';
import type { DatasetPreset } from './storage/snapshot-fork-types.js';
import type { BrowserBenchmarkResult } from './browser/types.js';
import type { ThroughputBenchmarkResult, ThroughputTimingResult } from './browser/throughput-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const args = process.argv.slice(2);

// `npm run bench <config-file>.ts` — an alternative to flag-based invocation
// where mode/providers/report/dryRun all live in the file itself (see
// sandbox/bench-config.ts). Detected as a positional first arg that isn't a
// flag and looks like a TS/JS file; short-circuited in main() before any
// flag-based parsing/validation below is applied.
const configFileArg = args[0] && !args[0].startsWith('-') && /\.(m?[jt]s)$/.test(args[0]) ? args[0] : undefined;

// --provider accepts a comma-separated list (e.g. --provider e2b,daytona,modal)
// to run several providers in one invocation; omit --provider to run all.
const providerFilterArg = getArgValue(args, '--provider');
const providerNames = providerFilterArg
  ? providerFilterArg.split(',').map((s) => s.trim()).filter(Boolean)
  : undefined;
const iterationsArg = getArgValue(args, '--iterations');
const iterations = parseInt(iterationsArg || '100', 10);
const rawMode = getArgValue(args, '--mode');
const concurrency = parseInt(getArgValue(args, '--concurrency') || '100', 10);
const storageConcurrency = parseInt(getArgValue(args, '--storage-concurrency') || '1', 10);
const staggerDelay = parseInt(getArgValue(args, '--stagger-delay') || '200', 10);
const fileSizeArg = getArgValue(args, '--file-size') || '10MB';
const datasetArg = getArgValue(args, '--dataset') || 'small';

// --report streams this run to a real benchmarks-platform instance (via
// @computesdk/bench) instead of only writing local JSON — see
// sandbox/report-run.ts, sandbox/report-run-burst.ts, and
// sandbox/report-run-dax.ts. Supported for --mode sequential, --mode burst
// (or its --mode concurrent alias), and --mode dax.
const reportToPlatform = args.includes('--report');
const platformBaseUrl = (process.env.BENCHMARKS_PLATFORM_URL || 'http://localhost:3000').replace(/\/+$/, '') + '/api/v1';
const platformOrgSlug = process.env.BENCHMARKS_PLATFORM_ORG_SLUG || 'computesdk';
const platformBenchmarkSlug = getArgValue(args, '--benchmark-slug') || defaultBenchmarkSlugForMode(rawMode);
const platformBenchmarkName = getArgValue(args, '--benchmark-name') || defaultBenchmarkNameForMode(rawMode);

/** Default platform benchmark slug for a given mode, shared by the flag path and the config-file path. */
function defaultBenchmarkSlugForMode(mode: string | undefined): string {
  if (mode === 'burst' || mode === 'concurrent') return 'sandbox-burst-local';
  if (mode === 'dax') return 'sandbox-dax-local';
  return 'sandbox-tti-local';
}

/** Default platform dashboard display name for a given mode, shared by the flag path and the config-file path. */
function defaultBenchmarkNameForMode(mode: string | undefined): string {
  if (mode === 'burst' || mode === 'concurrent') return 'Sandbox burst TTI (local)';
  if (mode === 'dax') return 'Dax sandbox benchmark (local)';
  return 'Sandbox TTI (local)';
}

/** Settings a single core-sandbox-mode run (sequential/staggered/burst/dax) needs, whether sourced from CLI flags or a config file. */
interface CoreRunSettings {
  iterations: number;
  concurrency: number;
  staggerDelay: number;
  reportToPlatform: boolean;
  platformBaseUrl: string;
  platformOrgSlug: string;
  platformBenchmarkSlug: string;
  platformBenchmarkName: string;
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/** Filters `all` down to the requested `names`, exiting with a clear error if any name is unrecognized. Returns `all` unchanged when `names` is undefined (no --provider filter). */
function selectProviders<T extends { name: string }>(all: T[], names: string[] | undefined): T[] {
  if (!names) return all;
  const unknown = names.filter((n) => !all.some((p) => p.name === n));
  if (unknown.length > 0) {
    console.error(`Unknown provider(s): ${unknown.join(', ')}`);
    console.error(`Available: ${all.map((p) => p.name).join(', ')}`);
    process.exit(1);
  }
  return all.filter((p) => names.includes(p.name));
}

/** Resolve which modes to run */
function getModesToRun(): BenchmarkMode[] | ['storage'] | ['snapshot-fork'] | ['browser'] | ['browser-throughput'] | ['dax'] {
  if (!rawMode) return ['sequential', 'staggered', 'burst'];
  if (rawMode === 'storage') return ['storage'];
  if (rawMode === 'snapshot-fork') return ['snapshot-fork'];
  if (rawMode === 'browser') return ['browser'];
  if (rawMode === 'browser-throughput') return ['browser-throughput'];
  if (rawMode === 'dax') return ['dax'];
  const m = rawMode === 'concurrent' ? 'burst' : rawMode as BenchmarkMode;
  return [m];
}

/** Map mode to results subdirectory name */
function modeToDir(m: BenchmarkMode | 'storage' | 'snapshot-fork' | 'browser-throughput' | 'dax'): string {
  switch (m) {
    case 'sequential': return 'sequential_tti';
    case 'staggered': return 'staggered_tti';
    case 'burst':
    case 'concurrent': return 'burst_tti';
    case 'storage': return 'storage';
    case 'snapshot-fork': return 'snapshot-fork';
    case 'browser-throughput': return 'browser-throughput';
    case 'dax': return 'dax';
    default: return `${m}_tti`;
  }
}

/**
 * Creates ONE platform run shared across every provider in `participantNames`
 * (instead of each provider getting its own run+participant) — so a single
 * `--report` invocation covering multiple providers shows up as one run with
 * multiple participants on the dashboard, comparable side by side. Every
 * participant gets the same `totalTasks`/`workerCount`, which matches how
 * this CLI already applies one `--iterations`/`--concurrency` value across
 * all providers in a single invocation.
 */
async function createSharedPlatformRun(input: {
  benchmarkDisplayName: string;
  runName: string;
  totalTasks: number;
  participantNames: string[];
  benchmarkSlug: string;
  baseUrl: string;
  orgSlug: string;
}): Promise<{ runId: string }> {
  const client = createBenchmarkClient({ baseUrl: input.baseUrl });
  await client.upsertBenchmark(input.benchmarkSlug, {
    name: input.benchmarkDisplayName,
    kind: 'sandbox',
  });
  const { run } = await client.createRun(input.benchmarkSlug, {
    name: input.runName,
    totalTasks: input.totalTasks,
    workerCount: 1,
    participants: input.participantNames,
  });
  const dashboardUrl = `${input.baseUrl.replace(/\/api\/v1\/?$/, '')}/${input.orgSlug}/benchmarks/${input.benchmarkSlug}/runs/${run.id}`;
  console.log(`  Run created: ${run.id}  (participants: ${input.participantNames.join(', ')})`);
  console.log(`  View at: ${dashboardUrl}\n`);
  return { runId: run.id };
}

async function runMode(mode: BenchmarkMode, toRun: typeof providers, settings: CoreRunSettings): Promise<void> {
  if (mode === 'sequential' && settings.reportToPlatform) {
    const { runId } = await createSharedPlatformRun({
      benchmarkDisplayName: settings.platformBenchmarkName,
      runName: `sequential — ${settings.iterations} iterations`,
      totalTasks: settings.iterations,
      participantNames: toRun.map((p) => p.name),
      benchmarkSlug: settings.platformBenchmarkSlug,
      baseUrl: settings.platformBaseUrl,
      orgSlug: settings.platformOrgSlug,
    });
    for (const providerConfig of toRun) {
      await runSequentialWithPlatformReport(providerConfig, settings.iterations, {
        benchmarkSlug: settings.platformBenchmarkSlug,
        baseUrl: settings.platformBaseUrl,
        orgSlug: settings.platformOrgSlug,
      }, runId);
    }
    return;
  }

  if (mode === 'burst' && settings.reportToPlatform) {
    const { runId } = await createSharedPlatformRun({
      benchmarkDisplayName: settings.platformBenchmarkName,
      runName: `burst — concurrency ${settings.concurrency}`,
      totalTasks: settings.concurrency,
      participantNames: toRun.map((p) => p.name),
      benchmarkSlug: settings.platformBenchmarkSlug,
      baseUrl: settings.platformBaseUrl,
      orgSlug: settings.platformOrgSlug,
    });
    for (const providerConfig of toRun) {
      await runBurstWithPlatformReport(providerConfig, settings.concurrency, {
        benchmarkSlug: settings.platformBenchmarkSlug,
        baseUrl: settings.platformBaseUrl,
        orgSlug: settings.platformOrgSlug,
      }, runId);
    }
    return;
  }

  console.log('\n' + '='.repeat(70));
  console.log(`  MODE: ${mode.toUpperCase()}`);
  if (mode === 'sequential') {
    console.log(`  Iterations per provider: ${settings.iterations}`);
  } else {
    console.log(`  Concurrency: ${settings.concurrency} sandboxes`);
    if (mode === 'staggered') {
      console.log(`  Stagger delay: ${settings.staggerDelay}ms`);
    }
  }
  console.log('='.repeat(70));

  const results: BenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    switch (mode) {
      case 'sequential': {
        const result = await runBenchmark({ ...providerConfig, iterations: settings.iterations });
        results.push(result);
        break;
      }
      case 'staggered': {
        const result = await runStaggeredBenchmark({
          ...providerConfig,
          concurrency: settings.concurrency,
          staggerDelayMs: settings.staggerDelay,
        });
        results.push(result);
        break;
      }
      case 'burst':
      case 'concurrent': {
        const result = await runConcurrentBenchmark({ ...providerConfig, concurrency: settings.concurrency });
        results.push(result);
        break;
      }
    }
  }

  // Compute composite scores
  computeCompositeScores(results);

  // Print comparison table
  printResultsTable(results);

  // Write JSON results to mode-specific subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const subDir = modeToDir(mode);
  const resultsDir = path.resolve(__dirname, `../results/${subDir}`);
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeResultsJson(results, outPath);

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runStorage(toRun: typeof storageProviders, fileSizeLabel: string): Promise<void> {
  const { FILE_SIZE_BYTES } = await import('./storage/types.js');
  const validSizes = Object.keys(FILE_SIZE_BYTES);
  if (!(fileSizeLabel in FILE_SIZE_BYTES)) {
    console.error(`Invalid --file-size "${fileSizeLabel}". Valid sizes: ${validSizes.join(', ')}`);
    process.exit(1);
  }
  const fileSizeBytes = FILE_SIZE_BYTES[fileSizeLabel as keyof typeof FILE_SIZE_BYTES];

  console.log('\n' + '='.repeat(70));
  console.log('  MODE: STORAGE');
  console.log(`  File size: ${fileSizeLabel}`);
  console.log(`  Iterations per provider: ${iterations}`);
  console.log(`  Concurrency per provider: ${storageConcurrency}`);
  console.log('='.repeat(70));

  const results: StorageBenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    const result = await runStorageBenchmark({ ...providerConfig, iterations, concurrency: storageConcurrency }, fileSizeBytes);
    results.push(result);
  }

  // Compute composite scores
  computeStorageCompositeScores(results);

  // Print comparison table (TODO: add storage-specific table printer)
  console.log('\n--- Storage Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Download: ${(r.summary.downloadMs.median / 1000).toFixed(2)}s (median), ${r.summary.throughputMbps.median.toFixed(2)} Mbps`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  // Write JSON results to storage subdirectory with file size
  const timestamp = new Date().toISOString().slice(0, 10);
  const subDir = modeToDir('storage');
  const sizeDir = path.resolve(__dirname, `../results/${subDir}/${fileSizeLabel.toLowerCase()}`);
  fs.mkdirSync(sizeDir, { recursive: true });

  const outPath = path.join(sizeDir, `${timestamp}.json`);
  await writeStorageResultsJson(results, outPath);

  // Copy results to latest.json
  const latestPath = path.join(sizeDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runSnapshotFork(toRun: typeof storageProviders, datasetLabel: string): Promise<void> {
  const { DATASET_PRESETS } = await import('./storage/snapshot-fork-types.js');
  const validDatasets = Object.keys(DATASET_PRESETS);
  if (!(datasetLabel in DATASET_PRESETS)) {
    console.error(`Invalid --dataset "${datasetLabel}". Valid datasets: ${validDatasets.join(', ')}`);
    process.exit(1);
  }
  const dataset = datasetLabel as DatasetPreset;
  const spec = DATASET_PRESETS[dataset];

  // Each iteration seeds real objects and creates real snapshots/forks, so this
  // mode is far more expensive than the upload/download benchmark. Default to a
  // small count unless the user explicitly overrode --iterations.
  const sfIterations = iterationsArg ? iterations : 10;

  console.log('\n' + '='.repeat(70));
  console.log('  MODE: SNAPSHOT-FORK');
  console.log(`  Dataset: ${dataset} (${spec.objectCount} × ${(spec.objectSizeBytes / 1024 / 1024).toFixed(0)}MB)`);
  console.log(`  Iterations per provider: ${sfIterations}`);
  console.log('='.repeat(70));

  const results: SnapshotForkBenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    // Some providers need a different bucket/credentials for snapshot-fork than
    // for upload/download (e.g. Tigris's snapshot-enabled bucket); apply it here.
    const { snapshotFork, ...base } = providerConfig;
    const config = snapshotFork ? { ...base, ...snapshotFork } : base;
    const result = await runSnapshotForkBenchmark({ ...config, iterations: sfIterations }, dataset);
    results.push(result);
  }

  computeSnapshotForkCompositeScores(results);

  console.log('\n--- Snapshot/Fork Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error && i.verified).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Snapshot create: ${(r.summary.snapshotCreateMs.median / 1000).toFixed(2)}s (median)`);
    console.log(`  Fork from snapshot: ${(r.summary.forkFromSnapshotMs.median / 1000).toFixed(2)}s (median)`);
    console.log(`  Fork from live: ${(r.summary.forkFromLiveMs.median / 1000).toFixed(2)}s (median)`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  const subDir = modeToDir('snapshot-fork');
  const datasetDir = path.resolve(__dirname, `../results/${subDir}/${dataset}`);
  fs.mkdirSync(datasetDir, { recursive: true });

  const outPath = path.join(datasetDir, `${timestamp}.json`);
  await writeSnapshotForkResultsJson(results, outPath);

  const latestPath = path.join(datasetDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runDax(toRun: typeof providers, daxIterations: number): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('  MODE: DAX (disk / CPU / pause-resume)');
  console.log(`  Iterations per provider: ${daxIterations}`);
  console.log('='.repeat(70));

  const results: DaxBenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    const result = await runDaxBenchmark({ ...providerConfig, iterations: daxIterations });
    results.push(result);
  }

  // Compute composite scores
  computeDaxCompositeScores(results);

  // Print summary
  console.log('\n--- Dax Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Disk: ${r.summary.diskSeqWriteMbps.median.toFixed(1)} Mbps write / ${r.summary.diskSeqReadMbps.median.toFixed(1)} Mbps read / ${r.summary.diskFsyncLatencyMs.median.toFixed(2)}ms fsync (median)`);
    console.log(`  CPU: ${r.summary.cpuOpsPerSec.median.toFixed(0)} ops/s, ${r.summary.cpuStealPercent.median.toFixed(2)}% steal (median)`);
    console.log(`  Pause/Resume: ${r.pauseResumeSupported ? `${r.summary.pauseMs!.median.toFixed(0)}ms pause / ${r.summary.resumeMs!.median.toFixed(0)}ms resume (median)` : 'not supported'}`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  // Write JSON results to dax subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(__dirname, '../results/dax');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeDaxResultsJson(results, outPath);

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

/** Dax's report/local split, mirroring runMode's — extracted so the config-file path can drive it without duplicating the branch. */
async function runDaxMode(toRun: typeof providers, settings: CoreRunSettings): Promise<void> {
  if (settings.reportToPlatform) {
    const { runId } = await createSharedPlatformRun({
      benchmarkDisplayName: settings.platformBenchmarkName,
      runName: `dax — ${settings.iterations} iterations`,
      totalTasks: settings.iterations,
      participantNames: toRun.map((p) => p.name),
      benchmarkSlug: settings.platformBenchmarkSlug,
      baseUrl: settings.platformBaseUrl,
      orgSlug: settings.platformOrgSlug,
    });
    for (const providerConfig of toRun) {
      await runDaxWithPlatformReport(providerConfig, settings.iterations, {
        benchmarkSlug: settings.platformBenchmarkSlug,
        baseUrl: settings.platformBaseUrl,
        orgSlug: settings.platformOrgSlug,
      }, runId);
    }
  } else {
    await runDax(toRun, settings.iterations);
  }
}

async function runBrowser(toRun: typeof browserProviders): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('  MODE: BROWSER');
  console.log(`  Iterations per provider: ${iterations}`);
  console.log('='.repeat(70));

  const results: BrowserBenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    const result = await runBrowserBenchmark({ ...providerConfig, iterations });
    results.push(result);
  }

  // Compute composite scores
  computeBrowserCompositeScores(results);

  // Print summary
  console.log('\n--- Browser Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Total: ${(r.summary.totalMs.median / 1000).toFixed(2)}s (median) — create ${(r.summary.createMs.median / 1000).toFixed(2)}s + connect ${(r.summary.connectMs.median / 1000).toFixed(2)}s + navigate ${(r.summary.navigateMs.median / 1000).toFixed(2)}s + release ${(r.summary.releaseMs.median / 1000).toFixed(2)}s`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  // Write JSON results to browser subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(__dirname, '../results/browser');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  const timeoutMs = toRun.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;
  await writeBrowserResultsJson(results, outPath, { timeoutMs });

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runBrowserThroughput(toRun: typeof throughputProviders): Promise<void> {
  // Only override when --iterations was explicitly passed; otherwise let
  // runThroughputBenchmark apply its own default (100 sessions per provider).
  const throughputIterations = iterationsArg ? iterations : undefined;
  const iterationsToRun = throughputIterations ?? 100;

  console.log('\n' + '='.repeat(70));
  console.log('  MODE: BROWSER THROUGHPUT');
  console.log(`  Iterations per provider: ${iterationsToRun}`);
  console.log('='.repeat(70));

  const results: ThroughputBenchmarkResult[] = [];

  if (providerNames || toRun.length === 1) {
    for (const providerConfig of toRun) {
      const result = await runThroughputBenchmark(
        throughputIterations !== undefined
          ? { ...providerConfig, iterations: throughputIterations }
          : providerConfig,
      );
      results.push(result);
    }
  } else {
    const resultByProvider = new Map<string, ThroughputBenchmarkResult>();
    const active: Array<{
      name: string;
      provider: any;
      timeout: number;
      sessionCreateOptions: Record<string, unknown>;
      iterations: ThroughputTimingResult[];
    }> = [];

    for (const providerConfig of toRun) {
      const missingVars = providerConfig.requiredEnvVars.filter(v => !process.env[v]);
      if (missingVars.length > 0) {
        resultByProvider.set(providerConfig.name, {
          provider: providerConfig.name,
          mode: 'browser-throughput',
          iterations: [],
          summary: emptySummary(),
          skipped: true,
          skipReason: `Missing: ${missingVars.join(', ')}`,
        });
        continue;
      }

      active.push({
        name: providerConfig.name,
        provider: providerConfig.createBrowserProvider(),
        timeout: providerConfig.timeout ?? 120_000,
        sessionCreateOptions: providerConfig.sessionCreateOptions ?? {},
        iterations: [],
      });
    }

    console.log(`\n--- Interleaved Throughput Benchmark (${iterationsToRun} rounds × ${active.length} providers) ---`);
    console.log('Provider      Sess  Create   Connect  Task     Release  Total    APS    Actions');
    console.log('────────────  ────  ───────  ───────  ───────  ───────  ───────  ─────  ───────');

    for (let i = 0; i < iterationsToRun; i++) {
      // Same URL for every provider in this round; different URL each round.
      const navigateUrl = navUrlForIteration(i);
      for (const state of active) {
        const result = await runThroughputIteration(state.provider, state.timeout, state.sessionCreateOptions, navigateUrl);
        state.iterations.push(result);

        const pad = (n: number) => `${Math.round(n)}ms`.padStart(7);
        const aps = result.actionsPerSecond.toFixed(1).padStart(5);
        const status = `${result.actionsCompleted}/50`;
        const errSuffix = result.error ? `  ✗ ${result.error.slice(0, 50)}` : '';
        console.log(
          `${state.name.padEnd(12)}  ${String(i + 1).padStart(4)}  ${pad(result.createMs)}  ${pad(result.connectMs)}  ${pad(result.taskMs)}  ${pad(result.releaseMs)}  ${pad(result.totalMs)}  ${aps}  ${status}${errSuffix}`,
        );
      }
    }

    for (const state of active) {
      resultByProvider.set(state.name, {
        provider: state.name,
        mode: 'browser-throughput',
        iterations: state.iterations,
        summary: summarizeIterations(state.iterations),
      });
    }

    for (const providerConfig of toRun) {
      const result = resultByProvider.get(providerConfig.name);
      if (result) results.push(result);
    }
  }

  // Compute composite scores
  computeThroughputCompositeScores(results);

  // Print summary
  console.log('\n--- Browser Throughput Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const expectedActions = 50;
    const fullSuccess = r.iterations.filter(i => !i.error && i.actionsCompleted === expectedActions).length;
    const total = r.iterations.length;
    const aps = r.summary.actionsPerSecond.median;
    const taskMed = r.summary.taskMs.median;
    const screenshotMed = r.summary.perActionType.screenshot?.median ?? 0;
    console.log(`${r.provider}:`);
    console.log(`  APS: ${aps.toFixed(2)}/s (median) — task ${(taskMed / 1000).toFixed(2)}s, screenshot ${Math.round(screenshotMed)}ms`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${fullSuccess}/${total} OK)`);
  }

  // Write JSON results to browser-throughput subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(__dirname, '../results/browser-throughput');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  const timeoutMs = toRun.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;
  await writeThroughputResultsJson(results, outPath, { timeoutMs });

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

const REPORTABLE_RAW_MODES = new Set(['sequential', 'burst', 'concurrent', 'dax']);

async function main() {
  if (configFileArg) {
    await runFromConfigFile(configFileArg);
    return;
  }

  if (reportToPlatform && !REPORTABLE_RAW_MODES.has(rawMode ?? '')) {
    console.error('--report currently only supports --mode sequential, --mode burst, or --mode dax (pass one explicitly, e.g. --mode dax).');
    process.exit(1);
  }

  // A bare --report --mode burst would otherwise silently inherit the
  // --concurrency default (100), reporting 100 real concurrent sandboxes to
  // the platform per provider — require the caller to say so explicitly.
  const concurrencyArgProvided = args.includes('--concurrency');
  if (reportToPlatform && (rawMode === 'burst' || rawMode === 'concurrent') && !concurrencyArgProvided) {
    console.error(
      `--report --mode burst requires an explicit --concurrency (no implicit default of ${concurrency}) ` +
      `to avoid accidentally launching ${concurrency} concurrent sandboxes per provider. Pass e.g. --concurrency 5.`,
    );
    process.exit(1);
  }

  const modes = getModesToRun();

  // Handle browser-throughput mode separately
  if (modes[0] === 'browser-throughput') {
    console.log('ComputeSDK Browser Throughput Benchmarks');
    console.log(`Date: ${new Date().toISOString()}\n`);

    const toRun = selectProviders(throughputProviders, providerNames);

    if (toRun.length === 0) {
      console.error('No browser-throughput providers configured. Add entries to src/browser/throughput-providers.ts.');
      process.exit(1);
    }

    await runBrowserThroughput(toRun);
    console.log('\nAll browser-throughput tests complete.');
    return;
  }

  // Handle browser mode separately
  if (modes[0] === 'browser') {
    console.log('ComputeSDK Browser Provider Benchmarks');
    console.log(`Date: ${new Date().toISOString()}\n`);

    // Filter browser providers
    const toRun = selectProviders(browserProviders, providerNames);

    if (toRun.length === 0) {
      console.error('No browser providers configured. Add entries to src/browser/providers.ts.');
      process.exit(1);
    }

    await runBrowser(toRun);
    console.log('\nAll browser tests complete.');
    return;
  }

  // Handle storage mode separately
  if (modes[0] === 'storage') {
    console.log('ComputeSDK Storage Provider Benchmarks');
    console.log(`File size: ${fileSizeArg}`);
    console.log(`Date: ${new Date().toISOString()}\n`);

    // Filter storage providers
    const toRun = selectProviders(storageProviders, providerNames);

    await runStorage(toRun, fileSizeArg);
    console.log('\nAll storage tests complete.');
    return;
  }

  // Handle snapshot/fork mode separately
  if (modes[0] === 'snapshot-fork') {
    console.log('ComputeSDK Storage Snapshot/Fork Benchmarks');
    console.log(`Dataset: ${datasetArg}`);
    console.log(`Date: ${new Date().toISOString()}\n`);

    const toRun = selectProviders(storageProviders, providerNames);

    await runSnapshotFork(toRun, datasetArg);
    console.log('\nAll snapshot/fork tests complete.');
    return;
  }

  // Handle dax mode separately (disk / CPU / pause-resume sub-test, same
  // provider registry as the regular sandbox benchmark)
  if (modes[0] === 'dax') {
    console.log('ComputeSDK Dax Benchmark (disk / CPU / pause-resume)');
    console.log(`Date: ${new Date().toISOString()}\n`);

    const toRun = selectProviders(providers, providerNames);

    await runDaxMode(toRun, coreRunSettings());
    console.log('\nAll dax tests complete.');
    return;
  }

  console.log('ComputeSDK Sandbox Provider Benchmarks');
  console.log(`Tests to run: ${modes.join(', ')}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  // Filter sandbox providers
  const toRun = selectProviders(providers, providerNames);

  const settings = coreRunSettings();
  for (const mode of modes) {
    await runMode(mode as BenchmarkMode, toRun, settings);
  }

  console.log('\nAll tests complete.');
}

/** Builds CoreRunSettings from the module-level flag-parsed values (the flag-path counterpart to runFromConfigFile's settings construction). */
function coreRunSettings(): CoreRunSettings {
  return {
    iterations,
    concurrency,
    staggerDelay,
    reportToPlatform,
    platformBaseUrl,
    platformOrgSlug,
    platformBenchmarkSlug,
    platformBenchmarkName,
  };
}

/** Loads a config file exporting `defineBenchmark({...})` (default or named `config` export) and dispatches to the same runMode/runDaxMode logic the flag path uses. */
async function runFromConfigFile(configPath: string): Promise<void> {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Benchmark config file not found: ${resolvedPath}`);
    process.exit(1);
  }

  const mod = await import(pathToFileURL(resolvedPath).href);
  const config: BenchmarkConfig | undefined = mod.default ?? mod.config;
  if (!config) {
    console.error(`${resolvedPath} must \`export default defineBenchmark({...})\` (or a named \`config\` export).`);
    process.exit(1);
  }

  const mode = config.mode === 'concurrent' ? 'burst' : config.mode;
  const selected = selectProviders(providers, config.providers);
  const toRun = config.task
    ? selected.map((p) => ({ ...p, task: config.task, taskTimeoutMs: config.taskTimeoutMs ?? p.taskTimeoutMs }))
    : selected;
  if (toRun.length === 0) {
    console.error('No providers to run.');
    process.exit(1);
  }

  const settings: CoreRunSettings = {
    iterations: config.iterations ?? 100,
    concurrency: config.concurrency ?? 100,
    staggerDelay: config.staggerDelayMs ?? 200,
    reportToPlatform: !!config.report,
    platformBaseUrl: (config.report?.baseUrl ?? process.env.BENCHMARKS_PLATFORM_URL ?? 'http://localhost:3000').replace(/\/+$/, '') + '/api/v1',
    platformOrgSlug: config.report?.orgSlug ?? process.env.BENCHMARKS_PLATFORM_ORG_SLUG ?? 'computesdk',
    platformBenchmarkSlug: config.report?.benchmarkSlug ?? defaultBenchmarkSlugForMode(mode),
    platformBenchmarkName: config.report?.name ?? defaultBenchmarkNameForMode(mode),
  };

  console.log('ComputeSDK Sandbox Provider Benchmarks (config file)');
  console.log(`Config: ${resolvedPath}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  if (config.dryRun) {
    printDryRunSummary(resolvedPath, config, mode, toRun, settings);
    return;
  }

  if (mode === 'dax') {
    await runDaxMode(toRun, settings);
  } else {
    await runMode(mode as BenchmarkMode, toRun, settings);
  }

  console.log('\nAll tests complete.');
}

function printDryRunSummary(
  configPath: string,
  config: BenchmarkConfig,
  mode: string,
  toRun: typeof providers,
  settings: CoreRunSettings,
): void {
  console.log('='.repeat(70));
  console.log('  DRY RUN — computesdk-benchmarks (config file)');
  console.log('='.repeat(70));
  console.log(`  Config file:  ${configPath}`);
  console.log(`  Mode:         ${mode}`);
  const providerLines = toRun.map((p) => {
    const missing = p.requiredEnvVars.filter((v) => !process.env[v]);
    return missing.length === 0 ? `${p.name} (env OK)` : `${p.name} (SKIP — missing ${missing.join(', ')})`;
  });
  console.log(`  Providers:    ${providerLines.join(', ')}`);
  if (mode === 'sequential' || mode === 'dax') {
    console.log(`  Iterations:   ${settings.iterations}`);
  } else {
    console.log(`  Concurrency:  ${settings.concurrency}`);
    if (mode === 'staggered') console.log(`  Stagger delay: ${settings.staggerDelay}ms`);
  }
  if (config.report) {
    console.log(`  Report:       yes — benchmarkSlug=${settings.platformBenchmarkSlug}  name="${settings.platformBenchmarkName}"  baseUrl=${settings.platformBaseUrl}  orgSlug=${settings.platformOrgSlug}`);
  } else {
    console.log('  Report:       no (local results only)');
  }
  console.log('='.repeat(70));
  console.log('DRY RUN: no sandboxes created, no results written, no platform run created.');
  console.log('Re-run with dryRun: false (or remove it) to execute.');
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
