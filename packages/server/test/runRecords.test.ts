import { createSessionAt, runPaths, type RunOutcome } from '@zenera/engine';
import type { AgentState, LlmCallNode } from '@zenera/neo';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, onTestFinished } from 'vitest';
import {
    listRunRecords,
    recordedReport,
    recordOutcome,
    saveRecord,
    startRecord,
} from '../src/runRecords.ts';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'run-records-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const session = createSessionAt(
        join(root, 'sessions', 'a-thread-uuid'),
        join(root, 'workspace'),
    );
    const dir = join(root, 'runs');
    return { session, dir };
}

test('maps chat ids to engine ids durably and reads only that report', async () => {
    const { session, dir } = fixture();
    const record = startRecord(dir, 'chat-run');
    record.engineRunId = '20261027-120000-abcd';
    record.status = 'finished';
    record.finishedAt = new Date().toISOString();
    saveRecord(dir, record);
    const engine = runPaths(session, record.engineRunId);
    mkdirSync(engine.dir, { recursive: true });
    writeFileSync(engine.report, '<html>correct report</html>');

    const records = await listRunRecords(dir, session);
    assert.equal(records[0].engineRunId, record.engineRunId);
    assert.equal(records[0].recording, 'available');
    assert.equal(records[0].reportAvailable, true);
    assert.equal(records[0].status, 'finished');
    assert.equal(await recordedReport(dir, session, 'chat-run'), '<html>correct report</html>');
    await assert.rejects(recordedReport(dir, session, 'other-run'), /no recording/);
    await assert.rejects(recordedReport(dir, null, 'chat-run'), /unavailable/);
    await assert.rejects(recordedReport(dir, session, '../../outside'), /invalid run id/);
    assert.throws(() => startRecord(dir, 'chat-run'), /already been used/);
});

test('active runs are pending and become interrupted after a restart', async () => {
    const { session, dir } = fixture();
    startRecord(dir, 'active');
    const [active] = await listRunRecords(dir, session, 'active');
    assert.equal(active.status, 'running');
    assert.equal(active.recording, 'pending');
    const [restarted] = await listRunRecords(dir, session);
    assert.equal(restarted.status, 'interrupted');
    assert.equal(restarted.recording, 'unavailable');
    assert.match(restarted.error!, /interrupted/);
});

test('older event logs are listed without guessing an engine mapping', async () => {
    const { session, dir } = fixture();
    mkdirSync(dir);
    writeFileSync(join(dir, '1000-old-run.ndjson'), '');
    const [legacy] = await listRunRecords(dir, session);
    assert.equal(legacy.runId, 'old-run');
    assert.equal(legacy.status, 'unknown');
    assert.equal(legacy.engineRunId, undefined);
    assert.equal(legacy.recording, 'unavailable');
    assert.equal(legacy.reportAvailable, false);
    await assert.rejects(recordedReport(dir, session, 'old-run'), /no recording/);
    assert.throws(() => startRecord(dir, 'old-run'), /already been used/);
});

test('unrecorded failures and missing reports remain explicit; corrupt records fail', async () => {
    const { session, dir } = fixture();
    const failed = startRecord(dir, 'failed');
    failed.status = 'error';
    failed.error = 'sandbox is unavailable';
    saveRecord(dir, failed);
    const [summary] = await listRunRecords(dir, session);
    assert.equal(summary.error, failed.error);
    assert.equal(summary.recording, 'unavailable');
    await assert.rejects(recordedReport(dir, session, 'failed'), /unavailable/);
    failed.engineRunId = '20261027-120000-abcd';
    saveRecord(dir, failed);
    const [missing] = await listRunRecords(dir, session);
    assert.equal(missing.recording, 'available');
    assert.equal(missing.reportAvailable, false);
    writeFileSync(
        join(dir, 'failed.json'),
        JSON.stringify({ ...failed, engineRunId: '../outside' }),
    );
    await assert.rejects(listRunRecords(dir, session), /invalid recorded run identity/);
});

test('per-turn counters subtract the prior session without mutating it', () => {
    const { session, dir } = fixture();
    const before = {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 40,
        reasoningTokens: 10,
    };
    const usage = {
        inputTokens: 160,
        cachedInputTokens: 30,
        outputTokens: 65,
        reasoningTokens: 15,
    };
    const call: LlmCallNode = {
        type: 'llm_call',
        id: 'n1',
        ts: new Date().toISOString(),
        agent: 'assistant',
        model: 'test/model',
        requestDigest: 'digest',
        text: { store: 'file', sha256: 'hash', size: 0 },
        toolCalls: [],
        usage,
        stopReason: 'stop',
    };
    const state: AgentState = {
        version: 1,
        runId: 'session-run',
        spec: { startAgent: 'assistant', forkDepth: 0, maxForkDepth: 4 },
        agentName: 'assistant',
        phase: 'done',
        trajectory: [call, { ...call, id: 'n2' }],
        pendingToolCalls: [],
        usage,
    };
    const outcome: RunOutcome = {
        run: runPaths(session, '20261027-120000-abcd'),
        result: { output: 'answer', agent: 'assistant', state, usage, stopReason: 'final' },
        durationMs: 1200,
        text: 'answer',
    };
    const record = startRecord(dir, 'turn');
    recordOutcome(record, outcome, { usage: before, modelCalls: 1, trajectoryLength: 1 });
    assert.deepEqual(record.usage, {
        inputTokens: 60,
        cachedInputTokens: 10,
        outputTokens: 25,
        reasoningTokens: 5,
    });
    assert.equal(record.modelCalls, 1);
    assert.equal(record.sessionModelCalls, 2);
    assert.equal(record.trajectoryStart, 1);
    assert.equal(record.engineRunId, outcome.run.id);
    assert.equal(record.durationMs, 1200);
    assert.equal(before.inputTokens, 100);
});
