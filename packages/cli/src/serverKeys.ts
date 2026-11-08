/**
 * Ed25519 key-pair generation for standalone secure runtime callers.
 * generateServerKeys writes exclusive PKCS#8 private and SPKI public PEM files,
 * removing files it created if generation cannot finish. Used by zen server keygen;
 * only the public key belongs on the runtime, never the signing private key.
 */
import { generateKeyPairSync } from 'node:crypto';
import { closeSync, fchmodSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { CliError, EXIT } from './term.ts';

export function generateServerKeys(prefix: string): { privateKey: string; publicKey: string } {
    const paths = {
        privateKey: `${prefix}.private.pem`,
        publicKey: `${prefix}.public.pem`,
    };
    const created: string[] = [];
    try {
        const pair = generateKeyPairSync('ed25519', {
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        for (const [path, pem, mode] of [
            [paths.privateKey, pair.privateKey, 0o600],
            [paths.publicKey, pair.publicKey, 0o644],
        ] as const) {
            const fd = openSync(path, 'wx', mode);
            created.push(path);
            try {
                fchmodSync(fd, mode);
                writeFileSync(fd, pem);
            } finally {
                closeSync(fd);
            }
        }
        return paths;
    } catch (err) {
        const failures: string[] = [];
        for (const path of created) {
            try {
                rmSync(path);
            } catch (cleanup) {
                failures.push(`${path}: ${cleanup instanceof Error ? cleanup.message : cleanup}`);
            }
        }
        const exists = err instanceof Error && 'code' in err && err.code === 'EEXIST';
        throw new CliError(
            `cannot generate server keys: ${err instanceof Error ? err.message : err}${
                failures.length ? `; cleanup failed: ${failures.join('; ')}` : ''
            }`,
            EXIT.credentials,
            exists
                ? 'existing files are never overwritten; choose a new --out prefix'
                : 'use an --out prefix in an existing writable directory',
        );
    }
}
