#!/usr/bin/env node
// Run the offline vitest suite many times under one condition and record every failure.
//
// Usage, from the repository root after `npm ci && npm run build`:
//   node reports/flaky-tests/flaky.mjs --label baseline --runs 20 [--tz UTC]
//        [--set NAME=VALUE ...] [--shuffle] [--home temp|keep] [--load N] [--out DIR]
// Results go to DIR/<label>/ (default .out/flaky, git-ignored): one vitest JSON
// report per run and a summary.json that summarize.mjs turns into a table.
//
// POSIX only (macOS, Linux). Each run gets a scrubbed environment: only PATH, HOME, TMPDIR, TZ and LANG, plus
// whatever --set adds. No provider keys and no agent markers leak in from the shell.
// Use fake values with --set: only the names are kept, but the run itself sees them.
// --home temp (default) gives every run a fresh empty HOME; --home keep reuses one HOME
// across the runs of this condition, so state left by run N is visible to run N+1.
// --load N keeps N extra CPU cores busy for the whole condition.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, loadavg, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const SLOWEST_KEPT = 5;

function parseArgs(argv) {
    const opts = {
        label: 'run',
        runs: 10,
        tz: 'UTC',
        set: [],
        shuffle: false,
        home: 'temp',
        out: '.out/flaky',
        load: 0,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === '--label') opts.label = next();
        else if (a === '--runs') opts.runs = Number(next());
        else if (a === '--tz') opts.tz = next();
        else if (a === '--set') opts.set.push(next());
        else if (a === '--shuffle') opts.shuffle = true;
        else if (a === '--home') opts.home = next();
        else if (a === '--out') opts.out = next();
        else if (a === '--load') opts.load = Number(next());
        else throw new Error(`unknown option ${a}`);
    }
    const maxLoad = availableParallelism() * 2;
    if (!Number.isInteger(opts.load) || opts.load < 0 || opts.load > maxLoad) {
        throw new Error(`--load must be between 0 and ${maxLoad}`);
    }
    if (!/^[\w.-]+$/.test(opts.label)) throw new Error('--label may use letters, digits, . _ -');
    if (!Number.isInteger(opts.runs) || opts.runs < 1)
        throw new Error('--runs must be a positive integer');
    if (!['temp', 'keep'].includes(opts.home)) throw new Error('--home must be temp or keep');
    opts.extra = opts.set.map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 1) throw new Error(`--set expects NAME=VALUE, got ${pair}`);
        return [pair.slice(0, eq), pair.slice(eq + 1)];
    });
    return opts;
}

function baseEnv(home, tz, extra) {
    return {
        PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
        HOME: home,
        TMPDIR: tmpdir(),
        TZ: tz,
        LANG: 'en_US.UTF-8',
        ...Object.fromEntries(extra),
    };
}

// Error text can quote a --set value or a local path; neither belongs in a report.
// Paths go first, so a short value cannot break them up; values under 8 characters
// (AI_AGENT=1) are flags, not secrets, and replacing them would garble the text.
function scrubber(extra) {
    const swaps = [
        [process.cwd(), '<repo>'],
        [tmpdir(), '<tmp>'],
        [homedir(), '<home>'],
        ...extra.filter(([, v]) => v.length >= 8).map(([n, v]) => [v, `<${n}>`]),
    ];
    return (text) => swaps.reduce((t, [from, to]) => t.split(from).join(to), text ?? '');
}

function firstLine(text) {
    return (text ?? '').split('\n').find((l) => l.trim()) ?? '';
}

function failuresOf(report, scrub) {
    const found = [];
    for (const file of report.testResults ?? []) {
        const rel = relative(process.cwd(), file.name);
        for (const t of (file.assertionResults ?? []).filter((r) => r.status === 'failed')) {
            found.push({
                file: rel,
                test: t.fullName,
                error: scrub(firstLine(t.failureMessages?.[0])),
            });
        }
        if (file.status === 'failed' && file.message) {
            found.push({
                file: rel,
                test: '(file-level error)',
                error: scrub(firstLine(file.message)),
            });
        }
    }
    return found;
}

// The tests closest to the 5 s default timeout are the next ones to fail on a busy machine.
function slowestOf(report, count) {
    return (report.testResults ?? [])
        .flatMap((file) =>
            (file.assertionResults ?? []).map((t) => ({
                file: relative(process.cwd(), file.name),
                test: t.fullName,
                ms: Math.round(t.duration ?? 0),
            })),
        )
        .sort((a, b) => b.ms - a.ms)
        .slice(0, count);
}

function listHome(home) {
    try {
        return readdirSync(home).sort();
    } catch {
        return [];
    }
}

function runOnce(opts, index, sharedHome, outDir, scrub) {
    const home = sharedHome ?? mkdtempSync(join(tmpdir(), 'flaky-home-'));
    const seed = opts.shuffle ? 1000 + index : undefined;
    const jsonFile = join(outDir, `run-${String(index).padStart(2, '0')}.json`);
    // A report left by an earlier run with this label must never stand in for this one.
    rmSync(jsonFile, { force: true });
    const args = [
        './node_modules/vitest/vitest.mjs',
        'run',
        '--exclude',
        '**/live-*',
        '--reporter=json',
        `--outputFile=${jsonFile}`,
    ];
    if (seed !== undefined) args.push('--sequence.shuffle', `--sequence.seed=${seed}`);
    // How busy the machine already was: a slower run is not always the condition's fault.
    const loadBefore = loadavg()[0];
    const started = Date.now();
    const proc = spawnSync(process.execPath, args, {
        env: baseEnv(home, opts.tz, opts.extra),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: RUN_TIMEOUT_MS,
    });
    const seconds = (Date.now() - started) / 1000;
    let report;
    let reportMissing = false;
    try {
        report = JSON.parse(readFileSync(jsonFile, 'utf8'));
    } catch {
        report = { testResults: [] };
        reportMissing = true;
    }
    const failures = failuresOf(report, scrub);
    if (failures.length === 0 && (proc.status !== 0 || reportMissing)) {
        const why = proc.error ? proc.error.message : `exit ${proc.status}, signal ${proc.signal}`;
        failures.push({ file: '-', test: '(run failed with no failed test)', error: scrub(why) });
    }
    const result = {
        index,
        seed,
        exit: proc.status,
        signal: proc.signal,
        reportMissing,
        seconds,
        loadBefore,
        loadAfter: loadavg()[0],
        total: report.numTotalTests,
        failedTests: report.numFailedTests,
        failures,
        slowest: slowestOf(report, SLOWEST_KEPT),
        homeEntries: listHome(home),
    };
    if (!sharedHome) rmSync(home, { recursive: true, force: true });
    return result;
}

// A stated amount of CPU load: each burner spins one core and quits on its own
// within 100 ms once this script is gone, so a crash cannot leave them running.
const BURNER = `const parent = ${process.pid};
(function spin() {
    const until = Date.now() + 100;
    while (Date.now() < until);
    try { process.kill(parent, 0); } catch { process.exit(0); }
    setImmediate(spin);
})();`;

function startLoad(count) {
    return Array.from({ length: count }, () =>
        spawn(process.execPath, ['-e', BURNER], { stdio: 'ignore' }),
    );
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const outDir = resolve(opts.out, opts.label);
    mkdirSync(outDir, { recursive: true });
    const scrub = scrubber(opts.extra);
    const sharedHome =
        opts.home === 'keep' ? mkdtempSync(join(tmpdir(), 'flaky-home-')) : undefined;
    const burners = startLoad(opts.load);
    const runs = [];
    try {
        for (let i = 1; i <= opts.runs; i++) {
            const r = runOnce(opts, i, sharedHome, outDir, scrub);
            runs.push(r);
            const names = r.failures.map((f) => f.test).join(' | ') || '-';
            const load = r.loadBefore.toFixed(1);
            console.log(
                `[${opts.label}] run ${i}/${opts.runs} exit=${r.exit} ${r.seconds.toFixed(1)}s load=${load} ${names}`,
            );
        }
    } finally {
        for (const b of burners) b.kill();
        if (sharedHome) rmSync(sharedHome, { recursive: true, force: true });
    }
    const summary = {
        label: opts.label,
        tz: opts.tz,
        set: opts.extra.map(([name]) => name),
        shuffle: opts.shuffle,
        home: opts.home,
        load: opts.load,
        runs,
    };
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
}

main();
