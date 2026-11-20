import { execFileSync } from 'node:child_process';
import { SANDBOX_BASE_INVENTORY } from '../packages/sandbox/src/base.ts';

const VOLATILE = [
    "-name '*.pyc'",
    '-path /etc/hostname',
    '-path /etc/hosts',
    '-path /etc/resolv.conf',
];
const FILES =
    `find /usr /etc /opt -xdev -type f ! \\( ${VOLATILE.join(' -o ')} \\) -print0 2> /dev/null` +
    ` | LC_ALL=C sort -z | xargs -0 sha256sum`;

const args = process.argv.slice(2);
const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args.splice(i, 2)[1];
};
const platform = flag('--platform');
const files = args.includes('--files') && Boolean(args.splice(args.indexOf('--files'), 1));
if (args.length !== 2 || args.some((a) => a.startsWith('-'))) {
    console.error(
        'usage: node scripts/sandbox-base-diff.mjs <image-a> <image-b> [--platform p] [--files]',
    );
    process.exit(2);
}
const [a, b] = args;

const engine =
    process.env.ZEN_ENGINE ||
    ['docker', 'podman'].find((bin) => {
        try {
            execFileSync(bin, ['--version'], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    });
if (!engine) {
    console.error('no docker or podman on PATH (or set ZEN_ENGINE)');
    process.exit(2);
}

function inImage(image, script) {
    const run = ['run', '--rm', '--network', 'none', '--entrypoint', 'sh'];
    if (platform) run.push('--platform', platform);
    try {
        return execFileSync(engine, [...run, image, '-c', script], {
            encoding: 'utf8',
            maxBuffer: 512 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        console.error(`${image}: ${String(err.stderr || err.message).trim()}`);
        process.exit(2);
    }
}

function inventory(text) {
    const sections = new Map();
    let current;
    for (const line of text.split('\n').filter(Boolean)) {
        const header = /^\[(\w+)\]$/.exec(line);
        if (header) {
            current = new Map();
            sections.set(header[1], current);
            continue;
        }
        const [key, value] = entry(line);
        current?.set(key, value);
    }
    return sections;
}

function entry(line) {
    let m;
    if ((m = /^(v[\d.]+)$/.exec(line))) return ['node', m[1]]; // node --version
    if ((m = /^Python (\S+)$/.exec(line))) return ['python', m[1]];
    if ((m = /^(\S+) (\S+) (\S+)$/.exec(line))) return [`${m[1]}:${m[3]}`, m[2]]; // dpkg
    if ((m = /^([^=\s]+)==(\S+)$/.exec(line))) return [m[1].toLowerCase(), m[2]]; // pip
    if ((m = /^([^:]+):(.+)$/.exec(line))) return [m[1], m[2].split(':')[0]]; // npm path:name@version
    return [line, ''];
}

function compare(left, right) {
    const changes = [];
    for (const key of new Set([...left.keys(), ...right.keys()])) {
        const was = left.get(key);
        const is = right.get(key);
        if (was === is) continue;
        changes.push(
            was === undefined
                ? `  + ${key} ${is}`
                : is === undefined
                  ? `  - ${key} ${was}`
                  : `  ~ ${key} ${was} -> ${is}`,
        );
    }
    return changes.sort();
}

let differs = false;
const left = inventory(inImage(a, SANDBOX_BASE_INVENTORY));
const right = inventory(inImage(b, SANDBOX_BASE_INVENTORY));
console.log(`${engine}: ${a}  vs  ${b}${platform ? `  (${platform})` : ''}`);
for (const section of new Set([...left.keys(), ...right.keys()])) {
    const l = left.get(section) ?? new Map();
    const r = right.get(section) ?? new Map();
    const changes = compare(l, r);
    console.log(
        `[${section}] ${changes.length ? `${changes.length} differ` : 'same'} (${l.size} / ${r.size})`,
    );
    for (const line of changes) console.log(line);
    differs ||= changes.length > 0;
}

if (files) {
    const sums = (image) =>
        new Map(
            inImage(image, FILES)
                .split('\n')
                .filter(Boolean)
                .map((line) => [line.slice(66), line.slice(0, 64)]),
        );
    const l = sums(a);
    const r = sums(b);
    const changed = [...new Set([...l.keys(), ...r.keys()])]
        .filter((path) => l.get(path) !== r.get(path))
        .sort();
    console.log(
        `[files] ${changed.length ? `${changed.length} differ` : 'same'} (${l.size} / ${r.size}),` +
            ` not compared: ${VOLATILE.join(', ')}`,
    );
    for (const path of changed) {
        console.log(`  ${!l.has(path) ? '+' : !r.has(path) ? '-' : '~'} ${path}`);
    }
    differs ||= changed.length > 0;
}

process.exit(differs ? 1 : 0);
