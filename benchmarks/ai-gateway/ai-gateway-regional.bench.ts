/**
 * Regional AI Gateway benchmark — Anthropic family. Mirrors the standard
 * latency benchmark but adds a `region` dimension so each run compares the
 * same gateways across multiple regions. Each region runs the usual cold/warm
 * phase pair; the task parses `<region>:<mode>` from `ctx.phase`, routes to a
 * per-region endpoint when the provider declares one, and tags the record with
 * `region` so `scoring.groupBy: 'region'` breaks out the summary by region.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway-regional.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-regional.bench.ts --ai-gateway-regions us-east-1,eu-west-1
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

const phases = resolveAIGatewayRegionalPhases(process.argv.slice(2));
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
  customCliFlags: ['--ai-gateway-regions', '--ai-gateway-iterations-cold', '--ai-gateway-iterations-warm'],
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
    const regions = Array.from(
      new Set(
        outcome.participants
          .flatMap((p) => p.records)
          .map((r) => (r.data as { region?: string } | undefined)?.region)
          .filter((r): r is string => typeof r === 'string'),
      ),
    );
    if (regions.length === 0) {
      await writeAIGatewayLegacyResults(outcome.participants, {
        resultsDir: path.resolve(__dirname, '../../results/ai-gateway-latency/regional/anthropic'),
        providers,
      });
      return;
    }
    await Promise.all(
      regions.map(async (region) => {
        const regionParticipants = outcome.participants.map((p) => ({
          ...p,
          records: p.records.filter(
            (r) => (r.data as { region?: string } | undefined)?.region === region,
          ),
        }));
        await writeAIGatewayLegacyResults(regionParticipants, {
          resultsDir: path.resolve(__dirname, `../../results/ai-gateway-latency/regional/anthropic/${region}`),
          providers,
        });
      }),
    );
  },
});

export const task = defineTask(makeAIGatewayTask(MAX_TOKENS, TIMEOUT_MS));
