import type { BaseParticipant } from '@benchsdk/client';

/**
 * Minimal sandbox shape used by the example benchmarks. A real provider would
 * return a provider SDK instance; here we just simulate create / run / destroy
 * so the examples can run without credentials.
 */
export interface NoopSandbox {
  runCommand(command: string): Promise<{ exitCode: number; stderr?: string }>;
  destroy(): Promise<void>;
}

export interface NoopParticipant extends BaseParticipant {
  /** Simulated compute factory. */
  createCompute(): { sandbox: { create(): Promise<NoopSandbox> } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createNoopParticipant(name: string, latencyMs = 100): NoopParticipant {
  return {
    name,
    requiredEnvVars: [],
    createCompute: () => ({
      sandbox: {
        create: async () => ({
          runCommand: async (command: string) => {
            // Add a small, variable delay so each provider reports distinct timing.
            await sleep(latencyMs + Math.floor(Math.random() * latencyMs));
            return { exitCode: 0, stderr: '' };
          },
          destroy: async () => {
            await sleep(10);
          },
        }),
      },
    }),
  };
}

export const exampleProviders: NoopParticipant[] = [
  createNoopParticipant('alpha', 100),
  createNoopParticipant('beta', 200),
  createNoopParticipant('gamma', 300),
];
