/**
 * AI Gateway benchmark, built on @benchsdk/cli's runBenchmark with
 * `groupBy: 'round'`. Fairness is the whole point (see AI_GATEWAYS.md): every
 * gateway's Nth iteration must run at roughly the same point in time as every
 * other gateway's Nth iteration, so no gateway is favored by running during a
 * different network condition. `groupBy: 'round'` provides exactly that — one
 * task per gateway per round, taking turns — replacing the bespoke round-robin
 * loop this file used to hand-roll.
 *
 * Declared as two phases (cold, warm); the framework owns the phase boundary
 * and exposes it via `ctx.phase`, so the task branches on phase identity, not
 * index arithmetic. Each phase runs a socket-level probe (cold: fresh
 * connection with DNS/TCP/TLS + TTFB/TTFT; warm: reused connection, TTFB/TTFT
 * only). Phase timings are measured inside a single request, so they're
 * returned as pre-measured `TaskResult.steps`, and the real measured latency
 * (coldE2eMs / ttftMs) is returned as `TaskResult.latencyMs` rather than
 * letting the framework stamp wall-clock time.
 *
 * Run directly:
 *   tsx benchmarks/ai-gateway/ai-gateway.bench.ts
 *   tsx benchmarks/ai-gateway/ai-gateway.bench.ts --provider openrouter
 */
import '../src/env.js';
import { defineBenchmark, runBenchmark, TaskError } from '@benchsdk/cli';
import type { TaskContext, TaskResult } from '@benchsdk/cli';
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

/** Builds DNS/TCP/TLS (cold only) + TTFB/TTFT as pre-measured platform steps. */
function phaseSteps(result: PhaseProbeResult): TaskStepRecord[] {
  const stepStatus: TaskStepRecord['status'] = result.error ? 'error' : 'success';
  const steps: TaskStepRecord[] = [];
  if (result.mode === 'cold') {
    if (result.dnsMs !== undefined) steps.push({ name: 'dns', status: 'success', latencyMs: result.dnsMs });
    if (result.tcpMs !== undefined) steps.push({ name: 'tcp', status: 'success', latencyMs: result.tcpMs });
    if (result.tlsMs !== undefined) steps.push({ name: 'tls', status: 'success', latencyMs: result.tlsMs });
  }
  steps.push({ name: 'ttfb', status: stepStatus, latencyMs: result.ttfbMs });
  steps.push({ name: 'ttft', status: stepStatus, latencyMs: result.ttftMs });
  return steps;
}

function probeData(result: PhaseProbeResult): JsonObject {
  return {
    mode: result.mode,
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.outputTokensPerSec !== undefined ? { outputTokensPerSec: result.outputTokensPerSec } : {}),
    ...(result.receipts && Object.keys(result.receipts).length > 0 ? { receipts: result.receipts } : {}),
  };
}

async function aiGatewayTask(ctx: TaskContext<AIGatewayProviderConfig>): Promise<TaskResult> {
  const isCold = ctx.phase === 'cold';
  const result = isCold
    ? await runColdProbe(ctx.participant, PROMPT, MAX_TOKENS, TIMEOUT_MS)
    : await runWarmProbe(ctx.participant, PROMPT, MAX_TOKENS, TIMEOUT_MS);

  const steps = phaseSteps(result);

  if (result.error) {
    throw new TaskError(result.error, { code: 'probe_failed', data: probeData(result), steps });
  }
  return {
    data: probeData(result),
    steps,
    latencyMs: isCold ? result.coldE2eMs ?? result.ttftMs : result.ttftMs,
  };
}

function logAiGateway(record: TaskResultRecord, meta: { iterations: number }): void {
  const n = record.taskIndex + 1;
  const label = typeof record.data?.phase === 'string' ? record.data.phase : '?';
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
  phases: [
    { name: 'cold', iterations: ITERATIONS_COLD },
    { name: 'warm', iterations: ITERATIONS_WARM },
  ],
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
