#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse as parsePath, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { ARCHIVE_LIMITS } from '../packages/cli/src/archive.ts';
import { buildHostileArchives } from '../packages/cli/test/support/hostile-archives.ts';

// ---------------------------------------------------------------------------
// Hostile archive runner
//
// Builds every archive in the catalogue, runs the real `zen import` against
// each one in its own home and landing directory, and records what landed.
// The archives are generated here and never committed: `reports/hostile-
// archives/.gitignore` keeps the output out of git, and `results.json` is the
// evidence a reviewer reads instead.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const cli = join(repo, 'packages/cli/dist/main.js');
const reportDir = join(repo, 'reports/hostile-archives');
const defaultOut = join(reportDir, 'archives');

function usage() {
    console.log(`usage: node scripts/hostile-archives.mjs [--out <dir>] [--quick]

  --out <dir>   where the generated zips go (default: ${defaultOut})
  --quick       small stand-ins for the 200k-entry floods and the 64 MiB bomb

The archives are never committed. The runner writes results.json and
results.md beside this script's report folder. Run \`npm run build\` first.`);
}

function parse(argv) {
    let out = defaultOut;
    let quick = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--out') {
            const value = argv[++i];
            if (value === undefined || value.startsWith('-')) {
                usage();
                process.exit(2);
            }
            out = resolve(value);
        } else if (arg === '--quick') {
            quick = true;
        } else if (arg === '--help' || arg === '-h') {
            usage();
            process.exit(0);
        } else {
            usage();
            process.exit(2);
        }
    }
    return { out, quick };
}

const { out, quick } = parse(process.argv.slice(2));

if (!existsSync(cli)) {
    console.error(`missing ${cli}`);
    console.error('run `npm run build` first, then run this script again');
    process.exit(1);
}

// This script deletes its output directory before building the archives. Never
// let a typo in `--out` turn that into deleting the repository, the home
// directory or the filesystem root.
const dangerous = new Set([repo, process.cwd(), homedir(), parsePath(out).root]);
if (dangerous.has(out)) {
    console.error(`refusing to clear ${out}`);
    process.exit(2);
}
if (existsSync(out)) {
    if (!statSync(out).isDirectory()) {
        console.error(`refusing to clear ${out}: not a directory`);
        process.exit(2);
    }
    if (out !== defaultOut && readdirSync(out).length > 0) {
        console.error(`refusing to clear ${out}: it already has files`);
        console.error('choose an empty directory, or remove it yourself first');
        process.exit(2);
    }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(reportDir, { recursive: true });

const cases = await buildHostileArchives(out, { full: !quick });
const runRoot = mkdtempSync(join(tmpdir(), 'zen-hostile-run-'));
const work = mkdtempSync(join(tmpdir(), 'zen-hostile-work-'));

function walk(dir, base = dir) {
    const found = [];
    if (!existsSync(dir)) {
        return found;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const at = join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...walk(at, base));
        } else {
            found.push({
                path: relative(base, at).split('\\').join('/'),
                bytes: statSync(at).size,
                mode: statSync(at).mode & 0o7777,
            });
        }
    }
    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function clean(text) {
    return text
        .replaceAll(runRoot, '<run>')
        .replaceAll(work, '<work>')
        .replaceAll(out, '<archives>')
        .replaceAll(repo, '<repo>')
        .trim();
}

function runImport(archive, landing, home) {
    return new Promise((done) => {
        const child = spawn(
            process.execPath,
            [cli, '--json', 'import', archive, landing, '--no-register'],
            {
                cwd: work,
                env: {
                    ...process.env,
                    ZENERA_HOME: home,
                    NO_COLOR: '1',
                    FORCE_COLOR: '0',
                },
            },
        );
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(chunk));
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.on('error', (err) => done({ code: -1, stdout: '', stderr: String(err) }));
        child.on('close', (code) => {
            done({
                code: code ?? -1,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            });
        });
    });
}

const caseIds = new Set(cases.map((testCase) => testCase.id));
const results = [];
for (const testCase of cases) {
    // The flood cases carry a small limit so the test suite can build them in
    // milliseconds. The CLI has no way to lower its own limit, so a quick run
    // cannot say anything true about them.
    if (quick && testCase.limits) {
        results.push({
            id: testCase.id,
            title: testCase.title,
            why: testCase.why,
            expect: testCase.expect,
            limits: testCase.limits,
            archive: `<archives>/${testCase.id}.zip`,
            exit: null,
            verdict: 'not exercised',
            message: 'quick mode cannot lower the CLI limit; run without --quick',
            files: [],
            outside: [],
        });
        continue;
    }

    const caseRoot = join(runRoot, testCase.id);
    const landing = join(caseRoot, 'landing');
    const home = join(caseRoot, 'home');
    mkdirSync(home, { recursive: true });

    const answer = await runImport(testCase.file, landing, home);
    const files = walk(landing);
    // An escaped `../../pwned.txt` lands above `caseRoot`, not inside it, so
    // walk the whole run tree and the CLI's cwd as well. The only files that
    // belong there are each case's landing and home.
    const outside = [
        ...walk(runRoot).filter((file) => {
            const [id, area] = file.path.split('/');
            return !(caseIds.has(id) && (area === 'landing' || area === 'home'));
        }),
        ...walk(work).map((file) => ({ ...file, path: `work/${file.path}` })),
    ];
    const refused = answer.code !== 0;
    const verdict =
        testCase.expect === 'refused'
            ? refused
                ? 'refused'
                : 'got through'
            : refused
              ? 'unexpected refusal'
              : 'accepted';

    let parsed;
    try {
        parsed = answer.stdout.trim() === '' ? undefined : JSON.parse(answer.stdout);
    } catch {
        parsed = undefined;
    }

    const problem =
        testCase.expect === 'accepted' && verdict === 'accepted'
            ? (testCase.lands ?? []).find((path) => !files.some((file) => file.path === path))
            : undefined;

    results.push({
        id: testCase.id,
        title: testCase.title,
        why: testCase.why,
        expect: testCase.expect,
        limits: testCase.limits,
        archive: `<archives>/${testCase.id}.zip`,
        exit: answer.code,
        verdict,
        message: clean(answer.stderr)
            .split('\n')
            .map((line) => line.trim())
            // Node's sqlite warning is about the runtime, not the archive.
            .filter(
                (line) =>
                    line !== '' && !line.startsWith('(node:') && !line.startsWith('(Use `node'),
            )
            .join(' — '),
        imported: parsed === undefined ? undefined : JSON.parse(clean(JSON.stringify(parsed))),
        files,
        outside,
        missingExpectedFile: problem,
    });
}

rmSync(runRoot, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });

const evidence = {
    generatedBy: 'scripts/hostile-archives.mjs',
    quick,
    limits: ARCHIVE_LIMITS,
    cases: results,
};
writeFileSync(join(reportDir, 'results.json'), `${JSON.stringify(evidence, null, 4)}\n`);

const md = [];
md.push('| case | expected | exit | landing | outside | verdict |');
md.push('| --- | --- | ---: | ---: | ---: | --- |');
for (const result of results) {
    md.push(
        `| \`${result.id}\` | ${result.expect} | ${result.exit} | ` +
            `${result.files.length} | ${result.outside.length} | **${result.verdict}** |`,
    );
}
const markdown = await format(`${md.join('\n')}\n`, { parser: 'markdown' });
writeFileSync(join(reportDir, 'results.md'), markdown);

process.stdout.write(markdown);

const bad = results.filter(
    (result) =>
        result.verdict === 'got through' ||
        result.verdict === 'unexpected refusal' ||
        result.missingExpectedFile !== undefined,
);
if (bad.length > 0) {
    console.error(`\n${bad.length} case(s) did not match their expectation`);
    for (const result of bad) {
        console.error(
            `  ${result.id}: ${result.verdict}${result.missingExpectedFile ? ` (missing ${result.missingExpectedFile})` : ''}`,
        );
    }
    process.exitCode = 1;
}
