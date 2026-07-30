/**
 * The author-facing entrypoint. Verb first, then the noun it acts on:
 *
 *   bench run <file.bench.ts> [--flags]     execute a benchmark
 *   bench create benchmark <slug>           declare a benchmark on the platform
 *   bench create run --benchmark <slug>     open a run, printing its id
 *
 * `run` imports a benchmark module, reads its `config` and `task` exports and
 * drives `runBenchmark`; CLI flags override the config's knobs and
 * `config.onComplete` (if any) fires once the run finishes. With `--run-id` it
 * reports into a run opened by `create run` instead of opening its own, so one
 * process per provider — in parallel, each claiming its own worker — still ends
 * up in a single run the platform can rank them in.
 *
 * `create` only talks to the platform: no bench file to load (it's just a
 * source of defaults) and no provider credentials.
 *
 * The executable wrapper lives in `bin.ts`; this module has no side effects so
 * it can be unit-tested by calling `runBenchmarkFile` directly.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBenchmark, createRun, mergeConfig, parseCliArgs, runBenchmark } from './runner.js';
import { NoAvailableParticipantsError } from './no-available-participants.js';
import type { BaseParticipant } from '@benchsdk/client';
import type { BenchmarkConfig, BenchmarkTask } from './bench-config.js';

const USAGE =
  'Usage:\n' +
  '  bench run <file.bench.ts> [--benchmark slug] [--provider a,b] [--run-id id]\n' +
  '      [--iterations N] [--concurrency N] [--stagger-delay-ms N] [--group-by participant|round]\n' +
  "  bench create benchmark <slug> [--name 'My benchmark'] [--kind sandbox]\n" +
  '  bench create run [file.bench.ts] [--benchmark slug] [--iterations N]';

/** A benchmark module is expected to export `config` and `task`. */
interface BenchmarkModule {
  config?: unknown;
  task?: unknown;
  default?: unknown;
}

function isBenchmarkConfig(value: unknown): value is BenchmarkConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { benchmarkSlug?: unknown; participants?: unknown };
  return typeof candidate.benchmarkSlug === 'string' && Array.isArray(candidate.participants);
}

async function loadConfig(file: string): Promise<BenchmarkConfig> {
  const mod = (await import(pathToFileURL(resolve(process.cwd(), file)).href)) as BenchmarkModule;
  if (!isBenchmarkConfig(mod.config)) {
    throw new Error(`${file} must export a \`config\` created with defineBenchmarkConfig (with participants).`);
  }
  return mod.config;
}

/** `bench create <benchmark|run> ...`. Prints created run ids on stdout, alone, so callers can capture them. */
async function create(argv: string[]): Promise<void> {
  const [noun, ...rest] = argv;

  if (noun === 'benchmark') {
    const [slug] = rest;
    if (!slug || slug.startsWith('-')) throw new Error(USAGE);
    const args = parseCliArgs(rest);
    await createBenchmark(slug, { name: args.name, kind: args.kind });
    console.error(`Benchmark ready: ${slug}`);
    return;
  }

  if (noun === 'run') {
    // The file, when given, only supplies defaults for the flags below.
    const file = rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined;
    const args = parseCliArgs(file ? rest.slice(1) : rest);
    const fileConfig = file ? await loadConfig(file) : undefined;
    const benchmarkSlug = args.benchmark ?? fileConfig?.benchmarkSlug;
    if (!benchmarkSlug) throw new Error('bench create run needs --benchmark <slug> (or a file to read it from).');
    const iterations = fileConfig ? mergeConfig(fileConfig, args).iterations : args.iterations;
    if (!iterations) throw new Error('bench create run needs --iterations N (or a file to read it from).');

    const { runId, dashboardUrl } = await createRun({ benchmarkSlug, iterations });
    console.error(`Run created: ${runId}\nView at: ${dashboardUrl}`);
    console.log(runId);
    return;
  }

  throw new Error(USAGE);
}

/**
 * Dispatches one CLI invocation. Throws on bad usage / invalid exports and lets
 * `NoAvailableParticipantsError` propagate so the caller can map it to a clean
 * exit. Does not call `process.exit`.
 */
export async function runBenchmarkFile(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === 'create') return create(rest);

  const [file, ...flags] = rest;
  if (command !== 'run' || !file) throw new Error(USAGE);

  const mod = (await import(pathToFileURL(resolve(process.cwd(), file)).href)) as BenchmarkModule;
  const config = mod.config;
  const task = mod.task ?? mod.default;

  if (!isBenchmarkConfig(config)) {
    throw new Error(`${file} must export a \`config\` created with defineBenchmarkConfig (with participants).`);
  }
  if (typeof task !== 'function') {
    throw new Error(`${file} must export a \`task\` created with defineTask.`);
  }

  await runBenchmark(config as BenchmarkConfig<BaseParticipant>, task as BenchmarkTask<BaseParticipant>, flags);
}

/** Executable entry: runs the file and maps outcomes to process exit codes. */
export async function run(argv: string[]): Promise<void> {
  try {
    await runBenchmarkFile(argv);
    // Provider SDKs can leave sockets/timers open; exit explicitly so a
    // finished run doesn't hang.
    process.exit(0);
  } catch (err) {
    if (err instanceof NoAvailableParticipantsError) {
      console.log(err.message);
      process.exit(0);
    }
    console.error('Benchmark failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
