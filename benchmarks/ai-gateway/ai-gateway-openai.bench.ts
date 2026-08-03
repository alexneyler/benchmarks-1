/**
 * AI Gateway benchmark — OpenAI family. Same methodology, task, CLI flags,
 * and request configuration (`max_tokens: 200`, `temperature: 0`) as
 * `ai-gateway.bench.ts` (see that file and `task.ts` for the full fairness
 * rationale) — the only difference is `providers-openai.ts`, which routes
 * every gateway to OpenAI's `gpt-4.1-mini` instead of Anthropic's Claude
 * Haiku 4.5, plus its own no-gateway `openai-direct` control.
 *
 * Run:
 *   bench run benchmarks/ai-gateway/ai-gateway-openai.bench.ts
 *   bench run benchmarks/ai-gateway/ai-gateway-openai.bench.ts --provider openai-direct
 */
import '../src/env.js';
import { providers } from './providers-openai.js';
import { buildAIGatewayFamily } from './task.js';

export const { config, task } = buildAIGatewayFamily({
  benchmarkSlug: 'ai-gateway-openai',
  benchmarkName: 'AI Gateway Benchmark — OpenAI',
  providers,
  resultsDirName: 'ai-gateway-openai',
});
