import { isStamp, runPaths, type RunOutcome, type SessionPaths } from '@zenera/engine';
import { turns, type TokenUsage } from '@zenera/neo';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HttpError } from './http.ts';
import { threadRunLogs } from './runLog.ts';

const ID = /^[\w-]{1,80}$/;

export interface RunRecord {
    runId: string;
    startedAt: string;
    finishedAt?: string;
    status: 'running' | 'finished' | 'error' | 'cancelled' | 'timeout' | 'interrupted' | 'unknown';
    engineRunId?: string;
    durationMs?: number;
    agent?: string;
    stopReason?: string;
    error?: string;
    usage?: TokenUsage;
    modelCalls?: number;
    sessionModelCalls?: number;
    /** session trajectory length before this run; absent on records written before it was kept */
    trajectoryStart?: number;
}

export interface RunSummary extends RunRecord {
    recording: 'available' | 'pending' | 'unavailable';
    reportAvailable: boolean;
}

export function recordOutcome(
    record: RunRecord,
    outcome: RunOutcome,
    before: { usage?: TokenUsage; modelCalls: number; trajectoryLength?: number },
): void {
    const usage = outcome.result.usage;
    Object.assign(record, {
        engineRunId: outcome.run.id,
        durationMs: outcome.durationMs,
        agent: outcome.result.agent,
        stopReason: outcome.result.stopReason,
        usage: {
            inputTokens: usage.inputTokens - (before.usage?.inputTokens ?? 0),
            cachedInputTokens: usage.cachedInputTokens - (before.usage?.cachedInputTokens ?? 0),
            outputTokens: usage.outputTokens - (before.usage?.outputTokens ?? 0),
            reasoningTokens: usage.reasoningTokens - (before.usage?.reasoningTokens ?? 0),
        },
        modelCalls: turns(outcome.result.state) - before.modelCalls,
        sessionModelCalls: turns(outcome.result.state),
        trajectoryStart: before.trajectoryLength ?? 0,
        status:
            outcome.result.stopReason === 'failed'
                ? 'error'
                : outcome.result.stopReason === 'aborted'
                  ? 'cancelled'
                  : 'finished',
        error: outcome.result.state.error,
    });
}

function recordFile(dir: string, runId: string): string {
    if (!ID.test(runId)) throw new HttpError(400, 'invalid run id');
    return join(dir, `${runId}.json`);
}

export function startRecord(dir: string, runId: string): RunRecord {
    const file = recordFile(dir, runId);
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).some((name) => new RegExp(`^\\d+-${runId}\\.ndjson$`).test(name))) {
        throw new HttpError(409, 'this run id has already been used');
    }
    const record: RunRecord = { runId, startedAt: new Date().toISOString(), status: 'running' };
    try {
        writeFileSync(file, JSON.stringify(record), { flag: 'wx' });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new HttpError(409, 'this run id has already been used');
        }
        throw err;
    }
    return record;
}

export function saveRecord(dir: string, record: RunRecord): void {
    const file = recordFile(dir, record.runId);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, file);
}

function readRecord(dir: string, runId: string): RunRecord {
    const record: RunRecord = JSON.parse(readFileSync(recordFile(dir, runId), 'utf8'));
    if (record.runId !== runId || (record.engineRunId && !isStamp(record.engineRunId))) {
        throw new HttpError(500, 'invalid recorded run identity');
    }
    return record;
}

async function reportExists(session: SessionPaths | null, record: RunRecord): Promise<boolean> {
    if (!session || !record.engineRunId) return false;
    try {
        return (await stat(runPaths(session, record.engineRunId).report)).isFile();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
    }
}

export async function listRunRecords(
    dir: string,
    session: SessionPaths | null,
    activeRunId?: string,
): Promise<RunSummary[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
    }
    const records = new Map<string, RunRecord>();
    for (const name of names) {
        if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
        const record = readRecord(dir, name.slice(0, -5));
        records.set(record.runId, record);
    }
    // Older chats have event logs but no reliable engine-run mapping.
    for (const log of await threadRunLogs(dir)) {
        if (!records.has(log.runId)) {
            records.set(log.runId, {
                runId: log.runId,
                startedAt: new Date(Number(basename(log.file).split('-')[0])).toISOString(),
                status: 'unknown',
            });
        }
    }
    return Promise.all(
        [...records.values()]
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
            .map(async (record) => {
                const active = record.runId === activeRunId;
                const interrupted = record.status === 'running' && !active;
                return {
                    ...record,
                    ...(interrupted
                        ? {
                              status: 'interrupted' as const,
                              error: 'the run was interrupted before its recording completed',
                          }
                        : {}),
                    recording: record.engineRunId
                        ? 'available'
                        : active
                          ? 'pending'
                          : 'unavailable',
                    reportAvailable: await reportExists(session, record),
                };
            }),
    );
}

export async function recordedReport(
    dir: string,
    session: SessionPaths | null,
    runId: string,
): Promise<string> {
    const file = recordFile(dir, runId);
    if (!existsSync(file)) throw new HttpError(404, 'no recording for this run');
    const record = readRecord(dir, runId);
    if (!(await reportExists(session, record)) || !session || !record.engineRunId) {
        throw new HttpError(404, 'the inspector report is unavailable for this run');
    }
    return readFile(runPaths(session, record.engineRunId).report, 'utf8');
}

/** The run's record and its recorded engine state file, or 404 when it was never recorded. */
export function recordedRun(
    dir: string,
    session: SessionPaths | null,
    runId: string,
): { record: RunRecord; session: SessionPaths; statePath: string } {
    const file = recordFile(dir, runId);
    if (!existsSync(file)) throw new HttpError(404, 'no recording for this run');
    const record = readRecord(dir, runId);
    if (!session || !record.engineRunId) {
        throw new HttpError(404, 'this run has no engine recording');
    }
    const statePath = runPaths(session, record.engineRunId).state;
    if (!existsSync(statePath)) throw new HttpError(404, 'the recorded run state is missing');
    return { record, session, statePath };
}
