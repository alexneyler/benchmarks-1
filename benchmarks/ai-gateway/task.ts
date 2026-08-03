/**
 * Shared task/config logic for every AI-gateway family benchmark (Anthropic,
 * OpenAI, ...). Each family's own `*.bench.ts` file supplies its `providers`
 * list, `benchmarkSlug`, and `resultsDirName`; everything else — phase
 * definitions, CLI iteration flags, the probe task itself, legacy results
 * writing — is identical across families, so it lives here once.
 *
 * See `ai-gateway.bench.ts` for the full fairness rationale (groupBy:
 * 'round', cold/warm phases, etc.) — that reasoning applies to every family
 * benchmark built on this module, not just the original Anthropic one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { BenchmarkConfig, TaskContext, TaskResult } from '@benchsdk/runner';
import type { JsonObject, TaskStepRecord } from '@benchsdk/client';
import { runColdProbe, runWarmProbe } from './phase-probe.js';
import type { AIGatewayProviderConfig, PhaseProbeResult } from './types.js';
import { writeAIGatewayLegacyResults } from './legacy-results.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROMPT = 'Write a two-sentence description of how distributed systems handle partial failures.';
const MAX_TOKENS = 200;
const TIMEOUT_MS = 45_000;

/** Parses `--flag N` or `--flag=N` from argv; mirrors run.ts's own flag parsing. */
function parseIntFlag(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) {
    const n = Number(eq.slice(flag.length + 1));
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return undefined;
}

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
  // Token throughput/count are non-latency metrics (a rate the step's latency
  // can't express), so attach them to the ttft step's data → step_data_json.
  const ttftData: JsonObject = {
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.outputTokensPerSec !== undefined ? { outputTokensPerSec: result.outputTokensPerSec } : {}),
  };
  steps.push({
    name: 'ttft',
    status: stepStatus,
    latencyMs: result.ttftMs,
    ...(Object.keys(ttftData).length > 0 ? { data: ttftData } : {}),
  });
  return steps;
}

function probeData(result: PhaseProbeResult): JsonObject {
  return {
    mode: result.mode,
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.outputTokensPerSec !== undefined ? { outputTokensPerSec: result.outputTokensPerSec } : {}),
    ...(result.receipts && Object.keys(result.receipts).length > 0 ? { receipts: result.receipts } : {}),
    ...(result.error ? { errorMessage: result.error } : {}),
  };
}

async function aiGatewayTask(ctx: TaskContext<AIGatewayProviderConfig>): Promise<TaskResult> {
  const isCold = ctx.phase === 'cold';
  const result = isCold
    ? await runColdProbe(ctx.participant, PROMPT, MAX_TOKENS, TIMEOUT_MS)
    : await runWarmProbe(ctx.participant, PROMPT, MAX_TOKENS, TIMEOUT_MS);

  const steps = phaseSteps(result);

  if (result.error) {
    ctx.log(`${ctx.participant.name} ${result.mode} probe failed: ${result.error}`, probeData(result));
    throw new TaskError(result.error, { code: 'probe_failed', data: probeData(result), steps });
  }
  ctx.log(
    `${ctx.participant.name} ${result.mode} probe: ttfb=${result.ttfbMs}ms ttft=${result.ttftMs}ms`,
    probeData(result),
  );
  return {
    data: probeData(result),
    steps,
    latencyMs: isCold ? result.coldE2eMs ?? result.ttftMs : result.ttftMs,
  };
}

export interface AIGatewayFamilyDef {
  benchmarkSlug: string;
  benchmarkName: string;
  providers: AIGatewayProviderConfig[];
  /** Subdirectory of `results/` this family's JSON output is written to. */
  resultsDirName: string;
}

/**
 * Builds `{ config, task }` for one AI-gateway family benchmark. The CLI
 * asserts every phase has iterations >= 1, but run.ts historically allowed a
 * phase to be dialed to 0 (e.g. `--ai-gateway-iterations-warm 0` to skip the
 * warm phase entirely) — preserved here by dropping any zeroed phase before
 * it reaches the runner.
 */
export function buildAIGatewayFamily(
  def: AIGatewayFamilyDef,
): { config: BenchmarkConfig<AIGatewayProviderConfig>; task: ReturnType<typeof defineTask<AIGatewayProviderConfig>> } {
  const argv = process.argv.slice(2);
  const iterationsOverride = parseIntFlag(argv, '--iterations');
  const ITERATIONS_COLD = parseIntFlag(argv, '--ai-gateway-iterations-cold') ?? iterationsOverride ?? 10;
  const ITERATIONS_WARM = parseIntFlag(argv, '--ai-gateway-iterations-warm') ?? iterationsOverride ?? 10;

  const phases = [
    { name: 'cold', iterations: ITERATIONS_COLD },
    { name: 'warm', iterations: ITERATIONS_WARM },
  ].filter((p) => p.iterations > 0);

  if (phases.length === 0) {
    console.log('Both phases are zeroed — nothing to run.');
    process.exit(0);
  }

  const config = defineBenchmarkConfig({
    benchmarkSlug: def.benchmarkSlug,
    benchmarkName: def.benchmarkName,
    benchmarkKind: 'ai-gateway',
    phases,
    groupBy: 'round',
    participants: def.providers,
    onComplete: (outcome) =>
      writeAIGatewayLegacyResults(outcome.participants, {
        resultsDir: path.resolve(__dirname, '../../results', def.resultsDirName),
        providers: def.providers,
      }),
  });

  return { config, task: defineTask(aiGatewayTask) };
}
