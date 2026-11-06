import { EventType, type AGUIEvent } from '@ag-ui/core';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { compact, readRunLog, RunLog, threadRunLogs } from '../src/runLog.ts';

const started: AGUIEvent = { type: EventType.RUN_STARTED, threadId: 't', runId: 'r1' };
const text = (delta: string, messageId = 'm1'): AGUIEvent => ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta,
});
const finished: AGUIEvent = { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r1' };
const deltas = (events: AGUIEvent[]) =>
    events.flatMap((e) => ('delta' in e ? [String(e.delta)] : []));

function follower() {
    const seen: AGUIEvent[] = [];
    const f = {
        ended: false,
        events: (batch: AGUIEvent[]) => void seen.push(...batch),
        end: () => void (f.ended = true),
    };
    return { f, seen };
}

test('compact merges each stream into its first delta, in place', () => {
    const out = compact([
        started,
        text('Hel'),
        text('Wor', 'm2'),
        text('lo'),
        text('ld', 'm2'),
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{"a"' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: ':1}' },
        finished,
    ]);
    assert.deepEqual(deltas(out), ['Hello', 'World', '{"a":1}']);
    assert.equal(out.length, 5);
});

test('a follower gets the run so far, then live events, then the end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runlog-'));
    const log = RunLog.open(dir, 'r1', 1 << 20);
    log.append([started, text('a'), text('b')]);
    const { f, seen } = follower();
    const unfollow = log.follow(f);
    assert.deepEqual(deltas(seen), ['ab']);
    log.append([text('c')]);
    assert.deepEqual(deltas(seen), ['ab', 'c']);
    unfollow();
    log.append([text('d'), finished]);
    assert.equal(seen.length, 3);

    const late = follower();
    log.follow(late.f);
    assert.deepEqual(deltas(late.seen), ['abcd']);
    assert.equal(late.f.ended, false);

    await log.end();
    assert.equal(late.f.ended, true);
    const after = follower();
    log.follow(after.f);
    assert.equal(after.f.ended, true);
});

test('an ended log is compacted on disk and listed in start order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runlog-'));
    const first = RunLog.open(dir, 'r1', 1 << 20);
    first.append([started, text('x'), text('y'), finished]);
    await first.end();
    await new Promise((r) => setTimeout(r, 5));
    const second = RunLog.open(dir, 'r2', 1 << 20);
    await second.end();

    assert.equal(readFileSync(first.file, 'utf8').trim().split('\n').length, 3);
    assert.deepEqual(
        (await threadRunLogs(dir)).map((l) => l.runId),
        ['r1', 'r2'],
    );
    assert.deepEqual(await threadRunLogs(join(dir, 'none')), []);
});

test('a log without an end reads as interrupted, a torn last line is skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runlog-'));
    const file = join(dir, '1-r1.ndjson');
    writeFileSync(file, `${JSON.stringify(started)}\n${JSON.stringify(text('a'))}\n{"type":"TE`);
    const events = await readRunLog(file);
    assert.equal(events.length, 3);
    assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
    assert.equal((events.at(-1) as { code?: string }).code, 'interrupted');
});

test('past the size cap deltas are dropped, the rest is kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runlog-'));
    const log = RunLog.open(dir, 'r1', 300);
    log.append([started, text('x'.repeat(150)), text('y'), finished]);
    await log.end();
    const events = await readRunLog(log.file);
    assert.deepEqual(
        events.map((e) => e.type),
        [EventType.RUN_STARTED, EventType.TEXT_MESSAGE_CONTENT, EventType.RUN_FINISHED],
    );
    assert.deepEqual(deltas(events), ['x'.repeat(150)]);
});
