/**
 * Sandbox time-to-interactive benchmark. TTI = sandbox create through the
 * first command (`node -v`) succeeding, excluding destroy. Declarative —
 * exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * One workload, three launch shapes selected by `--mode` (the framework knob
 * that differs is just concurrency/stagger, so there is one file):
 *   sequential  one at a time (concurrency 1)
 *   staggered   all slots open, task N starting at N * staggerDelayMs (a ramp)
 *   burst       all slots open at once — this launches that many real
 *               sandboxes simultaneously, so raise the numbers deliberately
 *
 * `--mode` is unknown to @benchsdk/runner and passes through untouched, so we
 * parse it ourselves from process.argv; every other knob stays CLI-overridable.
 *
 *   bench run benchmarks/sandbox/tti.bench.ts
 *   bench run benchmarks/sandbox/tti.bench.ts --iterations 5 --provider e2b,modal
 *   bench run benchmarks/sandbox/tti.bench.ts --mode staggered --iterations 10 --concurrency 10 --stagger-delay-ms 200
 *   bench run benchmarks/sandbox/tti.bench.ts --mode burst --iterations 10 --concurrency 10
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { BenchmarkMode, ProviderConfig } from './types.js';
import { writeSandboxLegacyResults } from './legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREATE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DESTROY_TIMEOUT_MS = 15_000;

/**
 * Per-mode config, slug and results dir. The slugs and `results/` directory
 * names predate this file being one benchmark — they're kept verbatim so the
 * platform and the SVG/README pipeline see no rename. Legacy JSON labels burst
 * results 'concurrent' (see merge-results / generate-svg), which is also the
 * shape that carries the wall-clock fields.
 */
interface TtiModePreset {
  benchmarkSlug: string;
  benchmarkName: string;
  iterations: number;
  concurrency: number;
  staggerDelayMs?: number;
  resultsDir: string;
  /** Legacy JSON `mode` tag; sequential results carry none. */
  legacyMode?: BenchmarkMode;
}

const MODES: Record<'sequential' | 'staggered' | 'burst', TtiModePreset> = {
  sequential: {
    benchmarkSlug: 'sandbox-tti-local',
    benchmarkName: 'Sandbox TTI (local)',
    iterations: 2,
    concurrency: 1,
    resultsDir: 'sequential_tti',
  },
  staggered: {
    benchmarkSlug: 'sandbox-staggered-local',
    benchmarkName: 'Sandbox staggered TTI (local)',
    iterations: 3,
    concurrency: 3,
    staggerDelayMs: 200,
    resultsDir: 'staggered_tti',
    legacyMode: 'staggered',
  },
  burst: {
    benchmarkSlug: 'sandbox-burst-local',
    benchmarkName: 'Sandbox burst TTI (local)',
    iterations: 3,
    concurrency: 3,
    resultsDir: 'burst_tti',
    legacyMode: 'concurrent',
  },
};

type TtiMode = keyof typeof MODES;

/** Accepts both `--mode burst` and `--mode=burst`, as the runner's own flags do. */
function parseMode(argv: string[]): TtiMode {
  const inline = argv.find((a) => a.startsWith('--mode='));
  const idx = argv.indexOf('--mode');
  const value = inline !== undefined ? inline.slice('--mode='.length) : idx !== -1 ? argv[idx + 1] : 'sequential';
  if (value === undefined || !Object.hasOwn(MODES, value)) {
    console.error(`Invalid --mode "${value}". Valid modes: ${Object.keys(MODES).join(', ')}`);
    process.exit(1);
  }
  return value as TtiMode;
}

const { resultsDir, legacyMode, ...modeConfig } = MODES[parseMode(process.argv.slice(2))];

export const config = defineBenchmarkConfig({
  ...modeConfig,
  benchmarkKind: 'sandbox',
  participants: providers,
  onComplete: (outcome) =>
    writeSandboxLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, `../../results/${resultsDir}`),
      mode: legacyMode,
      staggerDelayMs: outcome.config.staggerDelayMs,
    }),
});

/** The slice of a provider's sandbox this workload actually touches. */
interface TtiSandbox {
  runCommand(command: string): Promise<{ exitCode: number; stderr?: string }>;
  destroy(): Promise<unknown>;
}

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, step, measure } = ctx;
  const compute = participant.createCompute();

  const start = performance.now();
  const sandbox = await step('create', () =>
    withTimeout<TtiSandbox>(
      compute.sandbox.create(participant.sandboxOptions),
      participant.timeout ?? CREATE_TIMEOUT_MS,
      'Sandbox creation timed out',
    ),
  );

  try {
    await step('exec.task', async () => {
      const result = await withTimeout(
        sandbox.runCommand('node -v'),
        COMMAND_TIMEOUT_MS,
        'First command execution timed out',
      );
      if (result.exitCode !== 0) {
        throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
      }
    });
    measure({ ttiMs: performance.now() - start });
  } finally {
    await step('destroy', () =>
      withTimeout(sandbox.destroy(), participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS, 'Destroy timeout'),
      { reportConcurrency: false },
    ).catch((err) => console.warn(`    [cleanup] destroy failed: ${formatError(err)}`));
  }
});
