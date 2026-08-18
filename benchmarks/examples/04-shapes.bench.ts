/**
 * Shapes benchmark.
 *
 * Demonstrates `shapes`: named variants of the same benchmark that swap the
 * platform slug/name and any stable distinguishing knob (e.g. stagger delay).
 * Scale knobs such as `iterations` and `concurrency` are still overridden from
 * the CLI, so one file can back several platform benchmarks.
 *
 * Run the quick variant:
 *   bench run benchmarks/examples/04-shapes.bench.ts --shape quick --iterations 2 --concurrency 1
 *
 * Run the thorough variant:
 *   bench run benchmarks/examples/04-shapes.bench.ts --shape thorough --iterations 10 --concurrency 3
 *
 * Add `--no-ingest` to run without a platform endpoint or API key.
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { createNoopParticipant } from './participants.js';

/**
 * The base config defines the default identity. `shapes` then declares variants.
 *
 * - `quick` reports under a different platform slug and has no stagger delay.
 * - `thorough` reports under another slug and staggers each task start by 250ms.
 *
 * `--shape quick` swaps the identity before the run is created, so the platform
 * records the run under `examples-shapes-quick` instead of `examples-shapes`.
 *
 * `iterations` and `concurrency` are not part of the shape because they are
 * environment-specific scale knobs; override them from the CLI per run.
 */
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-shapes',
  benchmarkName: 'Examples: Shapes',
  iterations: 3,
  concurrency: 1,
  shapes: {
    quick: {
      slug: 'examples-shapes-quick',
      name: 'Examples: Shapes (Quick)',
      staggerDelayMs: 0,
    },
    thorough: {
      slug: 'examples-shapes-thorough',
      name: 'Examples: Shapes (Thorough)',
      staggerDelayMs: 250,
    },
  },
  participants: [createNoopParticipant('noop', 100)],
});

/**
 * The task itself is the same for both shapes; the only difference is the
 * platform identity and the stagger delay selected by `--shape`.
 */
export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log }) => {
  log('starting shaped iteration');

  const compute = participant.createCompute();
  const start = performance.now();

  const sandbox = await step('create', () => compute.sandbox.create());
  try {
    const result = await step('exec', () => sandbox.runCommand('node -v'));
    measure({ ttiMs: performance.now() - start, exitCode: result.exitCode });
  } finally {
    await step('destroy', () => sandbox.destroy(), { reportConcurrency: false });
  }
});
