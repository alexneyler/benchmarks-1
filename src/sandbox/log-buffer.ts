/**
 * Accumulates one text log per worker across a sandbox lifecycle's steps
 * (create → exec → destroy), uploaded once via `runWorker`'s `onFinish` hook
 * as a `coordinator.log` artifact — matches the detection heuristic in
 * benchmarks-platform's worker-log-metrics-panel.tsx (contentType/kind).
 */
import type { WorkerFinishContext } from '@computesdk/bench';

export interface StepOutcome {
  stdout?: string;
  stderr?: string;
  error?: string;
}

export class LogBuffer {
  private readonly lines: string[] = [];

  step(taskIndex: number, stepName: string, outcome: StepOutcome): void {
    const header = `[task ${taskIndex}] ${stepName}`;
    this.lines.push(`${new Date().toISOString()} ${header}`);
    if (outcome.stdout?.trim()) {
      this.lines.push(indent(outcome.stdout));
    }
    if (outcome.stderr?.trim()) {
      this.lines.push(indent(outcome.stderr, 'stderr: '));
    }
    if (outcome.error) {
      this.lines.push(indent(outcome.error, 'error: '));
    }
  }

  isEmpty(): boolean {
    return this.lines.length === 0;
  }

  toText(): string {
    return this.lines.join('\n') + '\n';
  }
}

function indent(text: string, prefix = ''): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => `  ${prefix}${line}`)
    .join('\n');
}

/** Uploads the buffered log as a `coordinator.log` artifact; never throws — a failed log upload must not fail the benchmark. */
export async function uploadWorkerLog(
  ctx: WorkerFinishContext,
  buffer: LogBuffer,
  providerName: string,
): Promise<void> {
  if (buffer.isEmpty()) return;
  try {
    await ctx.uploadArtifact({
      kind: 'coordinator.log',
      contentType: 'text/plain',
      name: 'worker.log',
      body: buffer.toText(),
    });
  } catch (err) {
    console.warn(`  [${providerName}] failed to upload log artifact: ${err instanceof Error ? err.message : String(err)}`);
  }
}
