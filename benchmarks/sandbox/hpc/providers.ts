import { providers as sandboxProviders } from '../providers.js';
import type { ProviderConfig } from '../types.js';

/**
 * Provider pool for HPC mode.
 *
 * v1 mirrors the full sandbox provider list. Each provider is run with
 * whatever shape ComputeSDK gives the underlying SDK by default — we
 * record the actual `provider.sandboxOptions` it shipped with in
 * `WorkloadResult.meta` but do NOT enforce the starsling 4 vCPU / 8 GiB
 * shape, because most @computesdk/* SDKs do not expose shape control at
 * sandbox-create time. Heterogeneity across providers remains comparable
 * per-row but not per-column.
 *
 * Note: this list will diverge from `sandbox/providers.ts` once we add
 * provider-specific bundle pre-baking decisions (e.g. blaxel needs the
 * standby keepalive the upstream project added in PR #219).
 */
export const providers: ProviderConfig[] = sandboxProviders;
