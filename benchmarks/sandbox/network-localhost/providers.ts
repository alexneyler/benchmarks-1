import { providers as sandboxProviders } from '../providers.js';
import type { ProviderConfig } from '../types.js';

/**
 * Provider pool for ${SUITE_CONFIG.id} benchmark.
 * Mirrors the full sandbox provider list.
 */
export const providers: ProviderConfig[] = sandboxProviders;
