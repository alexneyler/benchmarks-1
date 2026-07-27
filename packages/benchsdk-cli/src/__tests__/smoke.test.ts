import { describe, expect, it } from 'vitest';
import { LogBuffer, uploadWorkerLog, loggedStep, defineBenchmark } from '../index';
import type { BenchmarkConfig, ConfigBenchmarkMode, StepOutcome } from '../index';

describe('@benchsdk/cli exports', () => {
  it('LogBuffer is constructable and accumulates steps', () => {
    const buf = new LogBuffer();
    expect(buf.isEmpty()).toBe(true);
    buf.step(0, 'create', {});
    expect(buf.isEmpty()).toBe(false);
    expect(buf.toText()).toContain('[task 0] create');
  });

  it('defineBenchmark validates and returns config', () => {
    const config = defineBenchmark({ mode: 'sequential', iterations: 10 });
    expect(config.mode).toBe('sequential');
    expect(config.iterations).toBe(10);
  });

  it('defineBenchmark rejects invalid modes', () => {
    expect(() => defineBenchmark({ mode: 'invalid' as any })).toThrow('Invalid mode');
  });

  it('defineBenchmark rejects task for sandbox-dax', () => {
    expect(() => defineBenchmark({ mode: 'sandbox-dax', task: async () => {} })).toThrow('task is not supported');
  });

  it('loggedStep is a function', () => {
    expect(typeof loggedStep).toBe('function');
  });

  it('uploadWorkerLog is a function', () => {
    expect(typeof uploadWorkerLog).toBe('function');
  });
});
