import type { AIGatewayProviderConfig, AIGatewayWireFormat } from './types.js';

export type AIGatewayFamily = 'anthropic' | 'openai' | 'gemini' | 'kimi';

export interface AIGatewayFamilyConfig {
  /** Model id to request, in this gateway's own catalog naming convention. */
  model: string;
  /** Override the gateway's default wire format for this family. */
  wireFormat?: AIGatewayWireFormat;
  /** Override the gateway's default request path for this family. */
  path?: string;
  /** Merge additional top-level request body fields for this family. */
  extraBody?: Record<string, unknown>;
  /** Override the gateway's default reasoning-first-token behavior for this family. */
  reasoningCountsAsFirstToken?: boolean;
}

export interface AIGatewayDefinition {
  /** Provider slug used in benchmark results and CLI --provider filters. */
  name: string;
  /** Environment variables that must all be set to run this gateway. */
  requiredEnvVars: string[];
  /** Hostname (or a resolver returning a hostname) for HTTPS requests. */
  host: string | (() => string);
  /** Request/response wire format this gateway speaks by default. */
  defaultWireFormat: AIGatewayWireFormat;
  /** Request path for a chat/message completion by default. */
  defaultPath: string;
  /** Auth (and any gateway-specific) headers. Evaluated per-request. */
  buildHeaders: () => Record<string, string>;
  /** Extra top-level body fields merged into every family's request. */
  extraBody?: Record<string, unknown>;
  /** Optional resolved-provider extraction from the SSE buffer. */
  extractResolvedProvider?: (buf: string) => string | undefined;
  /** Per-family overrides. If a family is omitted, the family default model is used. */
  families?: Partial<Record<AIGatewayFamily, AIGatewayFamilyConfig>>;
}

/** Family target models. Each gateway is registered with these by default so a
 * new gateway can be added to every AI-gateway family benchmark before its exact
 * catalog aliases are confirmed. */
const FAMILY_MODELS: Record<AIGatewayFamily, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4.1-mini',
  gemini: 'gemini-3.6-flash',
  kimi: 'kimi-k3',
};

/**
 * Build the AIGatewayProviderConfig list for one family from a set of gateway
 * definitions. This is the shared utility for registering a new gateway across
 * all AI gateway family benchmarks (Anthropic, OpenAI, Gemini, Kimi).
 */
export function providersForFamily(
  family: AIGatewayFamily,
  gateways: AIGatewayDefinition[],
): AIGatewayProviderConfig[] {
  const baseModel = FAMILY_MODELS[family];
  return gateways.map((gateway) => {
    const familyConfig = gateway.families?.[family];
    const extraBody = { ...gateway.extraBody, ...familyConfig?.extraBody };
    const host = typeof gateway.host === 'function' ? gateway.host() : gateway.host;
    return {
      name: gateway.name,
      requiredEnvVars: gateway.requiredEnvVars,
      wireFormat: familyConfig?.wireFormat ?? gateway.defaultWireFormat,
      model: familyConfig?.model ?? baseModel,
      host,
      path: familyConfig?.path ?? gateway.defaultPath,
      buildHeaders: gateway.buildHeaders,
      ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
      ...(gateway.extractResolvedProvider ? { extractResolvedProvider: gateway.extractResolvedProvider } : {}),
      ...(familyConfig?.reasoningCountsAsFirstToken ? { reasoningCountsAsFirstToken: familyConfig.reasoningCountsAsFirstToken } : {}),
    };
  });
}

function resolveNeonHost(): string {
  const base = process.env.NEON_AI_GATEWAY_BASE_URL;
  if (!base || base.startsWith('your_')) return '';
  try {
    return new URL(base).hostname;
  } catch {
    return '';
  }
}

/** Novita, Ramp Router, and Neon AI Gateway definitions.
 *
 * Each gateway is registered with every AI gateway family benchmark using the
 * family default model. Per-family model/wire-format overrides can be added to
 * `families` once the exact catalog aliases are confirmed. */
export const newAIGateways: AIGatewayDefinition[] = [
  {
    name: 'novita',
    requiredEnvVars: ['NOVITA_API_KEY'],
    defaultWireFormat: 'openai',
    defaultPath: '/openai/v1/chat/completions',
    host: 'api.novita.ai',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NOVITA_API_KEY}`,
    }),
    families: {
      kimi: {
        model: FAMILY_MODELS.kimi,
        extraBody: { temperature: undefined },
        reasoningCountsAsFirstToken: true,
      },
    },
  },
  {
    name: 'ramp',
    requiredEnvVars: ['RAMP_ROUTER_API_KEY'],
    defaultWireFormat: 'responses',
    defaultPath: '/v1/responses',
    host: 'router-api.ramp.com',
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.RAMP_ROUTER_API_KEY}`,
    }),
    families: {
      kimi: {
        model: FAMILY_MODELS.kimi,
        extraBody: { temperature: undefined },
        reasoningCountsAsFirstToken: true,
      },
    },
  },
  {
    name: 'neon',
    requiredEnvVars: ['NEON_AI_GATEWAY_BASE_URL', 'NEON_AI_GATEWAY_TOKEN'],
    defaultWireFormat: 'openai',
    defaultPath: '/v1/chat/completions',
    host: resolveNeonHost,
    buildHeaders: () => ({
      Authorization: `Bearer ${process.env.NEON_AI_GATEWAY_TOKEN}`,
    }),
    families: {
      kimi: {
        model: FAMILY_MODELS.kimi,
        extraBody: { temperature: undefined },
        reasoningCountsAsFirstToken: true,
      },
    },
  },
];
