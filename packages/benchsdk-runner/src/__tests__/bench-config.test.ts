import { describe, expect, it, vi } from 'vitest';
import { defineBenchmarkConfig, defineStep, defineTask, TaskError } from '../bench-config';

describe('defineBenchmarkConfig', () => {
  it('returns the config unchanged when valid', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      benchmarkKind: 'sandbox',
      iterations: 5,
      concurrency: 1,
      staggerDelayMs: 0,
    });
    expect(config.benchmarkSlug).toBe('sandbox-tti-local');
    expect(config.iterations).toBe(5);
  });

  it('allows the minimal shape (slug + name)', () => {
    const config = defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n' });
    expect(config.iterations).toBeUndefined();
  });

  it('requires benchmarkSlug', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: '', benchmarkName: 'n' })).toThrow('benchmarkSlug is required');
  });

  it('requires benchmarkName', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: '' })).toThrow('benchmarkName is required');
  });

  it('rejects non-integer or < 1 iterations', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', iterations: 0 })).toThrow('iterations');
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', iterations: 1.5 })).toThrow('iterations');
  });

  it('rejects concurrency < 1', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', concurrency: 0 })).toThrow('concurrency');
  });

  it('rejects negative staggerDelayMs', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', staggerDelayMs: -1 })).toThrow('staggerDelayMs');
  });

  it('accepts staggerDelayMs of 0', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', staggerDelayMs: 0 })).not.toThrow();
  });

  it('accepts a valid phases array', () => {
    const config = defineBenchmarkConfig({
      benchmarkSlug: 's',
      benchmarkName: 'n',
      phases: [{ name: 'cold', iterations: 3 }, { name: 'warm', iterations: 3 }],
    });
    expect(config.phases).toHaveLength(2);
  });

  it('rejects phases and iterations together', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', iterations: 2, phases: [{ name: 'cold', iterations: 1 }] }),
    ).toThrow('mutually exclusive');
  });

  it('rejects an empty phases array', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', phases: [] })).toThrow('non-empty');
  });

  it('rejects a phase with non-integer or < 1 iterations', () => {
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', phases: [{ name: 'cold', iterations: 0 }] })).toThrow('cold');
    expect(() => defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', phases: [{ name: 'cold', iterations: 1.5 }] })).toThrow('cold');
  });

  it('rejects duplicate phase names', () => {
    expect(() =>
      defineBenchmarkConfig({ benchmarkSlug: 's', benchmarkName: 'n', phases: [{ name: 'cold', iterations: 1 }, { name: 'cold', iterations: 1 }] }),
    ).toThrow('duplicate phase name');
  });
});

describe('defineTask', () => {
  it('function form returns the task function as-is under `run`', async () => {
    const fn = vi.fn(async () => ({ data: { ok: true } }));
    const task = defineTask(fn);
    const ctx = { participant: { name: 'e2b' }, taskIndex: 0, step: async (_n: string, f: any) => f() } as any;
    await task.run(ctx);
    expect(fn).toHaveBeenCalledWith(ctx);
  });

  it('array form runs steps in order and merges their JsonObject returns into data', async () => {
    const order: string[] = [];
    const task = defineTask([
      defineStep('a', () => { order.push('a'); return { first: 1 }; }),
      defineStep('b', () => { order.push('b'); return { second: 2 }; }),
    ]);

    const stepped: string[] = [];
    const ctx = {
      participant: { name: 'e2b' },
      taskIndex: 0,
      step: async (name: string, f: any) => { stepped.push(name); return f(); },
    } as any;

    const result = await task.run(ctx);
    expect(order).toEqual(['a', 'b']);
    expect(stepped).toEqual(['a', 'b']);
    expect(result).toEqual({ data: { first: 1, second: 2 } });
  });

  it('array form threads values between steps via ctx.state', async () => {
    const task = defineTask([
      defineStep('create', ({ state }) => { state.id = 'sbx_0'; }),
      defineStep('use', ({ state }) => ({ used: String(state.id) })),
    ]);
    const ctx = { participant: { name: 'e2b' }, taskIndex: 0, step: async (_n: string, f: any) => f() } as any;
    const result = await task.run(ctx);
    expect(result).toEqual({ data: { used: 'sbx_0' } });
  });

  it('rejects a non-array, empty step list', () => {
    expect(() => defineTask([])).toThrow('non-empty');
  });

  it('rejects duplicate step names', () => {
    expect(() => defineTask([
      defineStep('pause', () => undefined),
      defineStep('pause', () => undefined),
    ])).toThrow('unique');
  });
});

describe('defineStep', () => {
  it('supports both signatures and validates name/fn', () => {
    const withFn = defineStep('a', () => ({ x: 1 }));
    expect(withFn).toMatchObject({ name: 'a' });
    expect(withFn.options).toBeUndefined();
    const withOptions = defineStep('b', { readiness: 'poll' }, () => undefined);
    expect(withOptions.options).toMatchObject({ readiness: 'poll' });
    expect(() => defineStep('   ', () => undefined)).toThrow('non-empty');
    expect(() => defineStep('c', { readiness: 'internal' })).toThrow('function is required');
  });
});

describe('TaskError', () => {
  it('carries code, data, and steps and names itself', () => {
    const err = new TaskError('boom', { code: 'probe_failed', data: { mode: 'cold' }, steps: [{ name: 'ttft', status: 'success', latencyMs: 5 }] });
    expect(err.name).toBe('TaskError');
    expect(err.message).toBe('boom');
    expect(err.code).toBe('probe_failed');
    expect(err.data).toEqual({ mode: 'cold' });
    expect(err.steps).toEqual([{ name: 'ttft', status: 'success', latencyMs: 5 }]);
    expect(err).toBeInstanceOf(Error);
  });

  it('allows construction without options', () => {
    const err = new TaskError('boom');
    expect(err.code).toBeUndefined();
    expect(err.data).toBeUndefined();
    expect(err.steps).toBeUndefined();
  });
});
