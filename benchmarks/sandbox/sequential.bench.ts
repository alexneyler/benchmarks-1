/**
 * Sequential TTI benchmark: `iterations` sandboxes created one at a time
 * (concurrency 1) per provider, each measuring time-to-interactive. Config
 * lives here; all orchestration is owned by @benchsdk/runner's runBenchmark.
 *
 * Run directly:
 *   tsx benchmarks/sandbox/sequential.bench.ts
 *   tsx benchmarks/sandbox/sequential.bench.ts --iterations 5 --provider e2b,modal
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, runBenchmark } from '@benchsdk/runner';
import { providers } from './providers.js';
import { ttiTask, logTti } from './tti-task.js';
import { writeSandboxLegacyResults } from './legacy-results.js';
import { exitOnBenchmarkError } from '../src/util/bench-exit.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'sandbox-tti-local',
  benchmarkName: 'Sandbox TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 2,
  concurrency: 1,
  onResult: logTti,
});

export const task = defineTask(ttiTask);
export default task;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

runBenchmark(config, task, providers, process.argv.slice(2))
  .then(async (outcome) => {
    const resultsDir = path.resolve(__dirname, '../../results/sequential_tti');
    await writeSandboxLegacyResults(outcome.participants, { resultsDir });
    process.exit(0);
  })
  .catch(exitOnBenchmarkError);
