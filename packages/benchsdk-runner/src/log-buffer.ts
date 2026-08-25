import type { BenchmarkLogLevel, BenchmarkLogOptions, BenchmarkStepOutcome } from '@benchsdk/api';

/**
 * Accumulates one text log per worker across a task's steps, uploaded once as a
 * `coordinator.log` artifact. Used by the runner's manual `round` mode, where
 * `client.runWorker` (which owns log upload in `participant` mode) is not in
 * play.
 */
export type StepOutcome = BenchmarkStepOutcome;

function isLogOptions(value: unknown): value is BenchmarkLogOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return false;
  return keys.includes('level') || (keys.includes('meta') && keys.every((k) => k === 'level' || k === 'meta'));
}

export class LogBuffer {
  private readonly lines: string[] = [];

  step(taskIndex: number, stepName: string, outcome: BenchmarkStepOutcome): void {
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

  /** Appends a free-form narration line (backs the task context's `log`). */
  line(message: string, metaOrOptions?: Record<string, unknown> | BenchmarkLogOptions): void {
    const opts: { level: BenchmarkLogLevel; meta?: Record<string, unknown> } = isLogOptions(metaOrOptions)
      ? { level: metaOrOptions.level ?? 'info', meta: metaOrOptions.meta }
      : { level: 'info', meta: metaOrOptions };
    const suffix = opts.meta && Object.keys(opts.meta).length > 0 ? ` ${JSON.stringify(opts.meta)}` : '';
    this.lines.push(`${new Date().toISOString()} ${message} [${opts.level}]${suffix}`);
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
