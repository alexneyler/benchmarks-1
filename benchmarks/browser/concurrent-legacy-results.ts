import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { summarizeRounds, writeConcurrentResultsJson } from './concurrent-benchmark.js';
import { computeConcurrentCompositeScores } from './concurrent-scoring.js';
import {
  ACTION_TYPES,
  type ActionResult,
  type ActionType,
  type ConcurrentBenchmarkResult,
  type RoundResult,
  type SessionResult,
} from './concurrent-types.js';

function num(x: unknown): number {
  return typeof x === 'number' ? x : 0;
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

/**
 * Map CLI participant records to legacy concurrent BenchmarkResult[].
 * Reconstructs each RoundResult (including per-session SessionResult with
 * per-action arrays) from the record's data payload.
 */
export function recordsToConcurrentResults(
  participants: ParticipantRecords[],
  concurrencyLevel: number,
): ConcurrentBenchmarkResult[] {
  return participants.map((participant) => {
    const rounds: RoundResult[] = byTaskIndex(participant.records).map((r) => {
      const d = (r.data ?? {}) as JsonObject;

      // Parse sessions array from the data payload
      const rawSessions = Array.isArray(d.sessions) ? (d.sessions as unknown as any[]) : [];
      const sessions: SessionResult[] = rawSessions.map(s => {
        const rawActions = Array.isArray(s.actions) ? (s.actions as unknown as any[]) : [];
        const actions: ActionResult[] = rawActions.map(a => ({
          index: num(a.index),
          type: a.type as ActionType,
          durationMs: num(a.durationMs),
          success: a.success === true,
          ...(a.error ? { error: String(a.error) } : {}),
        }));
        return {
          sessionId: str(s.sessionId) ?? '',
          createMs: num(s.createMs),
          connectMs: num(s.connectMs),
          taskMs: num(s.taskMs),
          actionsCompleted: num(s.actionsCompleted),
          actionsPerSecond: num(s.actionsPerSecond),
          actions,
          ...(s.error ? { error: String(s.error) } : {}),
        };
      });

      const round: RoundResult = {
        sessionsAttempted: num(d.sessionsAttempted) || concurrencyLevel,
        sessionsAlive: num(d.sessionsAlive),
        createMs: num(d.createMs),
        connectMs: num(d.connectMs),
        taskMs: num(d.taskMs),
        releaseMs: num(d.releaseMs),
        totalMs: num(d.totalMs),
        aggregateActionsPerSecond: num(d.aggregateActionsPerSecond),
        sessions,
      };

      if (d.createTimedOut === true) round.createTimedOut = true;
      if (d.roundFailed === true || round.sessionsAlive === 0) round.roundFailed = true;

      const errMsg = str(d.errorMessage);
      if (r.status === 'error' || errMsg) {
        round.error = errMsg ?? r.errorCode ?? 'error';
      }

      return round;
    });

    return {
      provider: participant.participant,
      mode: 'browser-concurrent' as const,
      concurrencyLevel,
      rounds,
      summary: summarizeRounds(rounds),
    };
  });
}

/**
 * Map records -> ConcurrentBenchmarkResult[], compute composite scores, and
 * write both `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 */
export async function writeConcurrentLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; concurrencyLevel: number; timeoutMs: number },
): Promise<void> {
  const results = recordsToConcurrentResults(participants, opts.concurrencyLevel);
  computeConcurrentCompositeScores(results);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeConcurrentResultsJson(results, outPath, {
    concurrencyLevel: opts.concurrencyLevel,
    timeoutMs: opts.timeoutMs,
  });

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
