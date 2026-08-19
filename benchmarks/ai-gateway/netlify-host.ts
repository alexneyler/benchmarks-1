export interface NetlifyHost {
  /** Hostname to connect to over TLS. */
  host: string;
  /** Pathname prefix (if any) from NETLIFY_AI_GATEWAY_BASE_URL. */
  basePath: string;
}

export function resolveNetlifyHost(): NetlifyHost {
  const base = process.env.NETLIFY_AI_GATEWAY_BASE_URL;
  if (!base || base.startsWith('your_')) {
    // Keep a non-empty sentinel so the participant is still registered in the
    // roster and requiredEnvVars remain visible, but a placeholder/missing base
    // URL fails with a DNS error instead of silently routing to localhost.
    return { host: 'netlify-ai-gateway.invalid', basePath: '' };
  }
  try {
    const url = new URL(base);
    const basePath = url.pathname.replace(/\/$/, '');
    return { host: url.hostname, basePath };
  } catch {
    return { host: 'netlify-ai-gateway.invalid', basePath: '' };
  }
}
