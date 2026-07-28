/**
 * AI Gateway benchmark, built on @benchsdk/cli's runBenchmark with
 * `groupBy: 'round'`. Fairness is the whole point (see AI_GATEWAYS.md): every
 * gateway's Nth iteration must run at roughly the same point in time as every
 * other gateway's Nth iteration, so no gateway is favored by running during a
 * different network condition. `groupBy: 'round'` provides exactly that — one
 * task per gateway per round, taking turns — replacing the bespoke round-robin
 * loop this file used to hand-roll.
 *
 * iterations = cold + warm; each task branches on its round index to run the
 * cold probe (fresh connection: DNS/TCP/TLS + TTFB/TTFT) or the warm probe
 * (reused connection: TTFB/TTFT only). Phase timings are measured inside a
 * single socket-level request, so they're attached as pre-measured steps via
 * `ctx.recordStep` rather than timed through `ctx.step`.
 *
 * Run directly:
 *   tsx benchmarks/ai-gateway/ai-gateway.bench.ts
 *   tsx benchmarks/ai-gateway/ai-gateway.bench.ts --iterations 10 --provider openrouter
 */
import '../src/env.js';
import { defineBenchmark, runBenchmark } from '@benchsdk/cli';
import type { TaskContext } from '@benchsdk/cli';
import type { JsonObject, TaskResultRecord, TaskStepRecord } from '@benchsdk/client';
import { runColdProbe, runWarmProbe } from './phase-probe.js';
import { providers } from './providers.js';
import type { AIGatewayProviderConfig, PhaseProbeResult } from './types.js';

// Request parameters match run.ts's AI Gateway defaults exactly (identical
// across every gateway is load-bearing for fairness — see AI_GATEWAYS.md).
const ITERATIONS_COLD = 3;
const ITERATIONS_WARM = 3;
const PROMPT = 'Write a two-sentence description of how distributed systems handle partial failures.';
const MAX_TOKENS = 200;
const TIMEOUT_MS = 45_000;

/** Raised so the platform records a probe failure with a meaningful error code. */
class ProbeError extends Error {
  name = 'probe_failed';
}

/** Emits DNS/TCP/TLS (cold only) + TTFB/TTFT as pre-measured platform steps. */
function recordPhaseSteps(ctx: TaskContext<AIGatewayProviderConfig>, result: PhaseProbeResult): void {
  const stepStatus: TaskStepRecord['status'] = result.error ? 'error' : 'success';
  if (result.mode === 'cold') {
    if (result.dnsMs !== undefined) ctx.recordStep({ name: 'dns', status: 'success', latencyMs: result.dnsMs });
    if (result.tcpMs !== undefined) ctx.recordStep({ name: 'tcp', status: 'success', latencyMs: result.tcpMs });
    if (result.tlsMs !== undefined) ctx.recordStep({ name: 'tls', status: 'success', latencyMs: result.tlsMs });
  }
  ctx.recordStep({ name: 'ttfb', status: stepStatus, latencyMs: result.ttfbMs });
  ctx.recordStep({ name: 'ttft', status: stepStatus, latencyMs: result.ttftMs });
}

function probeData(result: PhaseProbeResult): JsonObject {
  return {
    mode: result.mode,
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.outputTokensPerSec !== undefined ? { outputTokensPerSec: result.outputTokensPerSec } : {}),
    ...(result.receipts && Object.keys(result.receipts).length > 0 ? { receipts: result.receipts } : {}),
  };
}

async function aiGatewayTask(ctx: TaskContext<AIGatewayProviderConfig>): Promise<JsonObject> {
  const isCold = ctx.taskIndex < ITERATIONS_COLD;
  const result = isCold
    ? await runColdProbe(ctx.participant, PROMPT, MAX_TOKENS, TIMEOUT_MS)
    : await runWarmProbe(ctx.participant, PROMPT, MAX_TOKENS, TIMEOUT_MS);

  recordPhaseSteps(ctx, result);

  if (result.error) {
    throw new ProbeError(result.error);
  }
  return probeData(result);
}

function logAiGateway(record: TaskResultRecord, meta: { iterations: number }): void {
  const n = record.taskIndex + 1;
  const label = record.taskIndex < ITERATIONS_COLD ? 'cold' : 'warm';
  const ttfb = record.steps?.find((s) => s.name === 'ttfb')?.latencyMs;
  const ttft = record.steps?.find((s) => s.name === 'ttft')?.latencyMs;
  if (record.status === 'success') {
    console.log(
      `  [${label}] Task ${n}/${meta.iterations}: ttfb ${ttfb?.toFixed(0) ?? '--'}ms ttft ${ttft?.toFixed(0) ?? '--'}ms`,
    );
  } else {
    console.log(`  [${label}] Task ${n}/${meta.iterations}: FAILED — ${record.errorCode ?? 'unknown error'}`);
  }
}

const config = defineBenchmark({
  benchmarkSlug: 'ai-gateway-local',
  benchmarkName: 'AI Gateway Benchmark - Local',
  benchmarkKind: 'ai-gateway',
  iterations: ITERATIONS_COLD + ITERATIONS_WARM,
  groupBy: 'round',
  task: aiGatewayTask,
  onResult: logAiGateway,
});

runBenchmark(config, providers, process.argv.slice(2))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
