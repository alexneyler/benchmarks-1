/**
 * Regional AI Gateway benchmark — Anthropic family. This is the same cold/warm
 * latency benchmark run from a single runner region. The region is supplied once
 * per run (via `BENCH_REGION` or `--ai-gateway-region`) and every record is
 * tagged with `region` so the platform can compare runs by region.
 *
 * The benchmark intentionally hits each provider's normal endpoint; different
 * regions are achieved by running the same file from different CI runner
 * locations, not by routing to provider-specific regional endpoints.
 *
 * Run:
 *   BENCH_REGION=us-east-1 bench run benchmarks/ai-gateway/ai-gateway-regional.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-regional.bench.ts --ai-gateway-region us-east-1
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import { providers } from './providers.js';
import { writeAIGatewayLegacyResults } from './legacy-results.js';
import { makeAIGatewayTask, resolveAIGatewayRegionalPhases } from './shared-task.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_TOKENS = 200;
const TIMEOUT_MS = 45_000;

function parseRegionFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ai-gateway-region') {
      if (i + 1 >= argv.length) throw new Error('--ai-gateway-region requires a value');
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`--ai-gateway-region requires a non-empty region (got "${value}")`);
      }
      return value;
    }
    if (argv[i].startsWith('--ai-gateway-region=')) {
      const value = argv[i].slice('--ai-gateway-region='.length);
      if (!value) throw new Error('--ai-gateway-region= requires a non-empty value');
      return value;
    }
  }
  return undefined;
}

const region = process.env.BENCH_REGION ?? parseRegionFlag(process.argv.slice(2));
if (!region) {
  throw new Error('A region is required. Set BENCH_REGION or pass --ai-gateway-region <region>.');
}

const phases = resolveAIGatewayRegionalPhases(['--ai-gateway-regions', region]);
if (phases.length === 0) {
  console.log('No regional phases to run.');
  process.exit(0);
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: `ai-gateway-latency-regional-anthropic${process.env.DAILY_BENCH_SLUG ? `-${process.env.DAILY_BENCH_SLUG}` : ''}`,
  benchmarkName: `AI Gateway Latency - Regional - Anthropic${process.env.DAILY_BENCH_NAME ? ` - ${process.env.DAILY_BENCH_NAME}` : ''}`,
  phases,
  groupBy: 'round',
  participants: providers,
  customCliFlags: ['--ai-gateway-region', '--ai-gateway-iterations-cold', '--ai-gateway-iterations-warm'],
  scoring: {
    groupBy: 'region',
    metrics: [
      { key: 'coldE2eMs', unit: 'ms', ceiling: 20000, weights: { median: 0.30, p95: 0.15, p99: 0 } },
      { key: 'warmTtftMs', unit: 'ms', ceiling: 20000, weights: { median: 0.30, p95: 0.15, p99: 0 } },
      {
        key: 'outputTokensPerSec',
        unit: 'tokens/sec',
        floor: 5,
        ceiling: 200,
        higherIsBetter: true,
        weights: { median: 0.10, p95: 0, p99: 0 },
      },
    ],
  },
  onComplete: async (outcome) => {
    await writeAIGatewayLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, `../../results/ai-gateway-latency/regional/anthropic/${region}`),
      providers,
    });
  },
});

export const task = defineTask(makeAIGatewayTask(MAX_TOKENS, TIMEOUT_MS));
