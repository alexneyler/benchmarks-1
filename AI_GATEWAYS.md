# AI Gateway Benchmark

This document describes the **AI gateway benchmark** — a phase-by-phase latency, throughput, and reliability comparison of OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, LLM Gateway, Pydantic AI Gateway, and Concentrate AI. It's organized as one **family benchmark per target provider**, all built on the same shared harness (`task.ts`, `phase-probe.ts`, scoring) so every family uses an identical prompt, phase methodology, and scoring formula — only the target provider (and therefore the model and each gateway's routing syntax) changes between them:

- **Anthropic family** (`ai-gateway.bench.ts` + `providers.ts`) — every gateway routed to Claude Haiku 4.5, measured against a direct-to-Anthropic baseline. This is the original benchmark and the one with the deepest "confirmed live" verification (see [Every gateway is hit directly](#every-gateway-is-hit-directly--no-gateway-is-proxied-through-another) below).
- **OpenAI family** (`ai-gateway-openai.bench.ts` + `providers-openai.ts`) — the same six gateways routed to `gpt-4.1-mini` instead, measured against a direct-to-OpenAI baseline. See [OpenAI family benchmark](#openai-family-benchmark).
- **Gemini and Kimi** don't have their own family benchmarks yet — each currently exists only as a lone no-gateway baseline inside the Anthropic family's `providers.ts`. See [Cross-provider baselines](#cross-provider-baselines-gemini-kimi).

A result from one family is **not** directly comparable to the same gateway's result in another family — different target provider means a different underlying model and (for some gateways) a different routing path, so a difference in numbers can't be attributed to the gateway alone the way it can within a single family.

> **Where this runs**: scheduled and dispatched runs execute in GitHub Actions on [Namespace](https://namespace.so) runners (`namespace-profile-default`), physically placed in **Northern Virginia, US**. This is a single fixed vantage point, not a global or multi-region measurement — every number in this benchmark reflects network conditions from that one location. Confirmed two ways: Namespace's own runner-instance panel reports "Placement: Northern Virginia, US" for this profile, and independently, `cf-ray` receipts captured in real runs include `IAD` — the airport code Cloudflare uses for its Ashburn/Northern Virginia edge datacenter, exactly consistent with a client physically nearby. See [Vantage-point dependent](#limitations) in Limitations for what this does and doesn't mean for the results.

## Why this benchmark exists

Gateway latency discussions online routinely conflate metrics that behave very differently: connection-setup overhead (DNS, TCP, TLS) vs. actual routing/model-dispatch overhead, and a fresh connection's cost vs. an already-open connection's cost. A single aggregate "latency" number hides which of those is actually responsible for a gateway feeling fast or slow. This benchmark separates them explicitly, so a claim like "Gateway X is slower" can be traced to a specific phase rather than taken on faith.

The phase-separation methodology (cold vs. warm, DNS/TCP/TLS/TTFB/TTFT, round-robin execution, no-session-resumption cold connections) is adapted from [rbadillap/ai-gateways-benchmark](https://github.com/rbadillap/ai-gateways-benchmark), an independent open-source benchmark using the same approach. We reimplemented it in TypeScript on top of Node's `https` module rather than raw sockets, added a direct-to-Anthropic baseline and a fourth gateway routed without any intermediary hop, and extended it with tokens/sec and a composite score — see [Comparison to the reference implementation](#comparison-to-the-reference-implementation) for the full list of what matches and what's deliberately different.

## What gets measured

For each gateway, every probe request is one of two kinds:

- **Cold** — a brand-new TCP+TLS connection, opened from scratch for this single request. We time each connection phase individually (see below), plus the request itself.
- **Warm** — one throwaway request completes and is discarded on a freshly-opened keep-alive connection, then a **second** request is sent and measured on that same still-open socket. This isolates the connection-pool case: no DNS, no TCP, no TLS, just the request/response over a connection that's already up.

Every probe (cold or warm) also records:

- **Output tokens generated** and **tokens/sec** (generation throughput after the first token)
- **Success/error** — any non-2xx response, a timeout, or a completed stream with zero content tokens observed counts as a failure for that iteration. A request can return HTTP 200 and a validly-terminated stream while still failing server-side, with the real reason buried in an `event: error`/`response.failed` SSE payload rather than the HTTP status — `phase-probe.ts` scans the buffer for that error message on failure and includes it in the logged/stored error rather than only the generic "no content token observed," so a failure like that is diagnosable from the log line itself.
- **Receipt headers** (`x-vercel-id`, `cf-ray`, `x-request-id`, `anthropic-request-id`, etc.) captured from the response, for tracing a specific measured request back to the provider's own logs if a number is disputed

### Cold-phase breakdown

| Metric | Definition |
|---|---|
| `dnsMs` | Hostname resolution (`lookup` event on the request's socket) |
| `tcpMs` | TCP connect, measured from end of DNS to `connect` event |
| `tlsMs` | TLS handshake, measured from end of TCP connect to `secureConnect` event |
| `ttfbMs` | Request fully sent → first response byte |
| `ttftMs` | Request fully sent → first content token observed in the SSE stream |
| `coldE2eMs` | `dnsMs + tcpMs + tlsMs + ttftMs` — what a short-lived process (a serverless function, a CLI tool, an edge function) actually pays end to end for one request |

These are real socket timestamps, not estimates: Node's `https.request` exposes `lookup`/`connect`/`secureConnect` events directly on the underlying `TLSSocket` (`benchmarks/ai-gateway/phase-probe.ts`), so DNS/TCP/TLS are each timed from the actual connection lifecycle rather than inferred.

### Warm-phase metrics

Only `ttfbMs` and `ttftMs` apply — there is no `dnsMs`/`tcpMs`/`tlsMs`/`coldE2eMs` for a warm probe, since no new connection was opened for the measured request.

**Important distinction, stated explicitly because it's easy to misread:** "cold" here describes *our connection state to the gateway's edge*, not a provider-side model cold start. Every gateway and Anthropic's own API are effectively always warm from the provider's perspective — "cold" only means the benchmark process itself had no existing socket to reuse for that request.

## Request configuration (identical across every gateway)

- **Model**: Claude Haiku 4.5 for the seven Anthropic-family gateway-overhead participants — `anthropic/claude-haiku-4.5` via OpenRouter's and Vercel AI Gateway's catalog alias, `anthropic/claude-haiku-4-5` via LLM Gateway's provider-pinned catalog naming, `anthropic/claude-haiku-4-5-20251001` via Concentrate AI's provider-prefixed naming, `claude-haiku-4-5-20251001` via Cloudflare's, Anthropic's own, and Pydantic AI Gateway's native model ID (Pydantic proxies Anthropic's native API as-is, no gateway-specific model prefix). Same underlying model, addressed the way each API expects it to be addressed. The OpenAI family uses `gpt-4.1-mini` instead — see [OpenAI family benchmark](#openai-family-benchmark) — and the `gemini-direct`/`kimi-direct` baselines each use their own provider's model — see [Cross-provider baselines](#cross-provider-baselines-gemini-kimi).
- **Prompt**: `"Write a two-sentence description of how distributed systems handle partial failures."` — identical for every request, cold or warm, every participant including the cross-provider baselines.
- **`max_tokens`**: 200. **`temperature`**: 0. Identical across both families. **`stream`**: true (required for TTFT; also used for token-count extraction via `stream_options.include_usage` on the OpenAI-compatible path).
- **Timeout**: 45 seconds per request.

Four wire formats are in play, handled explicitly per participant (`AIGatewayProviderConfig.wireFormat` in `benchmarks/ai-gateway/types.ts`):

- **`openai`** (OpenRouter, Vercel AI Gateway, LLM Gateway, Kimi direct) — OpenAI-compatible `/chat/completions` shape, `Authorization: Bearer <key>`. Kimi's API is itself natively OpenAI-Chat-Completions-shaped (Moonshot's own API, not a third-party compatibility shim), so this is Kimi's direct route too, not a translation layer.
- **`anthropic`** (Cloudflare AI Gateway, Anthropic direct, Pydantic AI Gateway, Concentrate AI) — Anthropic's native `/v1/messages` shape. Auth header varies within this group: Cloudflare and Anthropic direct use `x-api-key` + `anthropic-version`; Pydantic AI Gateway and Concentrate AI use `Authorization: Bearer <key>` + `anthropic-version` instead — for Pydantic this was confirmed directly against a real request (its own auth failures return a same-shaped 401 regardless of which of the two header styles is wrong, so this took a few rounds of live testing to pin down precisely). Concentrate AI's `/v1/messages/` endpoint is documented as an "Anthropic Messages API compatibility endpoint" in its published OpenAPI spec (`concentrate.ai/docs/api-reference/openapi.json`), but has **not** been confirmed against a real successful response — see the note in `providers.ts` and in Limitations below.
- **`responses`** (Concentrate AI and OpenAI direct in the Anthropic family; every single participant in the OpenAI family — see [OpenAI family benchmark](#openai-family-benchmark)) — OpenAI's Responses API shape: flat `input` string instead of a `messages` array, `max_output_tokens` instead of `max_tokens`. For OpenAI direct this is the format's origin, called directly — OpenAI's current flagship endpoint (rather than the older Chat Completions surface). The OpenAI family's participants all use it for the same reason: every gateway checked turned out to have a Responses passthrough, so `openai`/Chat Completions never ends up needed there.
- **`gemini`** (Gemini direct) — Google's native `streamGenerateContent` shape: `contents[].parts[].text` instead of `messages`, `generationConfig.maxOutputTokens` instead of `max_tokens`, model id baked into the URL path rather than the request body, streaming selected by the `:streamGenerateContent` path segment (not a body flag), token counts read from `usageMetadata.candidatesTokenCount`.

TTFT detection is format-agnostic by design: a single regex (`"(?:content|text|delta)"\s*:\s*"[^"]`) matches OpenAI's `delta.content`, Anthropic's `delta.text`, the Responses API's flat `delta` string, and Gemini's `parts[].text` alike, so the first-token timestamp doesn't depend on fully parsing every SSE event on the hot path. Token counts are extracted the same lightweight way (regex over the raw buffer, not a full SSE/JSON parser) — see Limitations.

Knowing when the stream has fully ended (needed for `ttfbMs`/`totalMs` and to safely reuse a warm connection) is handled by Node's own HTTP parser (`res.on('end')`), which understands `Content-Length` and chunked-transfer framing generically for any spec-compliant response. This differs from the reference implementation, which reads raw socket bytes and has to recognize completion itself via hand-matched byte sequences (`data: [DONE]`, `"type":"message_stop"`, the chunked terminator `\r\n0\r\n\r\n`) — a reasonable approach when working with raw sockets in Python, but one that has to be kept in sync with each gateway's exact stream-termination convention. Delegating that to Node's HTTP parser avoids needing to enumerate termination formats per gateway at all.

### Every gateway is hit directly — no gateway is proxied through another

This is the single most important fairness property of this benchmark, worth stating plainly: **Cloudflare AI Gateway is called via its own direct-to-Anthropic passthrough route** (`/v1/{account}/{gateway}/anthropic/v1/messages`), not routed through OpenRouter or any other intermediary. **OpenRouter and Vercel AI Gateway both route a catalog alias like `anthropic/claude-haiku-4.5` dynamically** — by default each picks the upstream provider (Anthropic, Bedrock, Vertex, or a reseller) per request based on its own price/uptime/latency policy, which would otherwise let a gateway's cold/warm numbers reflect a different provider's infra from one iteration to the next. Both set Anthropic as the preferred provider in the request body (`providers.ts`): OpenRouter via `provider: { order: ['anthropic'] }` ([docs](https://openrouter.ai/docs/features/provider-routing)), Vercel AI Gateway via `providerOptions: { gateway: { order: ['anthropic'] } }` on its REST/OpenAI-compatible path ([docs](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)) — a preference, not a hard restriction: if Anthropic itself is unavailable, the gateway automatically falls back to another upstream rather than failing the iteration. To keep that fallback from blending silently into a gateway's numbers, both gateways' actually-serving provider is captured per iteration as `resolvedProvider` (confirmed live against real requests: OpenRouter carries a top-level `"provider":"Anthropic"` on every SSE chunk; Vercel carries `resolvedProvider` inside `provider_metadata.gateway.routing` on its final chunk) — a run where either gateway had to fall back off Anthropic is visible and filterable in the results JSON and in the live run log (`⚠ fell back to <provider>`), rather than silently mixing another provider's latency into that gateway's stats. **LLM Gateway**'s model id is provider-pinned by naming convention (`anthropic/claude-haiku-4-5`) so its requests route to Anthropic itself rather than to a different host of the same model; this was confirmed directly against a real request, whose response `metadata` block explicitly reports `used_provider: "anthropic"`, `used_model: "claude-haiku-4-5"`. **Pydantic AI Gateway proxies Anthropic's native API directly** (`/proxy/anthropic/v1/messages`, native model ID `claude-haiku-4-5-20251001`, no gateway-specific routing prefix) — confirmed with a real request returning a genuine Anthropic response (`"model":"claude-haiku-4-5-20251001"`, real `usage`/`cost_estimate` fields from Pydantic's own accounting). **Concentrate AI** is called via its own `/v1/messages/` endpoint with the model provider-pinned (`anthropic/claude-haiku-4-5-20251001`, its provider-prefix syntax) so the request routes to Anthropic itself rather than to Azure or Bedrock — both of which its "model fortress" catalog also lists as routing options for this same model (`anthropic/claude-haiku-4-5`, `azure/claude-haiku-4-5`, `bedrock/claude-haiku-4-5`). `anthropic-direct` calls Anthropic's API with no gateway at all, as the no-gateway control — it isolates how much latency each gateway adds on top of the underlying provider.

A gateway that's itself proxied through a second gateway would have that second hop's latency baked into its numbers, misattributed to the outer gateway. That's not happening here — every participant's number reflects that gateway's own overhead only.

## OpenAI family benchmark

`ai-gateway-openai.bench.ts` + `providers-openai.ts` run the same harness (same task, phases, prompt, scoring, request configuration — see `task.ts`) with every participant routed to OpenAI's `gpt-4.1-mini` instead of Anthropic's Claude Haiku 4.5. It has its own no-gateway `openai-direct` control (OpenAI's own Responses API, `/v1/responses`) and its own results directory (`results/ai-gateway-openai/`) — see [Running it](#running-it).

**Every participant in this family uses the OpenAI Responses API**, not Chat Completions — deliberately, not incidentally. The policy: use a gateway's Responses passthrough if it has one (Responses is OpenAI's own format, so proxying it natively adds no translation layer — the same reasoning that picked `/v1/messages` over the OpenAI-compatible route for the Anthropic family's Cloudflare/Pydantic/LLM Gateway/Vercel entries), fall back to Chat Completions only where no Responses route is documented. Every gateway checked here turned out to have one, so the fallback case never actually triggers in this family — worth revisiting this table if a future gateway addition doesn't have a Responses route.

An earlier pass of this file got two paths wrong by extrapolating one gateway's convention onto another instead of checking each gateway's own docs — Cloudflare's path turned out to drop the `v1` segment its Anthropic route keeps, and Pydantic's OpenAI route wasn't `/proxy/openai` at all. Every route below was re-verified directly against that gateway's own OpenAI-specific docs, and a follow-up pass specifically re-checked **streaming support** on each Responses passthrough — path correctness and streaming correctness are separate claims, and confirming one doesn't confirm the other:

| Gateway | Model / routing | Path confidence | Streaming confidence |
|---|---|---|---|
| OpenRouter | `openai/gpt-4.1-mini` via `/api/v1/responses`, `provider: { order: ['openai'] }` | High — confirmed directly (openrouter.ai/docs/api_reference/responses/overview) | High — OpenRouter's own docs state streaming uses "native SSE passthrough (same event format as OpenAI)" for this endpoint specifically |
| Vercel AI Gateway | `openai/gpt-4.1-mini` via `/v1/responses` | High — confirmed via Vercel's own changelog | High — same changelog explicitly lists streaming as supported |
| Cloudflare AI Gateway | `gpt-4.1-mini` via `/v1/{account}/{gateway}/openai/responses` | High — confirmed directly against Cloudflare's own OpenAI provider docs, listed explicitly alongside the chat/completions path. Does **not** keep the `v1` segment the Anthropic path does — Cloudflare's framing is "replace `https://api.openai.com/v1` with the gateway prefix" wholesale, not uniform across providers | Unconfirmed for this specific endpoint — Cloudflare's own example requests for `/responses` only show non-streaming bodies (`model`+`input`, no `stream`); a general "AI Gateway supports streaming" statement exists platform-wide but isn't `/responses`-specific |
| LLM Gateway | `openai/gpt-4.1-mini` via `/v1/responses` | High — LLM Gateway's own Codex CLI guide states outright "Codex CLI uses the OpenAI Responses API (`/v1/responses`)" against base URL `api.llmgateway.io/v1` | Unconfirmed — not mentioned in their Codex guide either way. **Separately**: that same guide documents a hard failure mode, `"The Responses API requires data retention to be enabled"`, unless the backing OpenAI org has "Retain All Data" turned on — mitigated by sending `store: false` on every Responses request (see `phase-probe.ts`), but if the failure persists it means this specific gateway forces its own `store` value regardless of what we send |
| Pydantic AI Gateway | `gpt-4.1-mini` via `/proxy/openai-responses/responses` | High for the `/proxy/openai-responses` base (a dedicated Codex route, `wire_api = "responses"`, distinct from the unconfirmed `/proxy/openai` Vercel-AI-SDK integration point — verified with an exhaustive quote-check of every path on the page, no ambiguity left there). The `/responses` suffix is inferred from Codex's `wire_api="responses"` convention, corroborated by the identical confirmed pattern for LLM Gateway, not a literal curl example | Unconfirmed — no streaming example found; what was found (pydantic_ai's own streaming behavior) describes the Python framework's abstraction, not this raw HTTP passthrough |
| Concentrate AI | `openai/gpt-4.1-mini` via `/v1/responses/` | High for the model syntax (confirmed on Concentrate's own model catalog) | Carries the same unconfirmed-against-a-real-response caveat this endpoint already has for the Anthropic entry (see `providers.ts`) |

**Every Responses API request in this repo sets `store: false`** (`phase-probe.ts`) — these are one-shot probes with no need for OpenAI's default 30-day response retention, and it's the documented way to opt out of the data-retention requirement noted for LLM Gateway above rather than depend on an org-level setting this benchmark doesn't control.

Full rationale for each entry lives in `providers-openai.ts`'s per-provider comments, matching the style already used in `providers.ts`.

## Cross-provider baselines (Gemini, Kimi)

`gemini-direct` and `kimi-direct` (in the Anthropic family's `providers.ts`, alongside `anthropic-direct`) run through the same task, phases, prompt, and scoring as the Anthropic family — but they are **not** part of that family's gateway-overhead comparison, and reading them as if they were will produce a wrong conclusion. Every other participant in that family holds the model constant (Claude Haiku 4.5) and varies only the route, so a difference in numbers is attributable to that route's overhead; these two vary both the provider *and* the model, with no gateway involved at all:

| Participant | Model | Route |
|---|---|---|
| `gemini-direct` | `gemini-3.6-flash` | Google's native `streamGenerateContent` endpoint |
| `kimi-direct` | `kimi-k3` | Moonshot's own API (natively OpenAI-Chat-Completions-shaped) |

Treat these as "how fast does provider X's own API feel from this vantage point," each an isolated no-gateway data point — not as additional rows in the OpenRouter/Vercel/Cloudflare/etc. gateway-overhead table. In particular: `kimi-k3` is Moonshot's only current flagship model (no fast/lite tier as of this writing) and runs with reasoning locked to "always on," so it will show a materially higher TTFT than the Haiku-based participants — that reflects the model's reasoning behavior, not gateway or network overhead.

Neither has a full family benchmark yet. Gateway coverage research so far (not yet wired into config): OpenRouter, Vercel AI Gateway, LLM Gateway, and Concentrate AI all appear to support both Gemini and Kimi models in their catalogs; Cloudflare AI Gateway's own hosted Kimi model (`@cf/moonshotai/kimi-k2.7-code`, via Workers AI) is a different serving stack than Moonshot's own API, not a passthrough to it; Pydantic AI Gateway supports Gemini only via Google Vertex (not the native Gemini API `gemini-direct` uses) and doesn't support Kimi at all. Model choice for both was pinned to a specific id deliberately since every provider's lineup changes over time; update the pinned id in `providers.ts` (and in this table) when a newer equivalent-tier model supersedes it.

## How the runner behaves

### Round-robin across gateways — and what that does and doesn't mean

Iterations run **round-robin across every active participant**, not sequentially per participant (`groupBy: 'round'`, set once in `buildAIGatewayFamily` in `benchmarks/ai-gateway/task.ts` and shared by every family benchmark):

```
round 1: openrouter → vercel-ai-gateway → cloudflare-ai-gateway → llmgateway → pydantic-ai-gateway → concentrate-ai-gateway → anthropic-direct → gemini-direct → kimi-direct
round 2: openrouter → vercel-ai-gateway → cloudflare-ai-gateway → llmgateway → pydantic-ai-gateway → concentrate-ai-gateway → anthropic-direct → gemini-direct → kimi-direct
...
```

This is purely about **execution order in time**. Instead of running all of one gateway's iterations back-to-back and then moving to the next gateway (where the last gateway tested could be unfairly affected by, say, a network blip or a provider's load spike five minutes into the run), every gateway gets its Nth iteration at roughly the same point in time as every other gateway's Nth iteration. No gateway's numbers are systematically favored by running earlier, later, or during a different network condition than the others.

Round-robin only interleaves *which gateway's turn it is next*; it never affects what "warm" means for any individual gateway.

### What one warm iteration actually does

Each warm iteration is fully self-contained: open a fresh keep-alive connection → send a throwaway request and let it complete (discarded) → send and measure a second request on that same socket → close the connection. This repeats independently for every warm iteration, for every gateway. It is **not** one connection held open across the entire warm phase or across rounds — each warm iteration re-establishes its own connection, then proves the reuse benefit once, then tears it down. This matches the "connection-pool case" the benchmark is trying to isolate: the saving from *not* paying DNS/TCP/TLS on a repeat request, sampled repeatedly and independently rather than measured once over a long-lived session.

## Scoring

A composite score (0–100, higher is better) combines the two latency axes that matter most in practice with throughput and reliability (`benchmarks/ai-gateway/scoring.ts`):

```
score = (
    0.30 × score(coldE2eMs.median)
  + 0.15 × score(coldE2eMs.p95)
  + 0.30 × score(warmTtftMs.median)
  + 0.15 × score(warmTtftMs.p95)
  + 0.10 × score(outputTokensPerSec.median)
) × successRate
```

- `score(latencyMs)` — 0ms → 100, 20,000ms → 0, linear, clamped to 0.
- `score(tokensPerSec)` — ≤5 tok/s → 0, ≥200 tok/s → 100, linear between.
- `successRate` — fraction of iterations that completed without error. A gateway that's fast but flaky is penalized multiplicatively, same as every other benchmark category in this repo.

Cold E2E and warm TTFT are weighted equally (30% median + 15% p95 each) because both the short-lived-process case and the steady-state case are real, common usage patterns — this benchmark doesn't privilege one over the other.

## Running it

```bash
# Anthropic family — all nine participants (six gateway-overhead + anthropic-direct
# + the gemini-direct/kimi-direct baselines), default 10 cold + 10 warm iterations each
pnpm run bench:ai-gateway

# One participant
pnpm run bench:ai-gateway:openrouter
pnpm run bench:ai-gateway:vercel
pnpm run bench:ai-gateway:cloudflare
pnpm run bench:ai-gateway:llmgateway
pnpm run bench:ai-gateway:pydantic
pnpm run bench:ai-gateway:concentrate
pnpm run bench:ai-gateway:anthropic
pnpm run bench:ai-gateway:gemini
pnpm run bench:ai-gateway:kimi

# OpenAI family — same six gateways + openai-direct, routed to gpt-4.1-mini instead
pnpm run bench:ai-gateway-openai
pnpm run bench:ai-gateway-openai:openrouter
pnpm run bench:ai-gateway-openai:vercel
pnpm run bench:ai-gateway-openai:cloudflare
pnpm run bench:ai-gateway-openai:llmgateway
pnpm run bench:ai-gateway-openai:pydantic
pnpm run bench:ai-gateway-openai:concentrate
pnpm run bench:ai-gateway-openai:direct

# Custom iteration count (applies to both cold and warm) — works the same way for either family
pnpm run bench:ai-gateway -- --iterations 20
pnpm run bench:ai-gateway-openai -- --iterations 20

# Asymmetric cold/warm split, or isolating one phase entirely
# (a phase with 0 iterations is skipped)
npx tsx benchmarks/ai-gateway/ai-gateway.bench.ts --ai-gateway-iterations-cold 20 --ai-gateway-iterations-warm 0
npx tsx benchmarks/ai-gateway/ai-gateway-openai.bench.ts --ai-gateway-iterations-cold 20 --ai-gateway-iterations-warm 0
```

Required environment variables (`benchmarks/.env.example`): `OPENROUTER_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `LLM_GATEWAY_API_KEY`, `PYDANTIC_AI_GATEWAY_API_KEY`, `CONCENTRATE_AI_GATEWAY_API_KEY`, `CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID` + `CLOUDFLARE_AI_GATEWAY_GATEWAY_ID` (+ optional `CLOUDFLARE_AI_GATEWAY_TOKEN` if the gateway has Authenticated Gateway enabled) are shared by both families (same gateway accounts, just routed to a different target model). `ANTHROPIC_API_KEY` is used by the Anthropic family (Cloudflare's passthrough + `anthropic-direct`); `OPENAI_API_KEY` is used by the OpenAI family (Cloudflare's passthrough + `openai-direct`). The two baselines still living in the Anthropic family's `providers.ts` need their own keys too: `GEMINI_API_KEY` for `gemini-direct`, `MOONSHOT_API_KEY` for `kimi-direct`. Missing credentials cause that participant to be reported as `SKIPPED` rather than failing the run.

## Output

Each family writes to its own results directory: the Anthropic family to `results/ai-gateway/YYYY-MM-DD.json` (copied to `results/ai-gateway/latest.json`), the OpenAI family to `results/ai-gateway-openai/YYYY-MM-DD.json` (copied to `results/ai-gateway-openai/latest.json`). Every iteration's phase timings, token counts, resolved provider (for OpenRouter/Vercel AI Gateway, see above), and receipt headers are preserved in full — enough to trace any specific measured request back to its provider-side request ID.

```bash
pnpm run generate-ai-gateway-svg          # Anthropic family -> ai-gateway.svg
pnpm run generate-ai-gateway-openai-svg   # OpenAI family -> ai-gateway-openai.svg
```
Each produces a ranked comparison table (score, cold E2E, warm TTFT, tokens/sec, success rate) for its own family only — the two are never combined into one table, consistent with results from different families not being directly comparable (see the top of this document).

## Comparison to the reference implementation

Since the core methodology is adapted from [rbadillap/ai-gateways-benchmark](https://github.com/rbadillap/ai-gateways-benchmark), here's exactly where this implementation matches it and where it deliberately diverges, so the divergences read as intentional decisions rather than gaps.

**Matches exactly:**

- The phase model: DNS → TCP → TLS → TTFB → TTFT → cold E2E, with the same `dns + tcp + tls + ttft` formula (not double-counting TTFB, since TTFT already occurs after it).
- Warm methodology: a throwaway request discarded, then a second request measured on the same reused socket.
- Round-robin execution: interleave every gateway per round rather than finishing one gateway before starting the next.
- The TTFT-detection regex (`"(?:content|text)"\s*:\s*"[^"]`), which matches both OpenAI's and Anthropic's streaming delta fields — used as-is from the reference.
- The "cold ≠ provider-side cold start" distinction, stated in both.
- Receipt-header capture (`x-vercel-id`, `cf-ray`, `x-request-id`, etc.) for tracing a specific measured request.
- No TLS session resumption between cold connections. The reference guarantees this with a fresh `SSLContext` per connection; we use a fresh `https.Agent` per cold call instead. We verified this empirically rather than assuming it: six consecutive cold connections to the same host held steady at ~43–46ms TLS handshake time with no drop after the first call — a resumed handshake would show a sharp drop after connection 1, since it skips certificate verification and asymmetric key exchange.

**Deliberately different** (all decided earlier in this benchmark's design, not accidental):

| | Reference | This implementation | Why |
|---|---|---|---|
| Default sample size | 5 cold + 5 warm iterations | 10 cold + 10 warm iterations | Tighter medians at the cost of a longer run and more paid API calls per run |
| Cloudflare routing | Proxied through OpenRouter | Direct Anthropic passthrough, no intermediary | Isolates each gateway's own overhead in isolation, at the cost of not showing the chained-gateway scenario |
| Participants | 3 gateways, no baseline | 3 gateways + a direct-to-Anthropic control | Measures how much latency each gateway adds on top of the underlying provider |
| Prompt / `max_tokens` | `"Reply with: pong"`, 16 tokens | Longer prompt, 200 tokens | Needed a real generation to measure tokens/sec |
| Tokens/sec | Not measured | Measured | Extends the reference's latency-only scope |
| Ranking | None — a medians table only | 0–100 composite score | Matches this repo's convention for every other benchmark category; full raw stats are still preserved so anyone can compute their own ranking from the JSON |
| Harness | Raw sockets (no higher-level DNS/TCP/TLS timing API in Python) | Node's `https.request`, listening on the socket's `lookup`/`connect`/`secureConnect` events | Equivalent timestamps without hand-rolling socket/TLS handling |
| Stream-end detection | Hand-matched byte markers per gateway (`data: [DONE]`, `"type":"message_stop"`, chunked terminator) | Node's HTTP parser (`res.on('end')`) | Framing-generic — doesn't need to enumerate each gateway's termination convention |

## Limitations

- **Vantage-point dependent.** Results are a property of wherever the benchmark process runs — its network, region, and ISP — not a global ranking. Scheduled/dispatched runs execute from a single fixed location, Namespace's `namespace-profile-default` runners in **Northern Virginia, US** (see the callout at the top of this document) — not a distributed or multi-region measurement. A gateway with infrastructure closer to Northern Virginia has a structural advantage in every cold-connection and DNS/TCP/TLS number here; the same benchmark run from, say, Frankfurt or Singapore could plausibly reorder the ranking. We do not pin to any gateway's region or give any participant a network advantage relative to the others *at this vantage point* — every gateway is called with the same code, from the same machine, in the same run — but the vantage point itself is not neutral with respect to gateways whose infrastructure is regionally concentrated.
- **"Cold" is about our connection, not the provider's infrastructure.** See the explicit distinction above — this benchmark does not and cannot measure a provider-side model cold start.
- **A gateway may route a given model request to different upstream regions or replicas across requests.** Per-request TTFT reflects whichever upstream instance actually served that specific request, which can vary independent of the gateway's own routing overhead. Repeated iterations (and the p95 metric specifically) exist to surface that variance rather than hide it.
- **Token counts are extracted via a lightweight regex over the raw SSE buffer**, not a full spec-compliant SSE/JSON parser — a deliberate choice to keep the measurement hot path cheap and avoid adding parsing latency to the very timings being measured. If a gateway's streaming JSON format ever falls outside what the regex expects, the affected iteration's token count (and only the token count — never TTFB/TTFT/connection timings, which are captured independently) comes back as `undefined` and is excluded from the tokens/sec summary rather than reported as an incorrect number.
- **No retries.** A failed request counts against that gateway's success rate for that iteration; we do not retry and then report the retry's timing.
- **`dnsMs` reflects the OS resolver's cache, not a fresh lookup, for most cold iterations.** Node's `dns.lookup()` goes through the OS resolver (macOS's mDNSResponder, systemd-resolved, etc.), which caches answers for their TTL — outside our process's control, and true of any HTTP client on any platform (the reference implementation's raw `getaddrinfo()` call is equally subject to it). In a real run we observed exactly this: one gateway showed `dnsMs` of 35.77ms on iteration 1 and ~1ms on the other 19; another showed three elevated values scattered through the run (consistent with a shorter DNS TTL expiring and re-resolving mid-run). Since most cold iterations hit a warm cache, the reported `dnsMs.median` reflects OS-cached lookup time, not genuinely cold DNS resolution — only the rare cache-miss iterations show the real cost. `coldE2eMs` is unaffected in aggregate (it always sums that iteration's actual `dnsMs`, whatever it was), but the `dnsMs` column specifically should be read as "cached lookup, occasionally a real one" rather than "cold DNS, every time."