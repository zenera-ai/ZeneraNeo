import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createSessionAt,
    describeIssue,
    EngineError,
    EXIT,
    readSessionMeta,
    sessionPaths,
    sessionPathsAt,
    usageError,
    type ModelIssue,
} from '../src/index.ts';

const dirs: string[] = [];
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-engine-'));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sessions at any directory', () => {
    it('lays a session out under the directory and names it after it', () => {
        const p = sessionPathsAt('/data/users/u1/sessions/3f0c-thread');
        expect(p.id).toBe('3f0c-thread');
        expect(p.dir).toBe('/data/users/u1/sessions/3f0c-thread');
        expect(p.state).toBe('/data/users/u1/sessions/3f0c-thread/.data/state.json');
        expect(p.lock).toBe('/data/users/u1/sessions/3f0c-thread/.lock');
    });

    it('creates one that reads back with its workspace', async () => {
        const root = scratch();
        const dir = join(root, 'sessions', 'not-a-stamp');
        const p = createSessionAt(dir, join(root, 'ws'));
        expect(existsSync(p.runs)).toBe(true);
        expect(existsSync(join(root, 'ws'))).toBe(true);
        const meta = await readSessionMeta(p);
        expect(meta.id).toBe('not-a-stamp');
        expect(meta.workspace).toBe(join(root, 'ws'));
    });

    it('still refuses a non-stamp id inside a project', () => {
        expect(() => sessionPaths(scratch(), 'thread-1')).toThrow(EngineError);
        try {
            sessionPaths(scratch(), 'thread-1');
        } catch (err) {
            expect((err as EngineError).code).toBe(EXIT.usage);
        }
    });
});

describe('errors and issues', () => {
    it('carries the code a host maps to an exit or HTTP status', () => {
        const err = usageError('bad', 'try again');
        expect(err).toBeInstanceOf(EngineError);
        expect(err.code).toBe(EXIT.usage);
        expect(err.hint).toBe('try again');
    });

    // A package installed apart from `zen` throws from its own copy of this module.
    it('is recognised when thrown by another copy of the engine', () => {
        const elsewhere = Object.defineProperty(
            new Error('bad'),
            Symbol.for('zenera.EngineError'),
            {
                value: true,
            },
        );
        expect(elsewhere).toBeInstanceOf(EngineError);
        expect(new Error('bad')).not.toBeInstanceOf(EngineError);
    });

    it('still checks a subclass by its prototype', () => {
        class Narrower extends EngineError {}
        expect(new Narrower('bad')).toBeInstanceOf(Narrower);
        expect(new Narrower('bad')).toBeInstanceOf(EngineError);
        expect(usageError('bad')).not.toBeInstanceOf(Narrower);
    });

    it('describes an issue in plain text unless the host styles it', () => {
        const issue: ModelIssue = {
            name: 'main',
            role: 'model',
            provider: 'openai',
            env: 'OPENAI_API_KEY',
            reason: 'missing',
            add: 'openai',
        };
        expect(describeIssue(issue)).toBe(
            'main (openai) has no credential — OPENAI_API_KEY is not set; zen key add openai',
        );
        const styled = describeIssue(issue, { bold: (s) => `*${s}*`, dim: (s) => `_${s}_` });
        expect(styled).toContain('*main*');
        expect(styled).toContain('_zen key add openai_');
    });
});
