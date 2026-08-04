/**
 * AI Gateway benchmark — Kimi family. Same methodology, task, and CLI flags
 * as `ai-gateway.bench.ts` (see that file and `task.ts` for the full
 * fairness rationale) — the differences are `providers-kimi.ts`, which
 * routes gateways to Moonshot's `kimi-k3` instead of Anthropic's Claude
 * Haiku 4.5 (plus its own no-gateway `kimi-direct` control), and
 * `maxTokens`/`timeoutMs` below.
 *
 * Both overrides trace to the same root cause — `kimi-k3` runs with
 * reasoning locked to "always on," and there's no non-reasoning Kimi tier
 * to switch to instead (unlike the OpenAI family's GPT-5-mini situation),
 * so both are permanent for this family, not temporary workarounds:
 *
 * - `maxTokens: 2000` (vs. the other families' 200) — reasoning tokens
 *   count against this budget. One live test consumed 688 of 802 total
 *   completion tokens on reasoning alone; at 200, the entire budget was
 *   exhausted by reasoning with zero visible output.
 * - `timeoutMs: 90_000` (vs. the other families' 45s) — reasoning also
 *   costs wall-clock time before any visible content appears, independent
 *   of the token budget: one live warm-phase probe measured
 *   `ttft=21395ms`, and a cold probe (which adds DNS/TCP/TLS plus that same
 *   reasoning delay) timed out entirely at the default 45s.
 *
 * See `AIGatewayFamilyDef` in `task.ts` for the full explanation of each,
 * and `AI_GATEWAYS.md` for how both affect cross-family comparability.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway-kimi.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-kimi.bench.ts --provider kimi-direct
 */
import '../src/env.js';
import { providers } from './providers-kimi.js';
import { buildAIGatewayFamily } from './task.js';

export const { config, task } = buildAIGatewayFamily({
  benchmarkSlug: 'ai-gateway-kimi',
  benchmarkName: 'AI Gateway Benchmark — Kimi',
  providers,
  resultsDirName: 'ai-gateway-kimi',
  maxTokens: 2000,
  timeoutMs: 90_000,
});
