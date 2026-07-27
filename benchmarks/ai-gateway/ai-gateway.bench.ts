/**
 * Self-contained AI Gateway benchmark: config and orchestration live in this
 * one file, built directly on `@benchsdk/client` (see packages/benchsdk). Always reports to
 * benchmarks-platform (no local-only JSON mode). The actual probe logic
 * (phase-probe.ts) is unchanged and shared with the flag-based
 * `run.ts --mode ai-gateway` path — only the orchestration differs here.
 *
 * Run directly:
 *   tsx benchmarks/ai-gateway/ai-gateway.bench.ts
 *
 * Point at a local benchmarks-platform dev server (the default) or a real
 * one via BENCHMARKS_PLATFORM_URL — see the config block below.
 *
 * Why this ISN'T built on the standard defineWorker/client.runWorker
 * pattern the other *.bench.ts files use (see dax.bench.ts): that pattern
 * claims one worker per participant and runs that participant's tasks to
 * completion before moving to the next. AI Gateway's whole fairness
 * argument (see AI_GATEWAYS.md) is the opposite — every gateway's Nth
 * iteration must run at roughly the same point in time as every other
 * gateway's Nth iteration, interleaved in one process, so no gateway is
 * favored by running earlier/later or during a different network
 * condition. Running participants sequentially (as client.runWorker does)
 * would silently break that guarantee — the same reason the CI workflow is
 * a single job, not a per-provider matrix. So this file claims a
 * BenchmarkReporter per gateway up front, then drives the interleaved
 * round-robin loop itself, streaming each iteration's result to whichever
 * gateway's reporter it belongs to as it completes.
 */
import '../src/env.js';
import { createBenchmarkClient, BenchmarkReporter } from '@benchsdk/client';
import type { JsonObject, TaskResultRecord, TaskStepRecord } from '@benchsdk/client';
import { runColdProbe, runWarmProbe } from './phase-probe.js';
import { providers } from './providers.js';
import type { AIGatewayProviderConfig, PhaseProbeResult } from './types.js';

// ---------------------------------------------------------------------------
// Config — everything about *this* benchmark run. Request parameters match
// run.ts's AI Gateway defaults exactly (see AI_GATEWAYS.md's "Request
// configuration" — identical across every gateway is load-bearing for
// fairness), so results stay comparable across both paths.
// ---------------------------------------------------------------------------
const benchmarkSlug = 'ai-gateway-local';
const benchmarkName = 'AI Gateway Benchmark - Local';
const iterationsCold = 3;
const iterationsWarm = 3;
const prompt = 'Write a two-sentence description of how distributed systems handle partial failures.';
const maxTokens = 200;
const timeout = 45_000;

const baseUrl = (process.env.BENCHMARKS_PLATFORM_URL || 'http://localhost:3000').replace(/\/+$/, '') + '/api/v1';
const orgSlug = process.env.BENCHMARKS_PLATFORM_ORG_SLUG || 'computesdk';
const client = createBenchmarkClient({ baseUrl });

// ---------------------------------------------------------------------------
// Reporting — maps one finalized probe iteration onto the platform's
// task-result shape. DNS/TCP/TLS only apply to cold iterations (a warm
// probe reuses an already-open connection — see phase-probe.ts).
// ---------------------------------------------------------------------------
function toTaskRecord(result: PhaseProbeResult, taskIndex: number): TaskResultRecord {
  const steps: TaskStepRecord[] = [];
  if (result.mode === 'cold') {
    if (result.dnsMs !== undefined) steps.push({ name: 'dns', status: 'success', latencyMs: result.dnsMs });
    if (result.tcpMs !== undefined) steps.push({ name: 'tcp', status: 'success', latencyMs: result.tcpMs });
    if (result.tlsMs !== undefined) steps.push({ name: 'tls', status: 'success', latencyMs: result.tlsMs });
  }
  const stepStatus = result.error ? 'error' : 'success';
  steps.push({ name: 'ttfb', status: stepStatus, latencyMs: result.ttfbMs });
  steps.push({ name: 'ttft', status: stepStatus, latencyMs: result.ttftMs });

  const data: JsonObject = {
    mode: result.mode,
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.outputTokensPerSec !== undefined ? { outputTokensPerSec: result.outputTokensPerSec } : {}),
    ...(result.receipts && Object.keys(result.receipts).length > 0 ? { receipts: result.receipts } : {}),
    ...(result.error ? { error: result.error } : {}),
  };

  return {
    taskIndex,
    status: result.error ? 'error' : 'success',
    latencyMs: result.coldE2eMs ?? result.ttftMs,
    ...(result.error ? { errorCode: 'probe_failed' } : {}),
    steps,
    data,
  };
}

interface ActiveGateway {
  config: AIGatewayProviderConfig;
  reporter: BenchmarkReporter | null;
  nextTaskIndex: number;
  hadError: boolean;
}

async function main(): Promise<void> {
  const active: ActiveGateway[] = [];
  for (const config of providers) {
    const missing = config.requiredEnvVars.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      console.log(`Skipping ${config.name}: missing ${missing.join(', ')}`);
      continue;
    }
    active.push({ config, reporter: null, nextTaskIndex: 0, hadError: false });
  }

  if (active.length === 0) {
    console.error('No gateways have their required env vars set — nothing to run.');
    process.exit(1);
  }

  console.log('ComputeSDK AI Gateway Benchmark (self-contained)');
  console.log(`Date: ${new Date().toISOString()}\n`);

  const tasksPerGateway = iterationsCold + iterationsWarm;

  await client.upsertBenchmark(benchmarkSlug, { name: benchmarkName, kind: 'ai-gateway' });

  // totalTasks/workerCount here are PER-PARTICIPANT, not summed across the
  // run: createRun stamps both values onto every participant row it creates
  // (uniformly — there's no per-participant override at this step). Each
  // gateway gets tasksPerGateway tasks and exactly one worker (this process)
  // — matching dax.bench.ts/sequential.bench.ts's totalTasks: iterations,
  // workerCount: 1. A specific gateway's totalTasks/workerCount can still be
  // overridden later, at its own planWorkers call below (see that route's
  // handling of workerCount/targetConcurrency).
  const { run } = await client.createRun(benchmarkSlug, {
    name: `ai-gateway - ${iterationsCold} cold + ${iterationsWarm} warm`,
    totalTasks: tasksPerGateway,
    workerCount: 1,
    participants: active.map((a) => a.config.name),
  });

  const dashboardUrl = `${baseUrl.replace(/\/api\/v1\/?$/, '')}/${orgSlug}/benchmarks/${benchmarkSlug}/runs/${run.id}`;
  console.log(`Run created: ${run.id}`);
  console.log(`View at: ${dashboardUrl}\n`);

  // Claim one worker per gateway up front so the round-robin loop below can
  // stream each result to the right reporter as it completes, instead of
  // finishing one gateway's tasks before starting the next.
  for (const gateway of active) {
    await client.planWorkers(benchmarkSlug, run.id, gateway.config.name, {
      workerCount: 1,
      targetConcurrency: tasksPerGateway,
    });
    gateway.reporter = await BenchmarkReporter.claim({
      baseUrl,
      benchmarkSlug,
      runId: run.id,
      participantSlug: gateway.config.name,
      processKind: 'process',
      processKey: process.env.HOSTNAME ?? 'local',
    });
    if (gateway.reporter) {
      gateway.nextTaskIndex = gateway.reporter.taskIndexStart;
    } else {
      console.warn(`  ${gateway.config.name}: could not claim a platform worker — running without platform reporting for this gateway`);
    }
  }

  console.log(`\n--- AI Gateway Benchmark: ${active.length} gateway(s), ${iterationsCold} cold + ${iterationsWarm} warm iteration(s) each, round-robin across gateways ---`);

  const totalRounds = iterationsCold + iterationsWarm;
  for (let round_ = 0; round_ < totalRounds; round_++) {
    const isCold = round_ < iterationsCold;
    const label = isCold ? 'cold' : 'warm';
    const roundIndex = isCold ? round_ + 1 : round_ - iterationsCold + 1;
    const roundTotal = isCold ? iterationsCold : iterationsWarm;

    for (const gateway of active) {
      const probe = isCold ? runColdProbe : runWarmProbe;
      const result = await probe(gateway.config, prompt, maxTokens, timeout);

      if (result.error) {
        gateway.hadError = true;
        console.log(`  [${label} ${roundIndex}/${roundTotal}] ${gateway.config.name}: FAILED — ${result.error}`);
      } else {
        const e2e = result.coldE2eMs !== undefined ? ` e2e ${result.coldE2eMs.toFixed(0)}ms` : '';
        console.log(`  [${label} ${roundIndex}/${roundTotal}] ${gateway.config.name}: ttfb ${result.ttfbMs.toFixed(0)}ms ttft ${result.ttftMs.toFixed(0)}ms${e2e}`);
      }

      gateway.reporter?.recordResult(toTaskRecord(result, gateway.nextTaskIndex));
      gateway.nextTaskIndex += 1;
    }
  }

  for (const gateway of active) {
    await gateway.reporter?.finish(gateway.hadError);
  }

  console.log(`\nAll done. View at: ${dashboardUrl}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
