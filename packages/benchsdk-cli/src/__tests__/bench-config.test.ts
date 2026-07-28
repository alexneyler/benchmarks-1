import { describe, expect, it } from 'vitest';
import { defineBenchmark } from '../bench-config';

const baseTask = async () => ({});

describe('defineBenchmark', () => {
  it('returns the config unchanged when valid', () => {
    const config = defineBenchmark({
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      benchmarkKind: 'sandbox',
      iterations: 5,
      concurrency: 1,
      staggerDelayMs: 0,
      task: baseTask,
    });
    expect(config.benchmarkSlug).toBe('sandbox-tti-local');
    expect(config.iterations).toBe(5);
  });

  it('allows the minimal shape (slug + name + task)', () => {
    const config = defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', task: baseTask });
    expect(config.iterations).toBeUndefined();
  });

  it('requires benchmarkSlug', () => {
    expect(() => defineBenchmark({ benchmarkSlug: '', benchmarkName: 'n', task: baseTask })).toThrow('benchmarkSlug is required');
  });

  it('requires benchmarkName', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: '', task: baseTask })).toThrow('benchmarkName is required');
  });

  it('requires task to be a function', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', task: undefined as any })).toThrow('task must be a function');
  });

  it('rejects non-integer or < 1 iterations', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', iterations: 0, task: baseTask })).toThrow('iterations');
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', iterations: 1.5, task: baseTask })).toThrow('iterations');
  });

  it('rejects concurrency < 1', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', concurrency: 0, task: baseTask })).toThrow('concurrency');
  });

  it('rejects negative staggerDelayMs', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', staggerDelayMs: -1, task: baseTask })).toThrow('staggerDelayMs');
  });

  it('accepts staggerDelayMs of 0', () => {
    expect(() => defineBenchmark({ benchmarkSlug: 's', benchmarkName: 'n', staggerDelayMs: 0, task: baseTask })).not.toThrow();
  });
});
