import type { AIGatewayProviderConfig } from './types.js';

/**
 * AI gateway benchmark configurations — Gemini family.
 *
 * Same fairness methodology as `providers.ts` (the Anthropic family) and
 * `providers-openai.ts` (the OpenAI family): every gateway is hit directly
 * with the same model — `gemini-3.6-flash` — so the comparison is
 * apples-to-apples, and `gemini-direct` is the no-gateway control.
 *
 * Unlike the OpenAI family, only one gateway here gets the native
 * `wireFormat: 'gemini'` treatment: Cloudflare AI Gateway, confirmed via its
 * own `google-ai-studio` provider docs to proxy Google's real
 * `generateContent`/`streamGenerateContent` shape directly. The other four
 * gateways (OpenRouter, Vercel AI Gateway, LLM Gateway, Concentrate AI) show
 * no evidence of a genuine native Gemini passthrough — unlike their
 * confirmed native Anthropic Messages / OpenAI Responses passthroughs used
 * elsewhere in this repo — so they route through their own OpenAI-compatible
 * `/chat/completions` surface instead, translating Gemini's real response
 * into that shape. This isn't a shortcut: a native passthrough genuinely
 * isn't documented for those four, so the OpenAI-compatible surface is the
 * least-translated option actually available.
 *
 * Pydantic AI Gateway is deliberately excluded, not just unconfirmed: its
 * own docs state directly that its `gateway` provider mode for Google routes
 * to **Vertex AI**, not the native Gemini API — a genuinely different
 * serving stack than every other participant here (and than `gemini-direct`
 * itself), so including it would compare a different backend rather than
 * this gateway's overhead on the same one.
 *
 * Still worth a 1-iteration smoke test against real credentials before
 * fully trusting any of these — "confirmed against docs" isn't the same bar
 * as "confirmed against a real response," which is what the Anthropic
 * family's entries in `providers.ts` were held to.
 */
export const providers: AIGatewayProviderConfig[] = [
  {
    // No native Gemini passthrough documented for OpenRouter — its whole
    // platform is built around one normalized, OpenAI-Chat-Completions-
    // shaped endpoint across its entire catalog, not per-provider native
    // passthroughs. `google/gemini-3.6-flash` is OpenRouter's confirmed
    // provider/model catalog convention. Same provider-order pinning
    // mechanism as the Anthropic and OpenAI family entries.
    name: 'openrouter',
    requiredEnvVars: ['OPENROUTER_API_KEY'],
    wireFormat: 'openai',
    model: 'google/gemini-3.6-flash',
    host: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    }),
    extraBody: {
      provider: { order: ['google'] },
    },
    extractResolvedProvider: (buf) => buf.match(/"provider"\s*:\s*"([^"]+)"/)?.[1],
  },
  {
    // No native Gemini passthrough confirmed for Vercel AI Gateway either
    // (unlike its confirmed native Anthropic Messages and OpenAI Responses
    // passthroughs) — its docs describe one unified endpoint across
    // providers via the `creator/model-name` convention, with no
    // Gemini-specific route documented. `google/gemini-3.6-flash` follows
    // that confirmed convention. Provider-order pinning and
    // `resolvedProvider` extraction reuse the same mechanism as the other
    // families' Vercel entries.
    name: 'vercel-ai-gateway',
    requiredEnvVars: ['VERCEL_AI_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'google/gemini-3.6-flash',
    host: 'ai-gateway.vercel.sh',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.VERCEL_AI_GATEWAY_API_KEY}`,
    }),
    extraBody: {
      providerOptions: { gateway: { order: ['google'] } },
    },
    extractResolvedProvider: (buf) => buf.match(/"resolvedProvider"\s*:\s*"([^"]+)"/)?.[1],
  },
  {
    // Confirmed via Cloudflare's own google-ai-studio provider docs
    // (developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio):
    // a genuine native passthrough, `.../google-ai-studio/v1/models/
    // {model}:{generative_ai_rest_resource}` — substitute
    // `streamGenerateContent` for the resource, same as calling Google
    // directly. `?alt=sse` matches the convention already used by
    // `gemini-direct` for real SSE framing rather than a buffered JSON
    // array. Request body shape and auth (`x-goog-api-key`, optionally
    // alongside `cf-aig-authorization`) both confirmed in the same docs.
    name: 'cloudflare-ai-gateway',
    requiredEnvVars: [
      'CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID',
      'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID',
      'CLOUDFLARE_AI_GATEWAY_TOKEN',
      'GEMINI_API_KEY',
    ],
    wireFormat: 'gemini',
    model: 'gemini-3.6-flash',
    host: 'gateway.ai.cloudflare.com',
    path: `/v1/${process.env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID}/${process.env.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID}/google-ai-studio/v1/models/gemini-3.6-flash:streamGenerateContent?alt=sse`,
    buildHeaders: () => ({
      'x-goog-api-key': process.env.GEMINI_API_KEY || '',
      ...(process.env.CLOUDFLARE_AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${process.env.CLOUDFLARE_AI_GATEWAY_TOKEN}` } : {}),
    }),
  },
  {
    // No native Gemini passthrough documented for LLM Gateway — same
    // situation as OpenRouter/Vercel, one unified OpenAI-compatible surface
    // across its catalog. `google-ai-studio/gemini-3.6-flash` follows the
    // same provider-prefix convention confirmed for this gateway's OpenAI
    // and Kimi entries elsewhere in this repo, matching the provider-name
    // segment shown in LLM Gateway's own catalog URLs
    // (llmgateway.io/models/gemini-3.6-flash/google-ai-studio) — NOT
    // independently re-confirmed as the exact request-body pin string,
    // since that catalog URL demonstrates the model listing, not a
    // request example.
    name: 'llmgateway',
    requiredEnvVars: ['LLM_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'google-ai-studio/gemini-3.6-flash',
    host: 'api.llmgateway.io',
    path: '/v1/chat/completions',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.LLM_GATEWAY_API_KEY}`,
    }),
  },
  {
    // No native Gemini passthrough documented for Concentrate AI either.
    // `google/gemini-3.6-flash` follows the same creator-name provider-
    // prefix convention confirmed for this gateway's Anthropic and OpenAI
    // entries elsewhere in this repo (`anthropic/...`, `openai/...`) — NOT
    // independently confirmed for Google specifically: Concentrate's
    // underlying routing is litellm-based, and litellm's own convention for
    // Google's API-key-authenticated route is the abbreviation `gemini/`
    // rather than `google/` (with unprefixed model ids defaulting to
    // Vertex AI, per litellm's docs) — Concentrate may or may not preserve
    // that exact abbreviation for its own API consumers. Lower confidence
    // than this file's other model-id claims; worth confirming with a live
    // request before trusting this specific entry.
    name: 'concentrate-ai-gateway',
    requiredEnvVars: ['CONCENTRATE_AI_GATEWAY_API_KEY'],
    wireFormat: 'openai',
    model: 'google/gemini-3.6-flash',
    host: 'api.concentrate.ai',
    path: '/v1/chat/completions/',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.CONCENTRATE_AI_GATEWAY_API_KEY}`,
    }),
  },
  {
    // No-gateway baseline/control. Gemini's native `streamGenerateContent`
    // endpoint (not the OpenAI-compatibility shim Google also exposes) —
    // `contents`/`parts` request shape, `usageMetadata.candidatesTokenCount`
    // for token counts (see `wireFormat: 'gemini'` in phase-probe.ts). Auth
    // via `x-goog-api-key` header (avoids putting the key in the URL as a
    // `?key=` query param).
    name: 'gemini-direct',
    requiredEnvVars: ['GEMINI_API_KEY'],
    wireFormat: 'gemini',
    model: 'gemini-3.6-flash',
    host: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse',
    buildHeaders: () => ({
      'x-goog-api-key': process.env.GEMINI_API_KEY || '',
    }),
  },
  //
  // add gateways above
];
