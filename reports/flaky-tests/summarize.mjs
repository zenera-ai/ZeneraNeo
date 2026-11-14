#!/usr/bin/env node
// Build the Markdown failure table from the summary.json files that flaky.mjs wrote.
// Usage: node reports/flaky-tests/summarize.mjs [OUT_DIR]   (default: .out/flaky)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '.out/flaky';
const ORDER = [
    'baseline',
    'shuffle',
    'tz-jakarta',
    'tz-newyork',
    'tz-kiritimati',
    'agent-marker',
    'provider-key',
    'shared-home',
];

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('<', '&lt;');
const local = [
    [process.cwd(), '<repo>'],
    [tmpdir(), '<tmp>'],
    [homedir(), '<home>'],
];
// Paths of a checkout elsewhere still name a person's folders: keep from packages/ on.
const scrub = (text) =>
    local
        .reduce((t, [from, to]) => t.split(from).join(to), text ?? '')
        .replace(/(file:\/\/)?\/\S*?\/(packages|node_modules)\//g, '$2/')
        .replace(/\/(Users|home)\/[^/\s]+/g, '<home>');
const nameOf = (entry) => entry.replace(/=.*/, '');
const NO_FAILED_TEST = '(run failed with no failed test)';

// A run failed if a test failed, vitest exited non-zero, or it left no report.
const failed = (r) => r.failures.length > 0 || r.exit !== 0 || r.reportMissing === true;

function changed(s) {
    const parts = [];
    if (s.tz !== 'UTC') parts.push(`TZ=${s.tz}`);
    for (const entry of s.set) parts.push(`${nameOf(entry)} set`);
    if (s.shuffle) parts.push(`shuffled order (seeds ${s.runs.map((r) => r.seed).join(', ')})`);
    if (s.home === 'keep') parts.push('one HOME kept across runs');
    if (s.load) parts.push(`${s.load} cores kept busy`);
    return parts.join(', ') || 'nothing (baseline)';
}

function median(values) {
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function row(s) {
    const counts = new Map();
    for (const r of s.runs) {
        for (const f of r.failures) {
            const key = `\`${f.file}\` > ${f.test}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    const tests =
        [...counts.entries()].map(([k, n]) => `${cell(k)}: ${n}/${s.runs.length}`).join('<br>') ||
        '-';
    const crashed = s.runs.filter((r) => r.failures.some((f) => f.test === NO_FAILED_TEST)).length;
    const runs = `${s.runs.filter(failed).length}${crashed ? ` (${crashed} with no failed test)` : ''}`;
    const secs = median(s.runs.map((r) => r.seconds)).toFixed(0);
    const loads = s.runs.map((r) => r.loadBefore).filter((x) => typeof x === 'number');
    const load = loads.length ? median(loads).toFixed(1) : 'n/a';
    return `| ${s.label} | ${cell(changed(s))} | ${s.runs.length} | ${runs} | ${tests} | ${secs} s | ${load} |`;
}

const rank = (label) => (ORDER.includes(label) ? ORDER.indexOf(label) : ORDER.length);
if (!existsSync(outDir)) {
    console.error(`no results in ${outDir}: run flaky.mjs first`);
    process.exit(1);
}
const summaries = readdirSync(outDir)
    .filter((d) => existsSync(join(outDir, d, 'summary.json')))
    .map((d) => JSON.parse(readFileSync(join(outDir, d, 'summary.json'), 'utf8')))
    .sort((a, b) => rank(a.label) - rank(b.label));
for (const s of summaries.filter((x) => !ORDER.includes(x.label))) {
    console.error(`note: ${s.label} is not one of the standard conditions`);
}

console.log(
    '| Condition | Changed from baseline | Runs | Runs that failed | Failing test: runs failed | Median run | Median load before |',
);
console.log('|---|---|---|---|---|---|---|');
for (const s of summaries) console.log(row(s));

const errors = new Map();
const homes = new Set();
for (const s of summaries) {
    for (const r of s.runs) {
        for (const f of r.failures) errors.set(`\`${f.file}\` > ${f.test}`, scrub(f.error));
        for (const h of r.homeEntries) homes.add(h);
    }
}
console.log('\nFirst error line per failing test:');
for (const [test, error] of errors) console.log(`- ${test}: ${error}`);
const slow = new Map();
for (const s of summaries) {
    for (const r of s.runs) {
        for (const t of r.slowest ?? []) {
            const key = `\`${t.file}\` > ${t.test}`;
            slow.set(key, [...(slow.get(key) ?? []), t.ms]);
        }
    }
}
if (slow.size) {
    console.log(
        '\nSlowest tests (runs where it was in the top 5: median ms, max ms, runs over 5000 ms):',
    );
    for (const [test, ms] of [...slow.entries()]
        .sort((a, b) => median(b[1]) - median(a[1]))
        .slice(0, 8)) {
        const over = ms.filter((x) => x > 5000).length;
        console.log(`- ${test}: ${ms.length} runs, ${median(ms)}, ${Math.max(...ms)}, ${over}`);
    }
}
console.log(`\nLeft in HOME by a run: ${[...homes].sort().join(', ') || 'nothing'}`);
console.log(`Total runs: ${summaries.reduce((n, s) => n + s.runs.length, 0)}`);
