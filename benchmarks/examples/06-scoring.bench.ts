/**
 * Scoring benchmark.
 *
 * Demonstrates the run-level `onScore` hook and the exported `score` helper.
 * The runner can compute a weighted composite score from measured metrics and
 * submit it to the platform as a run summary. `onComplete` here prints the
 * same score locally so it is visible even when running with `--no-ingest`.
 *
 * Run with:
 *   bench run benchmarks/examples/06-scoring.bench.ts --iterations 5 --no-ingest
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask, lowerIsBetter, score, type ScoringSpec } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { createNoopParticipant } from './participants.js';

// A scoring spec is an ordinary object: a list of metrics, each with a unit,
// a ceiling (best possible value for normalization), and a weighting across
// median/p95/p99. `lowerIsBetter` is a small helper that sets `higherIsBetter: false`.
const scoringSpec: ScoringSpec = {
  metrics: [
    lowerIsBetter('ttiMs', {
      unit: 'ms',
      ceiling: 1000,
      weights: { median: 0.5, p95: 0.3, p99: 0.2 },
    }),
  ],
};

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-scoring',
  benchmarkName: 'Examples: Scoring',
  iterations: 5,
  concurrency: 1,
  participants: [createNoopParticipant('noop', 100)],
  // `onScore` is called after all participants finish. When the run is being
  // reported to the platform, the returned spec is used to build and submit
  // a run summary. It has no effect in `--no-ingest` mode.
  onScore: () => scoringSpec,
  // `onComplete` is always called, so we use it (and the exported `score`
  // function) to print the composite score locally as well.
  onComplete: (outcome) => {
    const scored = score(outcome, scoringSpec);
    for (const result of scored) {
      console.log(
        `  ${result.provider}: compositeScore=${result.compositeScore}, successRate=${result.successRate}`,
      );
    }
  },
});

export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log }) => {
  log('running scored iteration');

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
