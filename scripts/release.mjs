#!/usr/bin/env node
/**
 * Lockstep versioning for the publishable packages.
 *
 * The packages depend on each other by range, so their versions are kept
 * identical and moved together: one number, one tag, one release. Note what is
 * *not* here — no changelog generation, no publishing. Publishing is CI's job
 * (see .github/workflows/release.yml); this script only writes the numbers and
 * cuts the tag that triggers it.
 *
 * `npm version --workspaces` cannot do this: it bumps each workspace but leaves
 * a dependent workspace's range pointing at the old version, so the CLI would
 * ship asking for a library that predates it.
 *
 *   node scripts/release.mjs patch|minor|major|<x.y.z> [--dry-run] [--no-tag]
 *   node scripts/release.mjs verify v1.2.3
 *   node scripts/release.mjs workspaces [--paths]   # publish order, -w flags or dirs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (dir) => JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
const write = (dir, json) =>
    writeFileSync(join(ROOT, dir, 'package.json'), JSON.stringify(json, null, 4) + '\n');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const npm = (...args) => execFileSync('npm', args, { cwd: ROOT, stdio: 'inherit' });

const die = (message) => {
    console.error(`release: ${message}`);
    process.exit(1);
};

/** Publish order: a package comes after every sibling it depends on. */
function order(dirs) {
    const byName = new Map(dirs.map((dir) => [read(dir).name, dir]));
    const sorted = [];
    const visit = (dir, trail) => {
        if (sorted.includes(dir)) return;
        if (trail.includes(dir)) die(`dependency cycle: ${[...trail, dir].join(' -> ')}`);
        for (const dep of Object.keys(read(dir).dependencies ?? {})) {
            if (byName.has(dep)) visit(byName.get(dep), [...trail, dir]);
        }
        sorted.push(dir);
    };
    for (const dir of dirs) visit(dir, []);
    return sorted;
}

/** Everything under packages/ that is not `private` is published. */
const PACKAGES = order(
    readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `packages/${entry.name}`)
        .filter((dir) => existsSync(join(ROOT, dir, 'package.json')) && !read(dir).private),
);

/** The names that move in lockstep — a dependency on any of them is internal. */
const INTERNAL = new Set(PACKAGES.map((dir) => read(dir).name));

const internalDeps = (pkg) =>
    Object.keys(pkg.dependencies ?? {}).filter((name) => INTERNAL.has(name));

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

function next(current, spec) {
    if (SEMVER.test(spec)) return spec;
    const parsed = SEMVER.exec(current);
    if (!parsed) die(`cannot bump the unparseable current version ${current}`);
    const [major, minor, patch] = parsed.slice(1, 4).map(Number);
    if (spec === 'major') return `${major + 1}.0.0`;
    if (spec === 'minor') return `${major}.${minor + 1}.0`;
    if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
    return die(`unknown version "${spec}" — use major, minor, patch or an explicit x.y.z`);
}

/** Every publishable package must already agree on the version we are moving from. */
function current() {
    const versions = new Map(PACKAGES.map((dir) => [dir, read(dir).version]));
    const distinct = new Set(versions.values());
    if (distinct.size !== 1) {
        die(
            'the packages are out of lockstep:\n  ' +
                [...versions].map(([dir, v]) => `${dir} ${v}`).join('\n  '),
        );
    }
    return [...distinct][0];
}

/** The tag the release workflow fires on must name the version in the tree. */
function verify(tag) {
    if (!tag) die('verify needs a tag, e.g. `verify v1.2.3`');
    const version = tag.replace(/^v/, '');
    for (const dir of PACKAGES) {
        const pkg = read(dir);
        if (pkg.version !== version) {
            die(`tag ${tag} does not match ${pkg.name}@${pkg.version}`);
        }
        for (const name of internalDeps(pkg)) {
            const range = pkg.dependencies[name];
            if (range !== `^${version}`) {
                die(`${pkg.name} depends on ${name}@${range}, expected ^${version}`);
            }
        }
    }
    console.log(`release: ${tag} matches ${PACKAGES.length} packages`);
}

function bump(spec, { dryRun, tag }) {
    if (!dryRun && git('status', '--porcelain')) {
        die('the working tree is dirty — commit or stash first');
    }

    const from = current();
    const to = next(from, spec);
    if (to === from) die(`already at ${from}`);
    if (git('tag', '--list', `v${to}`)) die(`tag v${to} already exists`);

    const updates = PACKAGES.map((dir) => {
        const pkg = read(dir);
        pkg.version = to;
        // Keep each package pinned to the siblings it was built against.
        for (const name of internalDeps(pkg)) pkg.dependencies[name] = `^${to}`;
        console.log(`release: ${pkg.name} ${from} -> ${to}`);
        return { dir, pkg };
    });

    if (dryRun) {
        console.log('release: --dry-run, no files changed');
        return;
    }

    for (const { dir, pkg } of updates) write(dir, pkg);
    npm('install', '--package-lock-only', '--silent');
    git('add', 'package-lock.json', ...PACKAGES.map((dir) => join(dir, 'package.json')));
    git('commit', '-m', `release: v${to}`);
    if (tag) git('tag', '-a', `v${to}`, '-m', `v${to}`);

    console.log(
        [
            '',
            `release: committed v${to}${tag ? ` and tagged it` : ''}.`,
            '  next:  git push --follow-tags',
            '  then:  the Release workflow publishes every package to npm',
        ].join('\n'),
    );
}

const [command, ...rest] = process.argv.slice(2);
if (!command) die('usage: release.mjs <major|minor|patch|x.y.z> | verify <tag> | workspaces');
if (command === 'verify') verify(rest[0]);
else if (command === 'workspaces') {
    const paths = rest.includes('--paths');
    console.log(paths ? PACKAGES.join('\n') : PACKAGES.map((dir) => `-w ${dir}`).join(' '));
} else bump(command, { dryRun: rest.includes('--dry-run'), tag: !rest.includes('--no-tag') });
