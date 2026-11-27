import type { ProcResult } from '@zenera/neo';
import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';

import {
    clock,
    layout,
    machineProcesses,
    parseFootprint,
    parsePs,
    parseStats,
    ResourceSampler,
    viewOf,
    type Line,
    type Owners,
} from '../src/resources.ts';

const GB = 1_000_000_000;
const ok = (stdout: string): ProcResult => ({
    code: 0,
    stdout,
    stderr: '',
    truncated: false,
    timedOut: false,
});
const text = (line: Line): string => line.map((s) => s.text).join('');

const PS = [
    '  7248  24064   3:33.43 08-16:36:58 /opt/homebrew/libexec/podman/gvproxy',
    '  7251  15440   0:21.81 08-16:36:57 /opt/homebrew/libexec/podman/vfkit',
    '  7253 1018240 296:10.89 08-16:36:57 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine',
    '  8000 500000  10:00.00 02-01:00:00 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine',
    ' 59578  17408   9:06.46 15-17:15:46 /opt/homebrew/libexec/podman/gvproxy',
    '   501   2048   0:00.10    01:02 /bin/zsh',
].join('\n');

const FOOTPRINT = [
    '======================================================================',
    'com.apple.Virtualization.VirtualMachine [7253]: 64-bit    Footprint: 14989126336 B (16384 bytes per page)',
    '======================================================================',
    '',
    'Auxiliary data:',
    '    dirty: Y',
    '    phys_footprint_peak: 14989978304 B',
    '    phys_footprint: 14989929152 B',
    '',
    '======================================================================',
    'gvproxy [7248]: 64-bit    Footprint: 37488640 B (16384 bytes per page)',
    '======================================================================',
    '    phys_footprint: 37488640 B',
].join('\n');

describe('reading ps', () => {
    it('reads cpu and elapsed time in every shape ps prints them', () => {
        expect(clock('296:10.89')).toBeCloseTo(296 * 60 + 10.89);
        expect(clock('1:02:03')).toBe(3723);
        expect(clock('08-16:36:58')).toBe(8 * 86400 + 16 * 3600 + 36 * 60 + 58);
        expect(clock('01:02')).toBe(62);
        expect(clock('garbage')).toBe(0);
    });

    it('finds the machine, matching the Apple service and helper by start time', () => {
        const found = machineProcesses(parsePs(PS));
        expect(found.map((p) => [p.pid, p.role])).toEqual([
            [7253, 'vm'],
            [7251, 'hypervisor'],
            [7248, 'network'],
        ]);
        expect(found[0]!.name).toBe('Virtual Machine Service for vfkit');
        expect(found[0]!.rss).toBe(1018240 * 1024);
    });

    it('counts a hypervisor that holds its own memory as the machine', () => {
        const found = machineProcesses(
            parsePs('  42  900000  1:00.00  10:00 /usr/local/bin/krunkit'),
        );
        expect(found).toMatchObject([{ pid: 42, role: 'vm', name: 'krunkit' }]);
    });

    it('finds nothing on a host with no machine', () => {
        expect(machineProcesses(parsePs('  1  10  0:01.00  01:00 /sbin/launchd'))).toEqual([]);
    });

    it('reads the exact footprint, not the rounded header', () => {
        const sizes = parseFootprint(FOOTPRINT);
        expect(sizes.get(7253)).toEqual({ footprint: 14989929152, peak: 14989978304 });
        expect(sizes.get(7248)).toEqual({ footprint: 37488640 });
    });
});

describe('reading podman stats', () => {
    it('reads raw figures, one container per line, network summed', () => {
        const out = parseStats(
            [
                JSON.stringify({
                    ContainerID: '327c855956ef0000',
                    Name: 'zn-a',
                    CPUNano: 5e9,
                    SystemNano: 1e18,
                    AvgCPU: 1.5,
                    MemUsage: 2e6,
                    MemLimit: 4294967296,
                    PIDs: 2,
                    Network: { eth0: { RxBytes: 100, TxBytes: 10 }, eth1: { RxBytes: 1 } },
                }),
                'not json',
                JSON.stringify({ Name: 'zn-b', Network: null }),
            ].join('\n'),
        );
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({
            id: '327c855956ef',
            memory: 2e6,
            limit: 4294967296,
            netIn: 101,
            netOut: 10,
            avgCpu: 1.5,
        });
        expect(out[1]).toMatchObject({ name: 'zn-b', netIn: 0, memory: 0 });
    });
});

/**
 * A podman, a ps and a footprint that answer from fixed figures, advancing
 * the cpu counters by `cpu` seconds per sample so the interval maths is checked.
 */
function fakeHost(opts: { memAvailable?: number; containerMemory?: number } = {}) {
    let calls = 0;
    const exec = async (bin: string, args: readonly string[]): Promise<ProcResult> => {
        const line = `${bin} ${args.join(' ')}`;
        if (line.startsWith('podman info')) {
            return ok(
                JSON.stringify({
                    host: {
                        memTotal: 16 * GB,
                        memFree: 6 * GB,
                        memAvailable: opts.memAvailable ?? 14 * GB,
                        swapTotal: 0,
                        swapFree: 0,
                        cpus: 8,
                    },
                }),
            );
        }
        if (line.startsWith('podman stats')) {
            calls++;
            const tick = calls - 1;
            const one = (name: string, id: string, cpuSeconds: number, memory: number) =>
                JSON.stringify({
                    ContainerID: id,
                    Name: name,
                    CPUNano: cpuSeconds * 1e9,
                    SystemNano: 1e18 + tick * 2e9,
                    AvgCPU: 3,
                    MemUsage: memory,
                    MemLimit: 4 * GB,
                    PIDs: 3,
                });
            return ok(
                [
                    // one full core for two seconds
                    one('zn-live-1', 'a1', 10 + tick * 2, opts.containerMemory ?? GB),
                    one('zn-gone-1', 'b2', 1, 0.2 * GB),
                    // no cap: the limit podman reports is the whole machine
                    JSON.stringify({
                        ContainerID: 'c3',
                        Name: 'mine',
                        MemUsage: 5e6,
                        MemLimit: 16 * GB,
                    }),
                ].join('\n'),
            );
        }
        if (line.startsWith('podman ps')) {
            return ok(
                JSON.stringify([
                    { Names: ['zn-live-1'], State: 'running', Labels: { 'zenera.key': 'live' } },
                    { Names: ['zn-gone-1'], State: 'running', Labels: { 'zenera.key': 'gone' } },
                    { Names: ['zn-old-1'], State: 'exited', Labels: { 'zenera.key': 'live' } },
                ]),
            );
        }
        if (line.startsWith('podman machine list')) {
            return ok(JSON.stringify([{ Name: 'podman-machine-default', Default: true }]));
        }
        if (bin === 'ps') {
            const vmCpu = 296 * 60 + (calls > 0 ? calls * 1 : 0);
            return ok(
                [
                    `  7251  15440   0:21.81 08-16:36:57 /x/vfkit`,
                    `  7253 1018240 ${Math.floor(vmCpu / 60)}:${(vmCpu % 60).toFixed(2)} 08-16:36:57 /x/com.apple.Virtualization.VirtualMachine`,
                ].join('\n'),
            );
        }
        if (bin === 'footprint') {
            return ok(
                '[7253]: 64-bit    Footprint: 15000000000 B\n    phys_footprint: 15000000000 B\n' +
                    '[7251]: 64-bit    Footprint: 13000000 B\n',
            );
        }
        return { code: 1, stdout: '', stderr: 'unexpected', truncated: false, timedOut: false };
    };
    return exec;
}

// `live` belongs to a session whose run is still holding it; `gone` does not.
const owners = async (): Promise<Owners> => ({
    dirs: new Map([['gone', '/nonexistent/sessions/gone']]),
    names: new Map([
        ['live', 'shop'],
        ['gone', 'shop'],
    ]),
});

function sampler(opts: Parameters<typeof fakeHost>[0] = {}): ResourceSampler {
    let now = 1_000_000;
    return new ResourceSampler({
        exec: fakeHost(opts),
        platform: 'darwin',
        owners,
        now: () => (now += 2000),
    });
}

describe('a view of two samples', () => {
    it('reports agent environment containers as gym', async () => {
        const sample = await sampler().sample();
        sample.owned[0]!.key = `gym-${process.pid}`;
        sample.owned[1]!.key = 'gym-999999';
        const view = viewOf(sample);
        expect(view.containers.filter((c) => c.kind === 'gym')).toHaveLength(2);
        expect(view.totals.gym).toBe(2);
        expect(view.totals.zen).toBe(0);
    });

    it('measures cpu over the interval once there are two samples', async () => {
        const s = sampler();
        const first = await s.next();
        expect(first.interval).toBeUndefined();
        expect(first.containers[0]).toMatchObject({ cpu: 3, cpuOver: 'lifetime' });

        const view = await s.next();
        expect(view.interval).toBe(2);
        const live = view.containers.find((c) => c.name === 'zn-live-1')!;
        expect(live.cpu).toBeCloseTo(100);
        expect(live.cpuOver).toBe('interval');
        expect(view.host.vm?.cpu).toBeCloseTo(50);
    });

    it('tells zen containers from others and finds the orphans', async () => {
        const view = await sampler().next();
        const by = Object.fromEntries(view.containers.map((c) => [c.name, c]));
        expect(by['zn-live-1']).toMatchObject({ kind: 'zen', project: 'shop', orphaned: false });
        expect(by['zn-gone-1']).toMatchObject({ kind: 'zen', orphaned: true });
        expect(by['mine']).toMatchObject({ kind: 'other', limit: undefined });
        expect(view.stopped).toBe(1);
        expect(view.totals).toMatchObject({ running: 3, zen: 2, other: 1, orphaned: 1 });
    });

    it('splits the machine into in use, cache and free, and what macOS holds beyond it', async () => {
        const view = await sampler().next();
        expect(view.machine).toMatchObject({
            name: 'podman-machine-default',
            total: 16 * GB,
            used: 2 * GB,
            cache: 8 * GB,
            free: 6 * GB,
            // 15 GB counted by macOS, 10 GB touched inside
            held: 5 * GB,
        });
        expect(view.host.vm).toMatchObject({ pid: 7253, memory: 15 * GB });
    });

    it('says what to do about it', async () => {
        const view = await sampler({ memAvailable: 1 * GB, containerMemory: 3.9 * GB }).next();
        const all = view.hints.join('\n');
        expect(all).toMatch(/zen sandbox clean --idle/);
        expect(all).toMatch(/nearly out of memory/);
        expect(all).toMatch(/zn-live-1 is using .* of its own limit/);
    });

    it('reports an engine that does not answer instead of throwing', async () => {
        const s = new ResourceSampler({
            exec: async () => ({
                code: 125,
                stdout: '',
                stderr: 'down',
                truncated: false,
                timedOut: false,
            }),
            platform: 'darwin',
            owners,
        });
        const view = await s.next();
        expect(view.ready).toBe(false);
        expect(view.problems.join(' ')).toMatch(/zen sandbox up/);
        expect(view.containers).toEqual([]);
    });
});

describe('laying out the view', () => {
    it('clips Unicode project and container names without shifting resource columns', async () => {
        const view = await sampler().next();
        view.containers[0]!.project = '你好'.repeat(20);
        view.containers[0]!.name = '👩🏽‍💻'.repeat(80);
        const lines = layout(view, { width: 80, explain: false }).map(text);
        const row = lines.find((line) => line.includes('👩🏽‍💻'))!;
        expect(row).toBeDefined();
        expect(stringWidth(row)).toBeLessThanOrEqual(80);
        expect(row).toContain('…');
    });
    it('explains every figure, and says nothing extra when brief', async () => {
        const view = await sampler().next();
        const long = layout(view, { width: 200, explain: true, wrapNotes: true }).map(text);
        const brief = layout(view, { width: 200, explain: false }).map(text);
        expect(long.join('\n')).toMatch(
            /Activity Monitor shows for “Virtual Machine Service for vfkit”/,
        );
        expect(long.join('\n')).toMatch(/given back the moment a program needs room/);
        expect(brief.join('\n')).not.toMatch(/Activity Monitor/);
        expect(brief.length).toBeLessThan(long.length);
    });

    it('drops the least needed columns on a narrow screen', async () => {
        const view = await sampler().next();
        const header = (width: number): string =>
            layout(view, { width, explain: false })
                .map(text)
                .find((l) => l.includes('MEMORY') && l.includes('NAME'))!;
        expect(header(200)).toMatch(/NET/);
        expect(header(80)).not.toMatch(/NET/);
        expect(header(80)).toMatch(/CPU +MEMORY/);
    });

    it('never returns more lines than the screen has, keeping containers over hints', async () => {
        const view = await sampler({ memAvailable: 1 * GB }).next();
        for (const rows of [8, 20, 30, 60]) {
            const lines = layout(view, { width: 80, rows, explain: true });
            expect(lines.length).toBeLessThanOrEqual(rows);
        }
        const short = layout(view, { width: 80, rows: 32, explain: true }).map(text);
        expect(short.some((l) => l.includes('zn-live-1'))).toBe(true);
    });

    it('wraps a hint on the live screen, and never shows half of one', async () => {
        const view = await sampler({ memAvailable: 1 * GB }).next();
        const words = (lines: string[]): string => lines.join(' ').replace(/\s+/g, ' ');
        const tall = layout(view, { width: 60, rows: 200, explain: false }).map(text);
        const hints = tall.slice(tall.findIndex((l) => l.startsWith('WHAT TO DO')) + 1);
        expect(hints.every((l) => l.length <= 60)).toBe(true);
        expect(words(hints)).toContain(words([view.hints[0]!]));

        for (let rows = 20; rows < 60; rows++) {
            const lines = layout(view, { width: 60, rows, explain: false }).map(text);
            const at = lines.findIndex((l) => l.startsWith('WHAT TO DO'));
            if (at < 0) {
                continue;
            }
            const shown = lines.slice(at + 1).filter((l) => !l.includes('taller window'));
            const said = words(shown);
            for (const hint of view.hints) {
                const start = words([hint]).slice(0, 30);
                if (said.includes(start)) {
                    expect(said).toContain(words([hint]));
                }
            }
        }
    });
});
