/**
 * Phases benchmark.
 *
 * Demonstrates `phases`: an ordered list of named segments, each with its own
 * iteration count. The runner tags every task record with `data.phase` and the
 * task receives `ctx.phase`, so the same task function can branch on the phase
 * without doing index arithmetic.
 *
 * Run with:
 *   bench run benchmarks/examples/02-phases.bench.ts --concurrency 2
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { createNoopParticipant } from './participants.js';

/**
 * `phases` and `iterations` are mutually exclusive in `defineBenchmarkConfig`.
 * When `phases` is set, the total number of task slots is the sum of all phase
 * iteration counts (here 2 + 4 = 6). The slots run in phase order: first every
 * `cold` slot, then every `warm` slot.
 *
 * Each slot is tagged with its phase name, and `ctx.phase` inside the task is
 * set to that name.
 */
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-phases',
  benchmarkName: 'Examples: Phases',
  phases: [
    { name: 'cold', iterations: 2 },
    { name: 'warm', iterations: 4 },
  ],
  concurrency: 2,
  participants: [createNoopParticipant('noop', 100)],
});

/**
 * The task uses `ctx.phase` to vary behavior. In a real benchmark this might
 * mean using a cold-start payload for the `cold` phase and a warm-start payload
 * for the `warm` phase. The phase name is also written into the measured data
 * so the dashboard can group or filter by phase.
 */
export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log, phase }) => {
  log(`starting ${phase ?? 'unknown'} phase`);

  const compute = participant.createCompute();
  const start = performance.now();

  // In a real benchmark you might use a different payload per phase.
  const command = phase === 'cold' ? 'node -v' : 'node -e "console.log(1+1)"';

  const sandbox = await step('create', () => compute.sandbox.create());
  try {
    const result = await step('exec', () => sandbox.runCommand(command));

    // `measure` expects a `JsonObject`; `phase` may be `undefined` in a config
    // that does not use phases, so we only add it when it is present.
    measure({
      ttiMs: performance.now() - start,
      exitCode: result.exitCode,
      ...(phase ? { phase } : {}),
    });
  } finally {
    await step('destroy', () => sandbox.destroy(), { reportConcurrency: false });
  }
});
