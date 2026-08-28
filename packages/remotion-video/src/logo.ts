export const LOGO_API = 'https://logos.computesdk.com/api/svg';

export type LogoVariant =
  | 'logo-light'
  | 'logo-dark'
  | 'logomark-light'
  | 'logomark-dark'
  | 'stacked-light'
  | 'stacked-dark';

export type LogoFormat = 'raw' | 'normalized' | 'bounded';

const LOGOMARK_SLUG_OVERRIDES: Record<string, string> = {
  'cloud-run': 'google-cloud-run',
  lightning: 'lightning-ai',
};

export function logomarkSlug(provider: string): string {
  return LOGOMARK_SLUG_OVERRIDES[provider] ?? provider;
}

export function logoUrl(
  brandId: string,
  variant: LogoVariant,
  format: LogoFormat = 'normalized',
  contentHash?: string,
): string {
  const base = `${LOGO_API}/${brandId}/${format}/${variant}`;
  return contentHash ? `${base}?v=${contentHash}` : base;
}

const LOGO_BRAND_ID_OVERRIDES: Record<string, string> = {
  'azure-blob': 'azure',
  'vercel-blob': 'vercel',
  'cloudflare-r2': 'cloudflare',
  'anchor-browser': 'anchor',
  browseruse: 'browser-use',
  justbash: 'just-bash',
  'cloud-run': 'google-cloud-run',
  lightning: 'lightning-ai',
  llmgateway: 'llm-gateway',
  'vercel-ai-gateway': 'vercel',
  'cloudflare-ai-gateway': 'cloudflare',
  'pydantic-ai-gateway': 'pydantic',
  'concentrate-ai-gateway': 'concentrate',
  'anthropic-direct': 'anthropic',
  'openai-direct': 'openai',
  'gemini-direct': 'google-gemini',
  'kimi-direct': 'kimi',
  'gcs': 'google-cloud-storage',
};

export const MISSING_LOGO_BRAND_IDS = new Set<string>(['lightning-ai', 'sail']);

export function providerBrandId(provider: string): string {
  return LOGO_BRAND_ID_OVERRIDES[provider] ?? provider;
}

function localLogoPath(provider: string, variant: LogoVariant): string {
  const name = logomarkSlug(provider);
  const theme = variant.endsWith('-dark') ? 'dark' : 'light';
  if (variant.startsWith('logomark-')) {
    return `/benchmarks/${name}-logomark-${theme}.svg`;
  }
  return `/benchmarks/normal-${name}-${theme}.svg`;
}

export function providerLogoUrl(
  provider: string,
  variant: LogoVariant,
  format: LogoFormat = 'normalized',
  contentHash?: string,
): string {
  const brandId = providerBrandId(provider);
  if (MISSING_LOGO_BRAND_IDS.has(brandId)) {
    return localLogoPath(provider, variant);
  }
  return logoUrl(brandId, variant, format, contentHash);
}

export function normalizeProvider(provider: string): string {
  return provider.replace(/-sandbox$/, '');
}

export function capitalize(s: string): string {
  if (s.toLowerCase() === 'e2b') return 'E2B';
  if (s.toLowerCase() === 'codesandbox') return 'CodeSandbox';
  if (s === 'just-bash' || s === 'justbash') return 'JustBash';
  if (s === 'gcs') return 'GCS';
  if (s === 'aws-s3') return 'AWS S3';
  if (s === 'cloudflare-r2') return 'Cloudflare R2';
  if (s === 'tigris') return 'Tigris';
  if (s === 'azure-blob') return 'Azure Blob';
  if (s === 'vercel-blob') return 'Vercel Blob';
  if (s === 'createos') return 'CreateOS';
  if (s === 'superserve') return 'Superserve';
  if (s === 'browserbase') return 'Browserbase';
  if (s === 'browseruse' || s === 'browser-use') return 'Browser Use';
  if (s === 'kernel') return 'Kernel';
  if (s === 'hyperbrowser') return 'Hyperbrowser';
  if (s === 'steel') return 'Steel';
  if (s === 'cloud-run') return 'Cloud Run';
  if (s === 'run-cloud') return 'Run Cloud';
  if (s === 'lightning') return 'Lightning AI';
  if (s === 'opencomputer') return 'OpenComputer';
  if (s === 'openrouter') return 'OpenRouter';
  if (s === 'vercel-ai-gateway') return 'Vercel AI Gateway';
  if (s === 'cloudflare-ai-gateway') return 'Cloudflare AI Gateway';
  if (s === 'llmgateway') return 'LLMgateway';
  if (s === 'pydantic-ai-gateway') return 'Pydantic AI Gateway';
  if (s === 'concentrate-ai-gateway') return 'Concentrate AI';
  if (s === 'ramp') return 'Ramp Router';
  if (s === 'ngrok') return 'ngrok AI Gateway';
  if (s === 'anthropic-direct') return 'Anthropic (Direct)';
  if (s === 'openai-direct') return 'OpenAI (Direct)';
  if (s === 'gemini-direct') return 'Gemini (Direct)';
  if (s === 'kimi-direct') return 'Kimi (Direct)';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
