/**
 * AI Gateway benchmark — Anthropic family. Declarative — exports `config` +
 * `task`; `bench run` owns the entrypoint. Configured with `groupBy:
 * 'round'`. Fairness is the whole point (see AI_GATEWAYS.md): every
 * gateway's Nth iteration must run at roughly the same point in time as
 * every other gateway's Nth iteration, so no gateway is favored by running
 * during a different network condition. `groupBy: 'round'` provides exactly
 * that — one task per gateway per round, taking turns — replacing the
 * bespoke round-robin loop this file used to hand-roll.
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
 * The phase/task/CLI-flag machinery is shared across every AI-gateway family
 * benchmark (see `task.ts`); this file only supplies the Anthropic-routed
 * `providers` list and this family's own benchmark identity. See
 * `ai-gateway-openai.bench.ts` for the OpenAI-routed sibling.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway.bench.ts --provider openrouter
 */
import '../src/env.js';
import { providers } from './providers.js';
import { buildAIGatewayFamily } from './task.js';

export const { config, task } = buildAIGatewayFamily({
  benchmarkSlug: 'ai-gateway',
  benchmarkName: 'AI Gateway Benchmark',
  providers,
  resultsDirName: 'ai-gateway',
});
