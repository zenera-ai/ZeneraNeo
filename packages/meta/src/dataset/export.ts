import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { type Case, type Input, MEDIA_KINDS, type Part } from './types.ts';

// ---------------------------------------------------------------------------
// Cases leaving the store
//
// Two shapes. A batch input is exactly what `zen run batch` accepts — an id and
// an input, never a rubric, because whatever reaches the agent under test must
// not include the answer key. A dump is the whole case, rubric and all, for a
// grader or for another machine, and it reads back in through `apply`.
//
// Media paths are stored relative to the project. On the way out they are made
// relative to the file being written, which is how both `zen run batch` and
// `apply` read them back; written to stdout, they are absolute.
// ---------------------------------------------------------------------------

const URL_LIKE = /^[a-z][a-z0-9+.-]*:/i;

function rebase(input: Input, root: string, out: string | undefined): Input {
    if (typeof input === 'string') {
        return input;
    }
    return input.map((part): Part => {
        if (typeof part === 'string' || 'text' in part) {
            return part;
        }
        const kind = MEDIA_KINDS.find((k) => typeof part[k] === 'string');
        const ref = kind ? part[kind]! : undefined;
        if (!kind || !ref || URL_LIKE.test(ref)) {
            return part;
        }
        const absolute = isAbsolute(ref) ? ref : resolve(root, ref);
        const written = out
            ? relative(dirname(resolve(out)), absolute)
                  .split(sep)
                  .join('/')
            : absolute;
        return {
            ...part,
            [kind]: written.startsWith('.') || isAbsolute(written) ? written : `./${written}`,
        };
    });
}

export function batchInput(cases: readonly Case[], root: string, out?: string) {
    return { batch: cases.map((c) => ({ id: c.id, input: rebase(c.input, root, out) })) };
}

export function dump(cases: readonly Case[], root: string, revision: number, out?: string) {
    return {
        version: 1,
        revision,
        cases: cases.map((c) => ({ ...c, input: rebase(c.input, root, out) })),
    };
}
