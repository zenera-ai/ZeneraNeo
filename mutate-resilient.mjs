#!/usr/bin/env node
// Breaks the retry guard in packages/sandbox/src/process.ts one way at a time,
// runs a test command against each break, and restores the file afterwards,
// even on Ctrl-C. A mutant the tests do not notice is printed as SURVIVED.
//
//   node mutate-resilient.mjs                      # vitest on the new test file
//   node mutate-resilient.mjs -- <command ...>     # any other test command
//
// Run from the repository root with a clean process.ts. Not part of the PR.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'packages/sandbox/src/process.ts';
const sep = process.argv.indexOf('--');
const cmd =
    sep >= 0
        ? process.argv.slice(sep + 1)
        : ['npx', 'vitest', 'run', 'packages/sandbox/test/resilient.test.ts'];

const MUTANTS = [
    ['success no longer stops retries', '                res.code === 0 ||\n', ''],
    ['output no longer stops retries', "                res.stdout !== '' ||\n", ''],
    ['whitespace output counts as none', "res.stdout !== ''", "res.stdout.trim() !== ''"],
    ['an abort no longer stops retries', '                opts.signal?.aborted ||\n', ''],
    ['every failure is treated as transport', '!TRANSPORT.test(res.stderr)', 'false'],
    ['the pattern becomes case-sensitive', 'connection refused/i;', 'connection refused/;'],
    ['drop alternative: kex_exchange_identification', 'kex_exchange_identification|', ''],
    ['drop alternative: ssh: handshake failed', '|ssh: handshake failed', ''],
    ['drop alternative: ssh: unexpected packet', '|ssh: unexpected packet', ''],
    ['drop alternative: connection closed by remote host', '|connection closed by remote host', ''],
    ['drop alternative: connection reset by peer', '|connection reset by peer', ''],
    ['drop alternative: connection refused', '|connection refused/i', '/i'],
    [
        'a retry loses the options (and so the script on stdin)',
        'const res = await run(bin, args, opts);',
        'const res = await run(bin, args, n === 1 ? opts : {});',
    ],
    ['one attempt too many', 'n >= attempts', 'n > attempts'],
];

const original = readFileSync(FILE, 'utf8');
const restore = () => writeFileSync(FILE, original);
process.on('SIGINT', () => {
    restore();
    process.exit(130);
});

const run = () => spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', env: process.env });

try {
    const base = run();
    if (base.status !== 0) {
        console.error('The tests fail on the unmodified file; fix that first.\n');
        console.error(base.stdout + base.stderr);
        process.exit(1);
    }
    let survived = 0;
    for (const [name, from, to] of MUTANTS) {
        if (original.split(from).length !== 2) {
            throw new Error(`"${from}" is not in ${FILE} exactly once; the mutant list is stale`);
        }
        writeFileSync(FILE, original.replace(from, to));
        const res = run();
        restore();
        const red = res.status !== 0;
        survived += red ? 0 : 1;
        console.log(`${red ? 'KILLED  ' : 'SURVIVED'}  ${name}`);
        for (const line of (res.stdout + res.stderr).split('\n')) {
            if (/^\s*(✗|×|FAIL)\s/.test(line)) {
                console.log(`            ${line.trim()}`);
            }
        }
    }
    console.log(`\n${MUTANTS.length - survived} of ${MUTANTS.length} mutants killed`);
    process.exitCode = survived ? 1 : 0;
} finally {
    restore();
}
