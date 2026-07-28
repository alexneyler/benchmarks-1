import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createBenchmarkClient = vi.fn();
const reporterClaim = vi.fn();

vi.mock('@benchsdk/client', () => ({
  createBenchmarkClient: (...args: unknown[]) => createBenchmarkClient(...args),
  BenchmarkReporter: { claim: (...args: unknown[]) => reporterClaim(...args) },
  selectParticipants: (all: any[], names?: string[]) => (names ? all.filter((p) => names.includes(p.name)) : all),
  filterParticipantsByEnv: (ps: any[]) => {
    const available: any[] = [];
    const skipped: { name: string; missing: string[] }[] = [];
    for (const p of ps) {
      const missing = (p.requiredEnvVars as string[]).filter((v) => !process.env[v]);
      if (missing.length) skipped.push({ name: p.name, missing });
      else available.push(p);
    }
    return { available, skipped };
  },
}));

import { parseCliArgs, mergeConfig, runBenchmark } from '../runner';
import type { BenchmarkConfig } from '../bench-config';

describe('parseCliArgs', () => {
  it('parses space-separated flags', () => {
    expect(parseCliArgs(['--iterations', '10', '--concurrency', '4', '--stagger-delay-ms', '250'])).toEqual({
      iterations: 10,
      concurrency: 4,
      staggerDelayMs: 250,
    });
  });

  it('parses = separated flags', () => {
    expect(parseCliArgs(['--iterations=7', '--concurrency=2'])).toEqual({ iterations: 7, concurrency: 2 });
  });

  it('parses comma-separated and repeated --provider', () => {
    expect(parseCliArgs(['--provider', 'e2b,modal', '--provider', 'daytona'])).toEqual({
      providers: ['e2b', 'modal', 'daytona'],
    });
  });

  it('parses --group-by', () => {
    expect(parseCliArgs(['--group-by', 'round'])).toEqual({ groupBy: 'round' });
    expect(parseCliArgs(['--group-by=participant'])).toEqual({ groupBy: 'participant' });
  });

  it('throws on invalid --group-by', () => {
    expect(() => parseCliArgs(['--group-by', 'nope'])).toThrow('--group-by');
  });

  it('ignores unknown flags', () => {
    expect(parseCliArgs(['--unknown', 'x', '--iterations', '3'])).toEqual({ iterations: 3 });
  });

  it('throws on non-numeric numeric flags', () => {
    expect(() => parseCliArgs(['--iterations', 'abc'])).toThrow('--iterations');
  });

  it('returns empty object for no args', () => {
    expect(parseCliArgs([])).toEqual({});
  });
});

describe('mergeConfig', () => {
  const config: BenchmarkConfig = {
    benchmarkSlug: 's',
    benchmarkName: 'n',
    iterations: 100,
    concurrency: 1,
    staggerDelayMs: 0,
    task: async () => ({}),
  };

  it('uses config defaults when no CLI args', () => {
    expect(mergeConfig(config, {})).toEqual({ iterations: 100, concurrency: 1, staggerDelayMs: 0, groupBy: 'participant', providers: undefined });
  });

  it('lets CLI args win over config', () => {
    expect(mergeConfig(config, { iterations: 5, concurrency: 5, staggerDelayMs: 200, groupBy: 'round', providers: ['e2b'] })).toEqual({
      iterations: 5,
      concurrency: 5,
      staggerDelayMs: 200,
      groupBy: 'round',
      providers: ['e2b'],
    });
  });

  it('falls back to knob defaults of 1/1/0/participant when neither config nor CLI set them', () => {
    const bare: BenchmarkConfig = { benchmarkSlug: 's', benchmarkName: 'n', task: async () => ({}) };
    expect(mergeConfig(bare, {})).toEqual({ iterations: 1, concurrency: 1, staggerDelayMs: 0, groupBy: 'participant', providers: undefined });
  });

  it('uses config.groupBy when CLI does not set it', () => {
    const rr: BenchmarkConfig = { benchmarkSlug: 's', benchmarkName: 'n', groupBy: 'round', task: async () => ({}) };
    expect(mergeConfig(rr, {}).groupBy).toBe('round');
  });

  it('falls back to config.defaultProviders when --provider is not passed', () => {
    const withDefaults: BenchmarkConfig = { benchmarkSlug: 's', benchmarkName: 'n', defaultProviders: ['e2b'], task: async () => ({}) };
    expect(mergeConfig(withDefaults, {}).providers).toEqual(['e2b']);
    expect(mergeConfig(withDefaults, { providers: ['modal'] }).providers).toEqual(['modal']);
  });
});

describe('runBenchmark', () => {
  const participants = [
    { name: 'e2b', requiredEnvVars: ['E2B_API_KEY'] },
    { name: 'modal', requiredEnvVars: ['MODAL_TOKEN'] },
  ];

  let calls: Record<string, any[]>;
  let fakeClient: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    reporterClaim.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.E2B_API_KEY = 'x';
    process.env.MODAL_TOKEN = 'y';
    calls = { upsertBenchmark: [], createRun: [], planWorkers: [], runWorker: [] };
    fakeClient = {
      upsertBenchmark: vi.fn(async (...a: any[]) => { calls.upsertBenchmark.push(a); return {}; }),
      createRun: vi.fn(async (...a: any[]) => { calls.createRun.push(a); return { run: { id: 'run-1' }, participants: [] }; }),
      planWorkers: vi.fn(async (...a: any[]) => { calls.planWorkers.push(a); return []; }),
      runWorker: vi.fn(async (opts: any) => {
        calls.runWorker.push(opts);
        const record = await opts.task({ taskIndex: 0, assignment: {}, step: async (_n: string, fn: any) => fn() });
        opts.onResult?.({ taskIndex: 0, status: 'success', data: record ?? {} });
        return { assignment: { workerId: 'w1' }, records: [{ taskIndex: 0, status: 'success' }] };
      }),
    };
    createBenchmarkClient.mockReturnValue(fakeClient);
  });

  afterEach(() => {
    delete process.env.E2B_API_KEY;
    delete process.env.MODAL_TOKEN;
  });

  it('drives upsert -> createRun -> planWorkers/runWorker per available participant', async () => {
    const task = vi.fn(async () => ({ ttiMs: 42 }));
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 'sandbox-tti-local',
      benchmarkName: 'Sandbox TTI',
      benchmarkKind: 'sandbox',
      iterations: 3,
      concurrency: 1,
      task,
    };

    await runBenchmark(config, participants, []);

    expect(calls.upsertBenchmark[0][0]).toBe('sandbox-tti-local');
    expect(calls.upsertBenchmark[0][1]).toMatchObject({ name: 'Sandbox TTI', kind: 'sandbox' });
    expect(calls.createRun[0][1]).toMatchObject({ totalTasks: 3, workerCount: 1, participants: ['e2b', 'modal'] });
    expect(calls.planWorkers).toHaveLength(2);
    expect(calls.runWorker).toHaveLength(2);
    expect(calls.runWorker[0].concurrency).toBe(1);
    // The runner's task wrapper forwards participant/taskIndex/step to config.task.
    expect(task).toHaveBeenCalledWith(expect.objectContaining({ participant: participants[0], taskIndex: 0 }));
  });

  it('applies CLI overrides over config', async () => {
    const config: BenchmarkConfig<typeof participants[number]> = {
      benchmarkSlug: 's',
      benchmarkName: 'n',
      iterations: 100,
      concurrency: 1,
      task: async () => ({}),
    };

    await runBenchmark(config, participants, ['--iterations', '5', '--concurrency', '5', '--provider', 'e2b']);

    expect(calls.createRun[0][1]).toMatchObject({ totalTasks: 5, participants: ['e2b'] });
    expect(calls.runWorker).toHaveLength(1);
    expect(calls.runWorker[0].concurrency).toBe(5);
  });

  it('skips participants missing env and exits when none available', async () => {
    delete process.env.E2B_API_KEY;
    delete process.env.MODAL_TOKEN;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', task: async () => ({}) },
      participants,
      [],
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(createBenchmarkClient).not.toHaveBeenCalled();
  });

  it('groupBy round: claims one reporter per participant, interleaves rounds, finishes each', async () => {
    const recorded: Record<string, TaskResultRecord[]> = { e2b: [], modal: [] };
    const finished: Record<string, boolean> = {};
    reporterClaim.mockImplementation(async (cfg: any) => ({
      taskIndexStart: 0,
      recordResult: (r: TaskResultRecord) => recorded[cfg.participantSlug].push(r),
      uploadArtifact: async () => ({}),
      finish: async (failedFlag: boolean) => { finished[cfg.participantSlug] = failedFlag; },
    }));

    // Task records a pre-measured step and returns data; records interleave e2b,modal per round.
    const order: string[] = [];
    const task = vi.fn(async (ctx: any) => {
      order.push(`${ctx.participant.name}#${ctx.taskIndex}`);
      ctx.recordStep({ name: 'probe', status: 'success', latencyMs: 5 });
      return { ok: true };
    });

    await runBenchmark(
      { benchmarkSlug: 'ai-gateway-local', benchmarkName: 'AI GW', iterations: 2, groupBy: 'round', task },
      participants,
      [],
    );

    expect(reporterClaim).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['e2b#0', 'modal#0', 'e2b#1', 'modal#1']);
    expect(recorded.e2b).toHaveLength(2);
    expect(recorded.modal).toHaveLength(2);
    // recordStep is persisted onto the built record in round mode.
    expect(recorded.e2b[0].steps).toEqual([{ name: 'probe', status: 'success', latencyMs: 5 }]);
    expect(recorded.e2b[0].status).toBe('success');
    expect(finished.e2b).toBe(false);
    expect(finished.modal).toBe(false);
    // runWorker is NOT used in round mode.
    expect(fakeClient.runWorker).not.toHaveBeenCalled();
    expect(fakeClient.planWorkers).toHaveBeenCalledTimes(2);
  });

  it('groupBy round: a thrown task is recorded as an errored result and marks the reporter failed', async () => {
    const finished: Record<string, boolean> = {};
    reporterClaim.mockImplementation(async (cfg: any) => ({
      taskIndexStart: 0,
      recordResult: () => {},
      uploadArtifact: async () => ({}),
      finish: async (failedFlag: boolean) => { finished[cfg.participantSlug] = failedFlag; },
    }));

    class ProbeError extends Error { name = 'probe_failed'; }
    const task = async () => { throw new ProbeError('boom'); };

    await runBenchmark(
      { benchmarkSlug: 's', benchmarkName: 'n', iterations: 1, groupBy: 'round', task },
      [participants[0]],
      [],
    );

    expect(finished.e2b).toBe(true);
  });
});
