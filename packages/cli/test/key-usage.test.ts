import { describe, expect, it, vi } from 'vitest';
import { COMMANDS } from '../src/commands/index.ts';
import { CliError, EXIT } from '../src/term.ts';

/**
 * `zen key use`, `rm` and `show` with the key left off. The message has to say
 * how to write one, because the hint's `zen key ls` shows nothing to copy on an
 * empty keyring. What scripts can rely on is pinned alongside: a usage error
 * (exit 2), the same hint, and nothing at all on stdout, with or without --json.
 */
describe('zen key without the key it needs', () => {
    async function failure(args: string[], json: boolean): Promise<{ err: CliError; out: string }> {
        let out = '';
        const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            out += String(chunk);
            return true;
        });
        try {
            await COMMANDS.key!.run({ args, json, cwd: process.cwd() });
        } catch (e) {
            return { err: e as CliError, out };
        } finally {
            write.mockRestore();
        }
        throw new Error(`zen key ${args.join(' ')} did not fail`);
    }

    it.each([
        ['use', 'which key? name it as <provider>/<name>, e.g. zen key use openai/default'],
        ['rm', 'which key? name it as <provider>/<name>, e.g. zen key rm openai/default'],
        ['show', 'which key? name it as <provider>[/name], e.g. zen key show openai'],
    ])('zen key %s says how to name one', async (sub, message) => {
        for (const json of [false, true]) {
            const { err, out } = await failure([sub], json);
            expect(err).toBeInstanceOf(CliError);
            expect(err.message).toBe(message);
            expect(err.hint).toBe('see: zen key ls');
            expect(err.code).toBe(EXIT.usage);
            expect(out).toBe('');
        }
    });
});
