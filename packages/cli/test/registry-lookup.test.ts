import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error This small Node CLI module is JavaScript by design.
import { classifyNpmView, lookupRegistryVersion } from '../../../scripts/registry-lookup.mjs';

const version = (value = '1.2.3') => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' });
const npmError = (code: string, summary: string, exitCode = 1) => ({
    exitCode,
    stdout: JSON.stringify({ error: { code, summary } }),
    stderr: '',
});

describe('classifyNpmView', () => {
    it('classifies a valid version result as present', () => {
        expect(classifyNpmView(version())).toMatchObject({ status: 'present' });
    });

    it('classifies an E404 for a specific version as absent', () => {
        expect(classifyNpmView(npmError('E404', 'No match found for version 9.9.9'))).toMatchObject(
            {
                status: 'absent',
            },
        );
    });

    it('does not treat a missing package E404 as an absent version', () => {
        expect(
            classifyNpmView(
                npmError(
                    'E404',
                    'Not Found - GET https://registry.npmjs.org/@scope%2fpkg - Not found',
                ),
            ),
        ).toMatchObject({
            status: 'unknown',
        });
    });

    it.each(['E401', 'E403', 'E429', 'ETIMEDOUT', 'ECONNRESET', 'E500', 'E503'])(
        '%s remains unknown',
        (code) => {
            expect(classifyNpmView(npmError(code, `${code} registry error`))).toMatchObject({
                status: 'unknown',
            });
        },
    );

    it('treats empty and garbage output as unknown', () => {
        expect(classifyNpmView({ exitCode: 0, stdout: '', stderr: '' })).toMatchObject({
            status: 'unknown',
        });
        expect(
            classifyNpmView({ exitCode: 1, stdout: 'not json', stderr: 'not json' }),
        ).toMatchObject({
            status: 'unknown',
        });
    });

    it('treats a plain npm crash diagnostic as unknown', () => {
        expect(
            classifyNpmView({ exitCode: 1, stdout: '', stderr: 'npm error code ECONNRESET' }),
        ).toMatchObject({ status: 'unknown' });
    });
});

describe('lookupRegistryVersion', () => {
    it('retries an unknown result and stops when the version is found', async () => {
        const run = vi
            .fn()
            .mockResolvedValueOnce(npmError('E429', 'rate limited'))
            .mockResolvedValueOnce(version());
        const sleep = vi.fn().mockResolvedValue(undefined);

        await expect(
            lookupRegistryVersion({ name: '@scope/pkg', version: '1.2.3', run, sleep }),
        ).resolves.toMatchObject({
            status: 'present',
            attempts: 2,
        });
        expect(run).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(500);
    });

    it('fails as unknown after the bounded attempts are exhausted', async () => {
        const run = vi.fn().mockResolvedValue(npmError('ECONNRESET', 'connection reset'));
        const sleep = vi.fn().mockResolvedValue(undefined);

        await expect(
            lookupRegistryVersion({
                name: '@scope/pkg',
                version: '1.2.3',
                run,
                sleep,
                attempts: 3,
            }),
        ).resolves.toMatchObject({ status: 'unknown', attempts: 3 });
        expect(run).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('does not retry a confirmed absent version', async () => {
        const run = vi.fn().mockResolvedValue(npmError('E404', 'No match found for version 1.2.3'));

        await expect(
            lookupRegistryVersion({ name: '@scope/pkg', version: '1.2.3', run }),
        ).resolves.toMatchObject({
            status: 'absent',
            attempts: 1,
        });
        expect(run).toHaveBeenCalledTimes(1);
    });
});
