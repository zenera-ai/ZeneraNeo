import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// The children a tuning started
//
// Every `zen` the loop runs is its own process group, so Ctrl-C reaches only the
// loop. The price: when the loop itself dies - killed, out of memory - those
// children carry on, writing into the very folders the next start rolls back.
// So each one is written down while it runs, and the next start stops whatever
// is still alive before it touches anything.
// ---------------------------------------------------------------------------

interface Child {
    pid: number;
    /** a word of its command line, so a recycled pid is never mistaken for it */
    marker: string;
    at: string;
}

const folder = (tuningDir: string): string => join(tuningDir, 'children');

export function remember(tuningDir: string, pid: number, marker: string): void {
    mkdirSync(folder(tuningDir), { recursive: true });
    const row: Child = { pid, marker, at: new Date().toISOString() };
    writeFileSync(join(folder(tuningDir), `${pid}.json`), `${JSON.stringify(row)}\n`);
}

export function forget(tuningDir: string, pid: number): void {
    rmSync(join(folder(tuningDir), `${pid}.json`), { force: true });
}

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
};

const commandOf = (pid: number): string =>
    spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '';

const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
        process.kill(-pid, sig);
    } catch {
        try {
            process.kill(pid, sig);
        } catch {
            // Gone already.
        }
    }
};

/**
 * Stops every child a dead loop left running, and waits until they are gone.
 * Only under the loop's lock: a live loop's children look the same.
 */
export async function reap(tuningDir: string, graceMs = 10_000): Promise<number[]> {
    let names: string[] = [];
    try {
        names = readdirSync(folder(tuningDir)).filter((n) => n.endsWith('.json'));
    } catch {
        return [];
    }
    const left: number[] = [];
    for (const name of names) {
        let child: Child | undefined;
        try {
            child = JSON.parse(readFileSync(join(folder(tuningDir), name), 'utf8')) as Child;
        } catch {
            // A row torn by the kill itself.
        }
        if (child && alive(child.pid) && commandOf(child.pid).includes(child.marker)) {
            signal(child.pid, 'SIGTERM');
            left.push(child.pid);
        }
    }
    const until = Date.now() + graceMs;
    while (left.some(alive) && Date.now() < until) {
        await sleep(100);
    }
    for (const pid of left.filter(alive)) {
        signal(pid, 'SIGKILL');
    }
    while (left.some(alive) && Date.now() < until + 2000) {
        await sleep(50);
    }
    rmSync(folder(tuningDir), { recursive: true, force: true });
    return left;
}
