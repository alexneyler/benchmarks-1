import https from 'https';
import type { TLSSocket } from 'tls';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import type { AIGatewayProviderConfig, AIGatewayWireFormat, PhaseProbeResult } from './types.js';

const RECEIPT_HEADERS = ['x-vercel-id', 'cf-ray', 'x-request-id', 'request-id', 'anthropic-request-id'];

// Matches OpenAI's `delta.content`, Anthropic's `delta.text`, the Responses
// API's flat `"delta":"…"` string, and Gemini's `parts[].text` alike, so we
// can timestamp the first content token without fully parsing every SSE
// event on the hot path. Safe to share: in the OpenAI/Anthropic/Gemini
// formats "delta"/"content" are always objects (`"delta":{…}`,
// `"content":{…}`), never followed directly by a quote, so the added
// alternatives can't false-match those.
const CONTENT_RE = /"(?:content|text|delta)"\s*:\s*"[^"]/;

function now(): number {
  return performance.now();
}

function buildRequestBody(config: AIGatewayProviderConfig, prompt: string, maxTokens: number): string {
  if (config.wireFormat === 'openai') {
    return JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      ...config.extraBody,
    });
  }
  if (config.wireFormat === 'responses') {
    // OpenAI Responses API shape: flat `input` string instead of a `messages`
    // array, `max_output_tokens` instead of `max_tokens`. `store: false`
    // opts out of the Responses API's default 30-day server-side retention
    // (docs.openai.com — Responses defaults to `store: true`) — these are
    // one-shot benchmark probes with no need for persisted state, and
    // leaving the default on has a real failure mode: at least one gateway
    // (LLM Gateway, per its own Codex integration docs) surfaces a hard
    // error — "The Responses API requires data retention to be enabled" —
    // unless the backing OpenAI org has "Retain All Data" turned on, which
    // isn't something this benchmark controls. Setting `store: false`
    // sidesteps that requirement entirely rather than depending on an
    // account setting outside this repo.
    //
    // `temperature: 0` per the "identical request configuration" fairness
    // principle in AI_GATEWAYS.md — this branch is shared by the Anthropic
    // family's Concentrate entry (Claude Haiku) and every OpenAI-family
    // entry (`gpt-4.1-mini`, per `providers-openai.ts`), and neither has a
    // reason to deviate from it.
    return JSON.stringify({
      model: config.model,
      input: prompt,
      max_output_tokens: maxTokens,
      temperature: 0,
      stream: true,
      store: false,
      ...config.extraBody,
    });
  }
  if (config.wireFormat === 'gemini') {
    // Gemini's native generateContent shape: `contents[].parts[].text`
    // instead of `messages`, `generationConfig.maxOutputTokens` instead of
    // `max_tokens`. No `stream` body field — streaming is selected by the
    // `:streamGenerateContent` path segment instead.
    return JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
      ...config.extraBody,
    });
  }
  return JSON.stringify({
    model: config.model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    ...config.extraBody,
  });
}

/** Cheap regex extraction of the latest known output-token count from the raw SSE buffer so far. */
function extractOutputTokens(wireFormat: AIGatewayWireFormat, buf: string): number | undefined {
  if (wireFormat === 'openai') {
    // Some OpenAI-compatible gateways stream cumulative usage on early events
    // (mirroring Anthropic's message_start) rather than only on the final
    // chunk, so take the last match — like the anthropic path below.
    const m = [...buf.matchAll(/"usage"\s*:\s*\{[^}]*"completion_tokens"\s*:\s*(\d+)/g)];
    return m.length > 0 ? Number(m[m.length - 1][1]) : undefined;
  }
  if (wireFormat === 'gemini') {
    // Gemini streams cumulative usage under `usageMetadata.candidatesTokenCount`
    // on each chunk (mirroring Anthropic's message_start/message_delta
    // pattern) — take the last match, same rationale as the openai branch above.
    const m = [...buf.matchAll(/"usageMetadata"\s*:\s*\{[^}]*"candidatesTokenCount"\s*:\s*(\d+)/g)];
    return m.length > 0 ? Number(m[m.length - 1][1]) : undefined;
  }
  // Anthropic and the Responses API both stream cumulative usage under a
  // "usage" object keyed by "output_tokens" (Anthropic: message_start/
  // message_delta; Responses: response.completed's `response.usage`) — same
  // shared extraction path. The last "output_tokens" seen in the buffer is
  // the most up to date. Scoped to inside the "usage" object (allowing one
  // level of nested {} for fields like usage.server_tool_use) so a gateway
  // that echoes an unrelated "output_tokens" elsewhere — e.g. Concentrate's
  // sibling `cost.breakdown[…].output_tokens` dollar amount, present on both
  // its /messages and /responses endpoints — can't be mistaken for the real
  // count.
  const matches = [...buf.matchAll(/"usage"\s*:\s*\{(?:[^{}]|\{[^{}]*\})*?"output_tokens"\s*:\s*(\d+)/g)];
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : undefined;
}

/**
 * Cheap regex extraction of an API-reported error message from the raw SSE
 * buffer, for a more useful failure log than "no content token observed"
 * alone. A request can return HTTP 200 and a validly-terminated SSE stream
 * while still failing server-side, with the real reason inside an
 * `event: error` / `response.failed` payload rather than the HTTP status.
 * Matches the common `{"error":{...,"message":"..."}}` shape shared by
 * OpenAI (Chat Completions, Responses, and its own `event: error`/
 * `response.failed` payloads), Anthropic, and Gemini error responses alike —
 * not exhaustive, but strictly additive: if this finds nothing, the caller
 * falls back to the original generic message exactly as before.
 */
function extractStreamErrorMessage(buf: string): string | undefined {
  const matches = [...buf.matchAll(/"error"\s*:\s*\{(?:[^{}]|\{[^{}]*\})*?"message"\s*:\s*"([^"]*)"/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : undefined;
}

function extractReceipts(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const receipts: Record<string, string> = {};
  for (const h of RECEIPT_HEADERS) {
    const v = headers[h];
    if (typeof v === 'string') receipts[h] = v;
  }
  return receipts;
}

interface RawProbeOutcome {
  ttfbMs: number;
  ttftMs: number;
  totalMs: number;
  outputTokens?: number;
  resolvedProvider?: string;
  receipts: Record<string, string>;
}

/** Sends one request over `agent` and resolves once the SSE stream ends. */
function sendAndMeasure(
  config: AIGatewayProviderConfig,
  body: string,
  agent: https.Agent,
  timeout: number,
  onSocket?: (socket: TLSSocket) => void,
): Promise<RawProbeOutcome> {
  return withTimeout(new Promise<RawProbeOutcome>((resolve, reject) => {
    const start = now();

    const req = https.request({
      host: config.host,
      path: config.path,
      method: 'POST',
      agent,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'content-length': Buffer.byteLength(body),
        ...config.buildHeaders(),
      },
    }, (res) => {
      const ttfbMs = now() - start;
      const receipts = extractReceipts(res.headers as Record<string, string | undefined>);

      if ((res.statusCode ?? 0) >= 400) {
        let errBody = '';
        res.on('data', (c) => { errBody += c; });
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)));
        res.on('error', reject);
        return;
      }

      let buf = '';
      let ttftMs = 0;
      let outputTokens: number | undefined;
      let resolvedProvider: string | undefined;

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (ttftMs === 0 && CONTENT_RE.test(buf)) {
          ttftMs = now() - start;
        }
        outputTokens = extractOutputTokens(config.wireFormat, buf) ?? outputTokens;
        resolvedProvider = config.extractResolvedProvider?.(buf) ?? resolvedProvider;
      });
      res.on('end', () => {
        if (ttftMs === 0) {
          const streamError = extractStreamErrorMessage(buf);
          reject(new Error(
            streamError
              ? `Stream ended with no content token observed: ${streamError}`
              : 'Stream ended with no content token observed',
          ));
          return;
        }
        resolve({ ttfbMs, ttftMs, totalMs: now() - start, outputTokens, resolvedProvider, receipts });
      });
      res.on('error', reject);
    });

    if (onSocket) {
      req.on('socket', (socket) => onSocket(socket as TLSSocket));
    }
    req.on('error', reject);
    req.write(body);
    req.end();
  }), timeout, 'AI gateway request timed out');
}

function tokensPerSecond(outcome: RawProbeOutcome): number | undefined {
  if (!outcome.outputTokens || outcome.outputTokens <= 0) return undefined;
  const generationMs = Math.max(outcome.totalMs - outcome.ttftMs, 1);
  return outcome.outputTokens / (generationMs / 1000);
}

/**
 * One request on a fresh, non-pooled connection. Listens on the request's
 * socket for the underlying TLSSocket's 'lookup'/'connect'/'secureConnect'
 * events to time DNS/TCP/TLS directly — no raw-socket hand-rolling needed.
 */
export async function runColdProbe(
  config: AIGatewayProviderConfig,
  prompt: string,
  maxTokens: number,
  timeout: number,
): Promise<PhaseProbeResult> {
  const body = buildRequestBody(config, prompt, maxTokens);
  const agent = new https.Agent({ keepAlive: false });

  let lookupAt: number | undefined;
  let connectAt: number | undefined;
  let secureConnectAt: number | undefined;
  const requestStart = now();

  try {
    const outcome = await sendAndMeasure(config, body, agent, timeout, (socket) => {
      socket.once('lookup', () => { lookupAt = now(); });
      socket.once('connect', () => { connectAt = now(); });
      socket.once('secureConnect', () => { secureConnectAt = now(); });
    });

    const dnsMs = lookupAt !== undefined ? lookupAt - requestStart : undefined;
    const tcpMs = connectAt !== undefined && lookupAt !== undefined ? connectAt - lookupAt : undefined;
    const tlsMs = secureConnectAt !== undefined && connectAt !== undefined ? secureConnectAt - connectAt : undefined;
    const coldE2eMs = (dnsMs ?? 0) + (tcpMs ?? 0) + (tlsMs ?? 0) + outcome.ttftMs;

    return {
      mode: 'cold',
      dnsMs,
      tcpMs,
      tlsMs,
      ttfbMs: outcome.ttfbMs,
      ttftMs: outcome.ttftMs,
      coldE2eMs,
      outputTokens: outcome.outputTokens,
      outputTokensPerSec: tokensPerSecond(outcome),
      resolvedProvider: outcome.resolvedProvider,
      receipts: outcome.receipts,
    };
  } catch (err) {
    return { mode: 'cold', ttfbMs: 0, ttftMs: 0, receipts: {}, error: formatError(err) };
  } finally {
    agent.destroy();
  }
}

/**
 * One throwaway request completes on a keep-alive connection, then a second
 * request is measured on that same reused socket — the connection-pool case.
 * No explicit "drain" step is needed the way a raw-socket implementation
 * would require: Node's http client only fires `res.on('end')` once the full
 * response has been consumed, so the socket is already safe to reuse for the
 * next request by the time the warmup call resolves.
 */
export async function runWarmProbe(
  config: AIGatewayProviderConfig,
  prompt: string,
  maxTokens: number,
  timeout: number,
): Promise<PhaseProbeResult> {
  const body = buildRequestBody(config, prompt, maxTokens);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

  try {
    await sendAndMeasure(config, body, agent, timeout); // warmup, discarded
    const outcome = await sendAndMeasure(config, body, agent, timeout);

    return {
      mode: 'warm',
      ttfbMs: outcome.ttfbMs,
      ttftMs: outcome.ttftMs,
      outputTokens: outcome.outputTokens,
      outputTokensPerSec: tokensPerSecond(outcome),
      resolvedProvider: outcome.resolvedProvider,
      receipts: outcome.receipts,
    };
  } catch (err) {
    return { mode: 'warm', ttfbMs: 0, ttftMs: 0, receipts: {}, error: formatError(err) };
  } finally {
    agent.destroy();
  }
}
