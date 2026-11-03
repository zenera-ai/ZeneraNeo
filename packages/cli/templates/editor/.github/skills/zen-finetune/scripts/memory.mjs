#!/usr/bin/env node
// @ts-check
//
// Keep the memory the with-memory runs read: the candidate for the batch being
// tuned, and the last good memory every passed batch has added to.
//
// A batch's no-memory runs each start from an empty graph, and every case writes
// its own. When one of them passes, `candidate <run>` copies the last good
// memory into a NEW directory and folds what each of that run's cases committed
// into it with `zen memory merge`, which drops what the graph already held. That
// is the candidate: the memory the batch's with-memory runs start from, every
// case from its own copy, so nothing a case commits reaches the candidate or
// another case.
//
// When a with-memory run passes, `checkpoint <run>` makes the candidate the last
// good memory: it renames the directory and only then repoints
// finetune/memory/last-good.json at it. A merge killed half-way leaves the
// candidate it was writing without that merge, and never touches the one the
// pointer names. Stop the
// tuning at any moment and `memory.mjs path` still names a usable graph.
//
// Needs `zen` on PATH. Run it from anywhere; it finds the project root from its
// own location. See .github/skills/zen-finetune/SKILL.md, "The memory".

import { spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const NAME = 'memory.mjs';

const USAGE = `Keep the candidate memory of the batch being tuned, and the last good memory.

  ${NAME}                         the last good memory and the candidate, and what built them
  ${NAME} path                    the last good memory's directory
  ${NAME} path --candidate        the candidate's directory, for --memory "$(...)"
  ${NAME} candidate <run>         a PASSED no-memory run: last good + what its cases committed
  ${NAME} checkpoint <run>        a PASSED with-memory run: its candidate becomes last good

  <run> is a run directory name, e.g. batch03-nomem-run2 or batch03-mem-run1`;

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

const ROOT = 'finetune/memory';
const POINTER = `${ROOT}/last-good.json`;
const CANDIDATE = `${ROOT}/candidate.json`;
const RUNS = 'finetune/runs';
const RUN_NAME = /^batch(\d{2})-(nomem|mem)-run(\d+)$/;
// Older graphs are kept to roll back to; beyond this many they are only disk.
const KEEP = 3;

/** @param {string} msg @param {number} [code] @returns {never} */
function die(msg, code = 2) {
    console.error(`${NAME}: ${msg}`);
    process.exit(code);
}

/** @param {string} path @returns {any} */
function json(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

/** @param {string} path @param {unknown} value */
function writeAtomic(path, value) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path);
}

/** @param {string} dir @returns {number} */
function nodesIn(dir) {
    if (!existsSync(join(dir, 'memory.db'))) {
        return 0;
    }
    const db = new DatabaseSync(join(dir, 'memory.db'), { readOnly: true });
    try {
        return Number(db.prepare('SELECT count(*) AS n FROM nodes').get()?.n) || 0;
    } finally {
        db.close();
    }
}

/** @param {string} run */
function passed(run) {
    const path = join(RUNS, run, 'findings.md');
    return existsSync(path) && /^## PASSED/m.test(readFileSync(path, 'utf8'));
}

/**
 * @typedef {{ dir: string, batches: number[], runs: string[], nodes: number, at: string }} Pointer
 * @typedef {{ dir: string, batch: number, from: string, nodes: number, at: string }} Candidate
 */

/** @type {Pointer | undefined} */
const pointer = json(POINTER);
/** @type {Candidate | undefined} */
const candidate = json(CANDIDATE);

const [command = 'status', arg] = process.argv.slice(2);

if (command === '-h' || command === '--help') {
    console.log(USAGE);
    process.exit(0);
}

if (command === 'path') {
    if (arg === '--candidate') {
        if (!candidate) {
            die(
                'no candidate - build one from a PASSED no-memory run: memory.mjs candidate <run>',
                1,
            );
        }
        console.log(candidate.dir);
        process.exit(0);
    }
    if (arg !== undefined) {
        die(`unknown argument ${arg}`);
    }
    if (!pointer) {
        die('no last good memory yet - checkpoint a PASSED with-memory run first', 1);
    }
    console.log(pointer.dir);
    process.exit(0);
}

if (command === 'status') {
    if (pointer) {
        console.log(`last good   ${pointer.dir}`);
        console.log(`nodes       ${pointer.nodes}`);
        console.log(`updated     ${pointer.at}`);
        console.log(`batches     ${pointer.batches.join(', ')}`);
        console.log(`built from  ${pointer.runs.join(' ')}`);
    } else {
        console.log('no last good memory yet');
    }
    console.log('');
    if (candidate) {
        console.log(`candidate   ${candidate.dir}`);
        console.log(`batch       ${candidate.batch}, from ${candidate.from}`);
        console.log(`nodes       ${candidate.nodes}`);
    } else {
        console.log('no candidate');
    }
    process.exit(0);
}

if (command !== 'candidate' && command !== 'checkpoint') {
    console.error(`${NAME}: unknown command ${command}`);
    console.error(USAGE);
    process.exit(2);
}

const m = RUN_NAME.exec(arg ?? '');
if (!arg || !m) {
    die(`${command} needs a run, e.g. batch03-${command === 'candidate' ? 'nomem' : 'mem'}-run2`);
}
const batch = +m[1];
const pad = String(batch).padStart(2, '0');

// ---------------------------------------------------------------------------
// candidate
// ---------------------------------------------------------------------------

if (command === 'candidate') {
    if (m[2] !== 'nomem') {
        die(
            'a candidate is built from a no-memory run: a with-memory run holds the whole graph again in every case',
        );
    }
    if (!passed(arg)) {
        die(`${arg} does not say PASSED - only a passing run's memory is kept`);
    }
    if (pointer?.batches.includes(batch)) {
        die(`batch ${batch} is already in the last good memory`);
    }

    // Only case memories with a database: a case that committed nothing has none.
    const dir = join(RUNS, arg, 'batch');
    const sources = (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
        .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'memory', 'memory.db')))
        .map((e) => join(dir, e.name, 'memory'));

    const target = join(ROOT, `candidate-batch${pad}`);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    if (pointer && existsSync(pointer.dir)) {
        cpSync(pointer.dir, target, {
            recursive: true,
            filter: (src) => !/\/(\.lock|memory\.db-(wal|shm))$/.test(src),
        });
    } else {
        mkdirSync(target, { recursive: true });
    }

    if (sources.length > 0) {
        const merged = spawnSync('zen', ['memory', 'merge', ...sources, '--dir', target, '--yes'], {
            stdio: 'inherit',
        });
        if (merged.error) {
            rmSync(target, { recursive: true, force: true });
            die(`could not run zen: ${merged.error.message}`);
        }
        if (merged.status !== 0) {
            rmSync(target, { recursive: true, force: true });
            die('zen memory merge failed - no candidate was written', 1);
        }
    }

    /** @type {Candidate} */
    const next = {
        dir: target,
        batch,
        from: arg,
        nodes: nodesIn(target),
        at: new Date().toISOString(),
    };
    writeAtomic(CANDIDATE, next);
    const before = pointer ? nodesIn(pointer.dir) : 0;
    console.error(
        `${NAME}: candidate for batch ${batch} is ${target} - ${next.nodes} nodes ` +
            `(${before} from the last good memory, ${sources.length} case memor${sources.length === 1 ? 'y' : 'ies'} from ${arg})`,
    );
    if (next.nodes === 0) {
        console.error(
            `${NAME}: the candidate is EMPTY - nothing was ever committed, so a with-memory run ` +
                'measures nothing. That is a commit-policy finding for the no-memory runs.',
        );
    }
    process.exit(0);
}

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

if (m[2] !== 'mem') {
    die('checkpoint takes a PASSED with-memory run; a no-memory run builds a candidate first');
}
if (!passed(arg)) {
    die(
        `${arg} does not say PASSED - the candidate is kept only once its batch passes with memory`,
    );
}
if (pointer?.batches.includes(batch)) {
    console.error(`${NAME}: batch ${batch} is already in the last good memory`);
    process.exit(0);
}
if (!candidate || candidate.batch !== batch) {
    die(`no candidate for batch ${batch} - memory.mjs candidate batch${pad}-nomem-run<N>`);
}

const target = join(ROOT, `after-batch${pad}`);
if (existsSync(candidate.dir)) {
    rmSync(target, { recursive: true, force: true });
    renameSync(candidate.dir, target);
} else if (!existsSync(target)) {
    die(`the candidate ${candidate.dir} is gone - build it again from ${candidate.from}`);
}
// A checkpoint killed after the rename resumes here: the directory is already in place.

/** @type {Pointer} */
const next = {
    dir: target,
    batches: [...(pointer?.batches ?? []), batch],
    runs: [...(pointer?.runs ?? []), candidate.from, arg],
    nodes: nodesIn(target),
    at: new Date().toISOString(),
};
writeAtomic(POINTER, next);
rmSync(CANDIDATE, { force: true });

const history = next.batches.map((b) => join(ROOT, `after-batch${String(b).padStart(2, '0')}`));
for (const dir of history.slice(0, -KEEP)) {
    rmSync(dir, { recursive: true, force: true });
}

console.error(
    `${NAME}: last good memory is now ${target} - ${next.nodes} nodes, batches ${next.batches.join(', ')}`,
);
