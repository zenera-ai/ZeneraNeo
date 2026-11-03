#!/usr/bin/env node
// @ts-check
//
// Report on one run's batch: what each case did, and where its trajectory is.
//
// `index`, `graphs` and `compare` each open by saying which memory the run had -
// NO MEMORY, WITH MEMORY or MEMORY OFF - because the same trajectory means
// opposite things either way.
//
// Run `oom` first, and do not expect `failures` to have caught it: a case whose
// command was killed usually recovers, answers anyway and is recorded `ok`. A
// run can read "16 items, 16 ok, 0 failed" with six of them OOM-killed inside,
// and then nothing it did is evidence about the prompt. See the
// zen-finetune SKILL.md: the fix is half the concurrency, never below 4.
//
// `graphs` saves the most: every case's graph.mmd with its id, verdict and
// rubric above it - one read instead of one `zen inspect graph` per case.
//
// `memory` is what each case did with memory: recalls, searches, commits, and
// how many committed nodes the graph already held. In a with-memory run every
// one of those is a call spent on nothing.
//
// `commits`, `recalls` and `answers` are the reading behind those numbers:
// the nodes each case committed (against the candidate, with re-commits
// marked, when it had memory), every memory step it took, and what it answered.
// They go through `zen memory` and `zen inspect`, never the files on disk.
//
// Run it from anywhere; it finds the project root from its own location.
// See .github/skills/zen-finetune/SKILL.md.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'report.mjs';

const USAGE = `Report on one run's batch: what each case did, and where its trajectory is.

  ${NAME}                    index: ok, agent, stop reason, cost per case
  ${NAME} graphs [id...]     every trajectory graph, with its rubric above it
  ${NAME} paths [id...]      id <TAB> trajectory directory, for zen inspect
  ${NAME} failures           only the cases that did not finish, with errors
  ${NAME} oom                were commands killed - is this run gradeable at all
  ${NAME} memory             per case: recalls, memory searches, commits, already known
  ${NAME} commits [id...]    per case: every node it committed; with memory, against the
                             candidate, re-commits of what it already held marked
  ${NAME} recalls [id...]    per case: every recall and memory tool step, top recalled nodes
  ${NAME} answers [id...]    per case: the final answer, with its rubric above it
  ${NAME} compare            the per-case table findings.md opens with

  -d <dir>    the batch directory; default the newest finetune/runs/*/batch
  -p <dir>    the batch to compare against, for \`compare\`
  -s <file>   the dataset, for rubrics; default finetune/dataset.json`;

process.stdout.on('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPIPE') {
        process.exit(0);
    }
});

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

/** @param {string} msg @param {number} [code] @returns {never} */
function die(msg, code = 2) {
    console.error(`${NAME}: ${msg}`);
    process.exit(code);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const MODES = [
    'index',
    'graphs',
    'paths',
    'failures',
    'oom',
    'memory',
    'commits',
    'recalls',
    'answers',
    'compare',
];

let mode = '';
let batch = '';
let prev = '';
let dataset = 'finetune/dataset.json';
/** @type {string[]} */
const wanted = [];

const argv = process.argv.slice(2);
/** @param {string} flag @returns {string} */
const next = (flag) => {
    const value = argv.shift();
    if (value === undefined) {
        die(`${flag} needs a value`);
    }
    return value;
};

while (argv.length > 0) {
    const arg = /** @type {string} */ (argv.shift());
    if (arg === '-d') {
        batch = next('-d');
    } else if (arg === '-p') {
        prev = next('-p');
    } else if (arg === '-s') {
        dataset = next('-s');
    } else if (arg === '-h' || arg === '--help') {
        console.log(USAGE);
        process.exit(0);
    } else if (MODES.includes(arg)) {
        if (mode) {
            die('one mode at a time');
        }
        mode = arg;
    } else if (arg.startsWith('-')) {
        console.error(`${NAME}: unknown flag ${arg}`);
        console.error(USAGE);
        process.exit(2);
    } else {
        wanted.push(arg);
    }
}

mode ||= 'index';

// Without -d, the batch written most recently - by time, not by name, since
// `run10` sorts before `run2`.
if (!batch) {
    let newest = 0;
    /** @type {string[]} */
    let names = [];
    try {
        names = readdirSync('finetune/runs');
    } catch {
        names = [];
    }
    for (const name of names) {
        const dir = join('finetune/runs', name, 'batch');
        const file = join(dir, 'batch.json');
        if (existsSync(file) && statSync(file).mtimeMs > newest) {
            newest = statSync(file).mtimeMs;
            batch = dir;
        }
    }
}

if (!batch || !existsSync(join(batch, 'batch.json'))) {
    console.error(`${NAME}: no batch.json${batch ? ` in ${batch}` : ''}`);
    console.error('  name one with -d, or run a batch first');
    process.exit(2);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** @param {string} path @returns {any} */
function json(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * `zen <args> --json`, parsed; `{ error }` when it refused.
 *
 * @param {string[]} args
 * @returns {any}
 */
function zen(args) {
    const res = spawnSync('zen', [...args, '--json'], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    if (res.error) {
        die(`cannot run zen: ${res.error.message}`);
    }
    try {
        const out = JSON.parse(res.stdout);
        return res.status === 0 ? out : { error: out?.error ?? `zen exited ${res.status}` };
    } catch {
        const said = `${res.stderr}\n${res.stdout}`.trim().split('\n').at(-1);
        return { error: said || `zen exited ${res.status}` };
    }
}

/** One line, at most `n` long. @param {string} text @param {number} [n] */
function flat(text, n = Infinity) {
    const one = String(text).replace(/\s+/g, ' ').trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

const batchDoc = json(join(batch, 'batch.json'));

/**
 * `{ id, ok }` per case, in batch order, filtered to the ids asked for.
 *
 * @param {string} dir
 * @returns {{ id: string, ok: boolean }[]}
 */
function roster(dir) {
    const doc = dir === batch ? batchDoc : json(join(dir, 'batch.json'));
    /** @type {{ id: string, ok: boolean }[]} */
    const all = (doc?.batch_results ?? []).map((/** @type {any} */ r) => ({
        id: String(r.id),
        ok: r.ok === true,
    }));
    return wanted.length === 0 ? all : all.filter((r) => wanted.includes(r.id));
}

/** @param {string} id */
const output = (id) => json(join(batch, id, 'output.json'));

/**
 * @typedef {{ tokens: number, secs: number, llm: number, tools: number, forks: number,
 *             recalls: number, reads: number, commits: number, known: number }} Metrics
 */

/** @type {Metrics} */
const ZERO = {
    tokens: 0,
    secs: 0,
    llm: 0,
    tools: 0,
    forks: 0,
    recalls: 0,
    reads: 0,
    commits: 0,
    known: 0,
};

/**
 * What one case cost. The counts come from the graph's own header rows -
 *   %% nodes     103 · 33 llm · 30 tool calls · 1 forks
 *   %% tools     run_command x12, memory_search x2, memory_commit x1
 * - because counting state.json nodes over-counts tool calls about threefold.
 * `recalls` are the automatic recall nodes; `known` is read off the commit
 * results, which say "N already known" when the graph held what was committed.
 *
 * @param {string} dir
 * @param {string} id
 * @returns {Metrics}
 */
function metrics(dir, id) {
    const out = json(join(dir, id, 'output.json'));
    if (!out) {
        return { ...ZERO };
    }
    const tokens = (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0);
    const secs = Math.floor((out.durationMs ?? 0) / 1000);
    const graph = out.run?.graph;
    if (!graph || !existsSync(graph)) {
        return { ...ZERO, tokens, secs };
    }
    const lines = readFileSync(graph, 'utf8').split('\n');
    const row = lines.find((line) => /^%% nodes\s/.test(line));
    const parts = (row ?? '').replace(/^%% nodes\s+/, '').split(' · ');
    const n = (/** @type {number} */ i) => Number.parseInt(parts[i] ?? '', 10) || 0;
    /** @type {Map<string, number>} */
    const used = new Map();
    for (const m of (lines.find((line) => /^%% tools\s/.test(line)) ?? '').matchAll(
        /([\w.-]+) x(\d+)/g,
    )) {
        used.set(m[1], Number(m[2]));
    }
    const tool = (/** @type {string} */ name) => used.get(name) ?? 0;
    let known = 0;
    for (const line of lines) {
        if (line.includes('memory_commit =')) {
            known += Number(/(\d+) already known/.exec(line)?.[1] ?? 0);
        }
    }
    return {
        tokens,
        secs,
        llm: n(1),
        tools: n(2),
        forks: n(3),
        recalls: lines.filter((line) => /\brecall \d+ nodes\b/.test(line)).length,
        reads: tool('memory_search') + tool('memory_grep') + tool('memory_load'),
        commits: tool('memory_commit'),
        known,
    };
}

/** 1.09M, 812k, 94. @param {number} n */
function hum(n) {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(2)}M`;
    }
    if (n >= 1000) {
        return `${Math.trunc(n / 1000)}k`;
    }
    return String(n);
}

/**
 * "33 → 30 (−3)" against a previous run, "33" without one. Tokens and seconds
 * move continuously and read as a percentage; calls and forks read as a count.
 *
 * @param {number} was
 * @param {number} now
 * @param {'tok' | 'sec' | 'num'} kind
 * @returns {string}
 */
function cell(was, now, kind) {
    const show = (/** @type {number} */ v) =>
        kind === 'tok' ? hum(v) : kind === 'sec' ? `${v}s` : String(v);
    if (!prev) {
        return show(now);
    }
    const delta = now - was;
    const size = Math.abs(delta);
    const sign = delta >= 0 ? '+' : '−';
    if (size === 0) {
        return `${show(now)} (=)`;
    }
    if (kind === 'num') {
        return `${show(was)} → ${show(now)} (${sign}${size})`;
    }
    if (was > 0) {
        return `${show(was)} → ${show(now)} (${sign}${((size * 100) / was).toFixed(0)}%)`;
    }
    return `${show(was)} → ${show(now)}`;
}

/**
 * The memory a batch started from, where it is now: `memory.mjs checkpoint`
 * renames `candidate-batchNN` to `after-batchNN` once the batch passes.
 *
 * @param {string} source
 */
function startedFrom(source) {
    const kept = source.replace(/candidate-(batch\d+)\/?$/, 'after-$1');
    return source && !existsSync(source) && existsSync(kept) ? kept : source;
}

/**
 * `memory off` / `no memory` / `with memory`, for a batch directory.
 *
 * batch.json records `--memory finetune/empty` as mode `copied`, exactly like
 * a with-memory run. What differs is whether the source held a graph.
 *
 * @param {string} dir
 * @returns {{ kind: string, line: string }}
 */
function memory(dir) {
    const mem = json(join(dir, 'batch.json'))?.batch?.memory ?? {};
    const mode = mem.mode ?? 'none';
    const source = startedFrom(mem.source ?? '');
    if (mode === 'none') {
        return {
            kind: 'memory off',
            line: 'MEMORY OFF — no memory was given to this batch, and none was written',
        };
    }
    if (mode === 'read-only') {
        return {
            kind: 'with memory',
            line: `WITH MEMORY — one shared graph, read-only, every case read it and none wrote (${source})`,
        };
    }
    if (mode === 'copied') {
        return source && existsSync(join(source, 'memory.db'))
            ? {
                  kind: 'with memory',
                  line: `WITH MEMORY — each case got its own copy of an existing graph (${source})`,
              }
            : {
                  kind: 'no memory',
                  line: `NO MEMORY — every case started from an empty graph and wrote its own (${source || 'none'})`,
              };
    }
    return { kind: mode, line: `${mode}${source ? ` (${source})` : ''}` };
}

const datasetDoc = json(dataset);

/**
 * The rubric from the dataset, joined on the id; empty when there is none.
 *
 * @param {string} id
 * @returns {string[]}
 */
function rubric(id) {
    const all = datasetDoc?.cases ?? datasetDoc?.samples ?? [];
    const found = all.find((/** @type {any} */ c) => c.id === id);
    return (found?.rubric ?? []).map((/** @type {string} */ line) => `  - ${line}`);
}

/** @param {(string | number)[]} cells @param {number[]} widths */
const row = (cells, widths) =>
    cells
        .map((c, i) =>
            widths[i] < 0 ? String(c).padStart(-widths[i]) : String(c).padEnd(widths[i]),
        )
        .join(' ')
        .replace(/ +$/, '');

const say = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);

// ---------------------------------------------------------------------------
// The modes
// ---------------------------------------------------------------------------

if (mode === 'index') {
    const b = batchDoc?.batch ?? {};
    say(
        `batch  ${b.items} items, ${b.ok} ok, ${b.failed} failed` +
            `  ·  ${Math.floor((b.durationMs ?? 0) / 1000)}s`,
    );
    say(`dir    ${batch}`);
    say(`memory ${memory(batch).line}`);
    say('');
    const widths = [24, 5, 12, 12, -7, -5, -6];
    say(row(['ID', 'OK', 'AGENT', 'STOP', 'TOKENS', 'SEC', 'RUBRIC'], widths));
    for (const { id, ok } of roster(batch)) {
        const out = output(id);
        const lines = rubric(id).length;
        say(
            row(
                [
                    id,
                    String(ok),
                    out?.agent || '-',
                    out?.stopReason || '-',
                    out ? (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0) : '-',
                    out ? Math.floor((out.durationMs ?? 0) / 1000) : '-',
                    lines === 0 ? '-' : lines,
                ],
                widths,
            ),
        );
    }
    say('');
    say(`next: ${NAME} -d ${batch} graphs | less`);
} else if (mode === 'graphs') {
    say(`== memory: ${memory(batch).line}`);
    for (const { id, ok } of roster(batch)) {
        const out = output(id);
        say('================================================================');
        say(`== ${id}   ok=${ok}`);
        const lines = rubric(id);
        if (lines.length > 0) {
            say('== rubric:');
            for (const line of lines) {
                say(`== ${line}`);
            }
        }
        say('================================================================');
        const graph = out?.run?.graph;
        if (graph && existsSync(graph)) {
            process.stdout.write(readFileSync(graph, 'utf8'));
        } else if (out) {
            say(out.error?.message ?? 'no graph was written');
        } else {
            say('no output.json');
        }
        say('');
    }
} else if (mode === 'paths') {
    for (const { id } of roster(batch)) {
        say(`${id}\t${output(id)?.run?.dir || '-'}`);
    }
} else if (mode === 'failures') {
    const items = roster(batch);
    if (items.every((r) => r.ok)) {
        say('nothing failed');
        process.exit(0);
    }
    for (const { id, ok } of items) {
        if (ok) {
            continue;
        }
        say(`-- ${id}`);
        const out = output(id);
        if (out) {
            say(`   ${out.error?.message ?? 'unknown'}`);
            if (out.error?.hint) {
                say(`   hint: ${out.error.hint}`);
            }
        }
    }
} else if (mode === 'compare') {
    if (prev && !existsSync(join(prev, 'batch.json'))) {
        die(`no batch.json in ${prev}`);
    }

    // Part of the table, not a footnote: a pasted table loses what follows it.
    say(`memory: ${memory(batch).line}`);
    if (prev) {
        say(`prev memory: ${memory(prev).line}`);
    }
    say('');
    say(
        '| case | verdict | tokens | llm calls | tool calls | forks | memory reads | commits (known) | time |',
    );
    say('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

    const sum = { ...ZERO };
    const was = { ...ZERO };
    /** @param {number} c @param {number} k */
    const commits = (c, k) => (k > 0 ? `${c} (${k} known)` : String(c));
    for (const { id, ok } of roster(batch)) {
        const now = metrics(batch, id);
        const before = prev ? metrics(prev, id) : { ...ZERO };
        for (const k of /** @type {(keyof Metrics)[]} */ (Object.keys(ZERO))) {
            sum[k] += now[k];
            was[k] += before[k];
        }
        // The verdict is the grader's: no script can read it off a trajectory.
        say(
            `| ${id} | ${ok ? '?' : '**did not finish**'} ` +
                `| ${cell(before.tokens, now.tokens, 'tok')} ` +
                `| ${cell(before.llm, now.llm, 'num')} ` +
                `| ${cell(before.tools, now.tools, 'num')} ` +
                `| ${cell(before.forks, now.forks, 'num')} ` +
                `| ${cell(before.recalls + before.reads, now.recalls + now.reads, 'num')} ` +
                `| ${prev ? `${commits(before.commits, before.known)} → ` : ''}${commits(now.commits, now.known)} ` +
                `| ${cell(before.secs, now.secs, 'sec')} |`,
        );
    }

    say(
        `| **total** | — ` +
            `| **${cell(was.tokens, sum.tokens, 'tok')}** ` +
            `| **${cell(was.llm, sum.llm, 'num')}** ` +
            `| **${cell(was.tools, sum.tools, 'num')}** ` +
            `| **${cell(was.forks, sum.forks, 'num')}** ` +
            `| **${cell(was.recalls + was.reads, sum.recalls + sum.reads, 'num')}** ` +
            `| **${prev ? `${commits(was.commits, was.known)} → ` : ''}${commits(sum.commits, sum.known)}** ` +
            `| **${cell(was.secs, sum.secs, 'sec')}** |`,
    );

    say('');
    say(`this  ${batch}`);
    if (prev) {
        say(`prev  ${prev}`);
    }
    say('note: wall time is concurrent — the totals are machine load, not a sum anybody waited.');
    const a = memory(batch).kind;
    const b = prev ? memory(prev).kind : a;
    if (a !== b) {
        say('');
        say(`note: these two runs did not have the same memory (${b} → ${a}).`);
        say('  A with-memory run against the no-memory run that passed the same batch is');
        say('  the measurement of what memory saves, and reads as one; otherwise the wrong');
        say('  -p was given, or the numbers will be read as the effect of an instruction');
        say('  that did nothing.');
    }
} else if (mode === 'memory') {
    // What each case did with memory. With memory, a read that found nothing
    // and a commit of something the graph already held are both wasted calls.
    say(`memory ${memory(batch).line}`);
    say('');
    const widths = [32, -8, -6, -8, -6];
    say(row(['CASE', 'RECALLS', 'READS', 'COMMITS', 'KNOWN'], widths));
    const sum = { ...ZERO };
    for (const { id } of roster(batch)) {
        const m = metrics(batch, id);
        for (const k of /** @type {(keyof Metrics)[]} */ (Object.keys(ZERO))) {
            sum[k] += m[k];
        }
        say(row([id, m.recalls, m.reads, m.commits, m.known], widths));
    }
    say(row(['total', sum.recalls, sum.reads, sum.commits, sum.known], widths));
    say('');
    say('recalls  automatic recall nodes - what memory put in front of the model');
    say('reads    memory_search + memory_grep + memory_load calls');
    say('commits  memory_commit calls');
    say('known    committed nodes the graph already held, as the commit results report them');
    if (memory(batch).kind === 'with memory' && sum.known > 0) {
        say('');
        say(`${sum.known} committed node(s) were already known: a call spent re-saying what`);
        say('the graph held. Find the commit nodes and ask why it did not check first.');
    }
} else if (mode === 'commits') {
    // Without memory a case starts empty, so everything in its graph it committed.
    // With memory its graph is the candidate plus its commits: diff against it.
    const mem = memory(batch);
    const against =
        mem.kind === 'with memory' ? startedFrom(batchDoc?.batch?.memory?.source ?? '') : '';
    say(`memory ${mem.line}`);
    let added = 0;
    let twins = 0;
    for (const { id } of roster(batch)) {
        const dir = join(batch, id, 'memory');
        say('');
        if (!existsSync(join(dir, 'memory.db'))) {
            say(`-- ${id}   committed nothing`);
            continue;
        }
        const out = against
            ? zen(['memory', 'diff', against, '--dir', dir])
            : zen(['memory', 'ls', '--dir', dir, '--limit', '100000']);
        if (out?.error) {
            say(`-- ${id}   ${out.error}`);
            continue;
        }
        /** @type {{ node: any, nearest?: { id: string, score: number }, twin?: boolean }[]} */
        const rows = against ? out.added : out.nodes.map((/** @type {any} */ node) => ({ node }));
        const held = rows.filter((r) => r.twin).length;
        added += rows.length;
        twins += held;
        const extra = against
            ? [
                  held ? `${held} already held` : '',
                  out.revised.length ? `${out.revised.length} revised` : '',
                  out.used.length ? `${out.used.length} loaded` : '',
              ].filter(Boolean)
            : [];
        say(`-- ${id}   ${rows.length} committed${extra.length ? `, ${extra.join(', ')}` : ''}`);
        for (const { node, nearest, twin } of rows) {
            const near = nearest
                ? `  ${twin ? 'ALREADY HELD as' : 'nearest'} ${nearest.id} ${nearest.score.toFixed(2)}`
                : '';
            const file = node.file ? `  file .${node.file.format}` : '';
            say(`   ${node.id}  ${node.kind}  ${node.audience.join(',')}${file}${near}`);
            say(`      ${flat(node.text)}`);
        }
        for (const { before, after } of against ? out.revised : []) {
            say(`   ${after.id}  ${after.kind}  revised r${before.revision} -> r${after.revision}`);
            say(`      ${flat(after.text)}`);
        }
        for (const { node, loads } of against ? out.used : []) {
            say(`   ${node.id}  ${node.kind}  loaded ${loads}x`);
            say(`      ${flat(node.text)}`);
        }
    }
    say('');
    say(`total  ${added} committed${against ? `, ${twins} already held` : ''}`);
    if (against) {
        say(`against ${against}`);
        if (twins > 0) {
            say('');
            say(`${twins} commit(s) said again what the candidate held: merge folds them,`);
            say('so each was a call that bought nothing. Ask at the commit why it did not');
            say('recall first.');
        }
    }
    say('');
    say(`one node in full: zen memory show <node-id> --dir ${join(batch, '<case>', 'memory')}`);
} else if (mode === 'recalls') {
    say(`memory ${memory(batch).line}`);
    const STEP =
        /^\s*(n\d+)\S*"n\d+ ((?:recall \d+ nodes|memory_(?:search|grep|load|commit)) .*?)(?: · t\+|")/;
    for (const { id } of roster(batch)) {
        const out = output(id);
        const graph = out?.run?.graph;
        say('');
        if (!graph || !existsSync(graph)) {
            say(`-- ${id}   no graph`);
            continue;
        }
        /** @type {{ node: string, label: string }[]} */
        const steps = [];
        for (const line of readFileSync(graph, 'utf8').split('\n')) {
            const m = STEP.exec(line);
            if (m) {
                steps.push({ node: m[1], label: m[2] });
            }
        }
        if (steps.length === 0) {
            say(`-- ${id}   never touched memory`);
            continue;
        }
        const recalls = steps.filter((s) => s.label.startsWith('recall '));
        /** @type {Map<string, string[]>} */
        const seeds = new Map();
        if (recalls.length > 0) {
            const res = zen([
                'inspect',
                'node',
                ...recalls.map((r) => r.node),
                '--dir',
                out.run.dir,
            ]);
            for (const n of res?.nodes ?? []) {
                const text = n.parts?.find((/** @type {any} */ p) => p.name === 'recalled')?.text;
                const top = [
                    ...String(text ?? '').matchAll(/^(\d\.\d\d) +(\S+) +(\S+)\n +(.+)$/gm),
                ];
                seeds.set(
                    n.id,
                    top.slice(0, 3).map((m) => `${m[1]} ${m[2]} ${m[3]}  ${flat(m[4], 90)}`),
                );
            }
        }
        const calls = steps.filter(
            (s) => !s.label.startsWith('recall ') && !s.label.includes(' = '),
        );
        say(`-- ${id}   ${recalls.length} recalls, ${calls.length} memory tool calls`);
        for (const s of steps) {
            say(`   ${s.node.padEnd(5)} ${flat(s.label, 120)}`);
            for (const line of seeds.get(s.node) ?? []) {
                say(`         ${line}`);
            }
        }
    }
    say('');
    say(
        `one step in full: zen inspect node <nN> --dir "$(${NAME} -d ${batch} paths <case> | cut -f2)"`,
    );
} else if (mode === 'answers') {
    for (const { id, ok } of roster(batch)) {
        const out = output(id);
        say('================================================================');
        say(`== ${id}   ok=${ok}`);
        const lines = rubric(id);
        if (lines.length > 0) {
            say('== rubric:');
            for (const line of lines) {
                say(`== ${line}`);
            }
        }
        say('================================================================');
        if (!out) {
            say('no output.json');
        } else if (out.ok === false) {
            say(`did not finish: ${out.error?.message ?? 'unknown'}`);
        } else {
            say(String(out.output ?? '').trim() || '(no answer)');
        }
        say('');
    }
} else if (mode === 'oom') {
    // The graph is where an exit code survives: a killed `run_command` reads
    // `= exit code 137`. Never grep the batch directory - a workspace is full of
    // data files with 137 in them.
    /** @type {{ id: string, killed: number, timedout: number }[]} */
    const scan = [];
    for (const { id } of roster(batch)) {
        const graph = output(id)?.run?.graph;
        if (!graph || !existsSync(graph)) {
            continue;
        }
        const lines = readFileSync(graph, 'utf8').split('\n');
        const killed = lines.filter((l) => l.includes('exit code 137')).length;
        const timedout = lines.filter((l) => l.includes('exit code 124')).length;
        if (killed > 0 || timedout > 0) {
            scan.push({ id, killed, timedout });
        }
    }

    if (scan.length === 0) {
        say('no killed commands in this run — it is gradeable');
        process.exit(0);
    }

    const widths = [32, -8, -8];
    say(row(['CASE', 'OOM 137', 'TIME 124'], widths));
    for (const { id, killed, timedout } of scan) {
        say(row([id, killed, timedout], widths));
    }
    say('');

    const casesKilled = scan.filter((s) => s.killed > 0).length;
    const totalKilled = scan.reduce((n, s) => n + s.killed, 0);
    const totalTimedout = scan.reduce((n, s) => n + s.timedout, 0);
    const config = json('finetune/config.json') ?? {};
    const current = Number(config.concurrency) || 16;
    const halved = Math.max(4, Math.floor(current / 2));

    if (casesKilled > 0) {
        say(`${totalKilled} command(s) across ${casesKilled} case(s) were OOM-killed.`);
        say('');
        say('THIS RUN IS VOID, NOT GRADED.');
        say('  Nothing here is evidence about the prompt. Do not grade it, do not');
        say('  change instructions on it, and do not compare its tokens to another');
        say('  run.');
        say('');
        if (current <= 4) {
            say(`  It ran at concurrency ${current}, the floor. The machine cannot run this`);
            say('  batch: stop and tell the user.');
        } else {
            say(`  Halve the concurrency and run the same cases again: set`);
            say(
                `  "concurrency": ${halved} in finetune/config.json (was ${current}; never below 4).`,
            );
        }
        process.exit(1);
    }

    say(`${totalTimedout} command(s) hit the timeout; none was OOM-killed.`);
    say('  Under memory pressure 124 is 137 wearing a different number, and raising');
    say('  the timeout converts one into the other rather than fixing either. If it');
    say(
        `  repeats in the next run, halve the concurrency: ${current} -> ${halved} (never below 4).`,
    );
}
