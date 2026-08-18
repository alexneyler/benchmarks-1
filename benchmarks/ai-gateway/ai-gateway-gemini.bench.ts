/**
 * AI Gateway benchmark — Gemini family. Same methodology, task, CLI flags,
 * and request configuration as `ai-gateway.bench.ts` (see that file and
 * `task.ts` for the full fairness rationale) — the only difference is
 * `providers-gemini.ts`, which routes gateways to Google's `gemini-3.6-flash`
 * instead of Anthropic's Claude Haiku 4.5, plus its own no-gateway
 * `gemini-direct` control.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway-gemini.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-gemini.bench.ts --provider gemini-direct
 */
import '../src/env.js';
import { providers } from './providers-gemini.js';
import { buildAIGatewayFamily } from './task.js';

export const { config, task } = buildAIGatewayFamily({
  benchmarkSlug: 'ai-gateway-latency-gemini',
  benchmarkName: 'AI Gateway Latency - Gemini',
  providers,
  resultsDirName: 'ai-gateway-gemini',
});
