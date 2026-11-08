/**
 * Vitest coverage for zen server keygen and standalone Ed25519 authentication.
 * Tests verify PEM formats, private permissions, exclusive writes and failure cleanup,
 * CLI output/help/completion, and acceptance of generated keys by a real HTTP runtime.
 * All keys and server state are temporary fixtures, never deployment credentials.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../src/commands/server.ts';
import { complete } from '../src/completion.ts';
import { generateServerKeys } from '../src/serverKeys.ts';
import { EXIT } from '../src/term.ts';

vi.mock('node:fs', async (original) => {
    const fs = await original<typeof import('node:fs')>();
    return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

let root: string;
beforeEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(writeFileSync).mockReset().mockImplementation(fs.writeFileSync);
    root = mkdtempSync(join(tmpdir(), 'zen-server-keys-'));
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
});

describe('server signing keys', () => {
    it('writes matching Ed25519 PKCS#8/SPKI PEMs with private permissions', () => {
        const paths = generateServerKeys(join(root, 'runtime-auth'));
        const privatePem = readFileSync(paths.privateKey, 'utf8');
        const publicPem = readFileSync(paths.publicKey, 'utf8');
        expect(privatePem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
        expect(publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
        expect(statSync(paths.privateKey).mode & 0o777).toBe(0o600);
        const privateKey = createPrivateKey(privatePem);
        const publicKey = createPublicKey(publicPem);
        expect(privateKey.asymmetricKeyType).toBe('ed25519');
        expect(publicKey.asymmetricKeyType).toBe('ed25519');
        const message = Buffer.from('keygen fixture');
        expect(verify(null, message, publicKey, sign(null, message, privateKey))).toBe(true);
        expect(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })).toBe(publicPem);
    });

    it('sets usable private/public modes even with a restrictive umask', () => {
        const previous = process.umask(0o777);
        try {
            const paths = generateServerKeys(join(root, 'permissions'));
            expect(statSync(paths.privateKey).mode & 0o777).toBe(0o600);
            expect(statSync(paths.publicKey).mode & 0o777).toBe(0o644);
            expect(readFileSync(paths.privateKey, 'utf8')).toContain('BEGIN PRIVATE KEY');
        } finally {
            process.umask(previous);
        }
    });

    it.each(['private', 'public'])('never overwrites an existing %s file', (kind) => {
        const prefix = join(root, 'existing');
        const existing = `${prefix}.${kind}.pem`;
        writeFileSync(existing, 'unchanged fixture');
        expect(() => generateServerKeys(prefix)).toThrow('cannot generate server keys');
        expect(readFileSync(existing, 'utf8')).toBe('unchanged fixture');
        expect(readdirSync(root)).toEqual([`existing.${kind}.pem`]);
    });

    it('does not follow an existing symlink or leave a partial private key', () => {
        const target = join(root, 'target');
        writeFileSync(target, 'unchanged fixture');
        const prefix = join(root, 'symlink');
        symlinkSync(target, `${prefix}.public.pem`);
        expect(() => generateServerKeys(prefix)).toThrow('cannot generate server keys');
        expect(readFileSync(target, 'utf8')).toBe('unchanged fixture');
        expect(existsSync(`${prefix}.private.pem`)).toBe(false);
    });

    it('reports a missing parent instead of creating credentials elsewhere', () => {
        expect(() => generateServerKeys(join(root, 'missing', 'keys'))).toThrow(
            'cannot generate server keys',
        );
        expect(readdirSync(root)).toEqual([]);
    });

    it('cleans up both files if writing the public key fails', async () => {
        const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
        vi.mocked(writeFileSync)
            .mockImplementationOnce(fs.writeFileSync)
            .mockImplementationOnce(() => {
                throw new Error('fixture disk failure');
            });
        expect(() => generateServerKeys(join(root, 'failed'))).toThrow('fixture disk failure');
        expect(readdirSync(root)).toEqual([]);
    });

    it('prints only paths and guidance, never PEM contents', async () => {
        let stdout = '';
        let stderr = '';
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            stdout += String(chunk);
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            stderr += String(chunk);
            return true;
        });
        await server.run({ args: ['keygen', '--out', 'auth'], cwd: root, json: false });
        expect(stdout).toContain(join(root, 'auth.private.pem'));
        expect(stdout).toContain(join(root, 'auth.public.pem'));
        expect(stderr).toContain('trusted caller');
        expect(stdout + stderr).not.toContain('-----BEGIN');
    });

    it('supports JSON output containing paths only', async () => {
        let stdout = '';
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            stdout += String(chunk);
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        await server.run({ args: ['keygen', '--out', 'auth'], cwd: root, json: true });
        expect(JSON.parse(stdout)).toEqual({
            privateKey: join(root, 'auth.private.pem'),
            publicKey: join(root, 'auth.public.pem'),
        });
    });

    it.each([{ args: [] }, { args: ['--out', '   '] }])(
        'requires an explicit nonempty output prefix ($args)',
        async ({ args }) => {
            await expect(
                server.run({ args: ['keygen', ...args], cwd: root, json: false }),
            ).rejects.toMatchObject({
                code: EXIT.usage,
            });
            expect(readdirSync(root)).toEqual([]);
        },
    );

    it('includes keygen in command help and shell completion', async () => {
        expect(server.usage).toContain('|keygen>');
        expect(server.details?.join('\n')).toContain('keygen');
        expect(server.details?.join('\n')).toContain('HTTP /chat');
        expect(await complete(['server', 'key'], root)).toEqual([{ value: 'keygen' }]);
    });

    it('generates distinct key pairs on separate invocations', () => {
        const first = generateServerKeys(join(root, 'first'));
        const second = generateServerKeys(join(root, 'second'));
        expect(readFileSync(first.publicKey, 'utf8')).not.toBe(
            readFileSync(second.publicKey, 'utf8'),
        );
    });

    it('creates a public key the secure runtime accepts for request JWTs', async () => {
        const { createServer } = await import('@zenera/server');
        const paths = generateServerKeys(join(root, 'integration'));
        const privateKey = createPrivateKey(readFileSync(paths.privateKey));
        const app = createServer({
            projectId: 'keygen-test',
            projectDir: root,
            root: join(root, 'state'),
            auth: {
                mode: 'jwt',
                publicKey: readFileSync(paths.publicKey, 'utf8'),
                issuer: 'zenera-app',
                audience: 'zenera-runtime',
            },
        });
        const http = await app.listen({ port: 0 });
        try {
            const address = http.address();
            if (!address || typeof address === 'string') throw new Error('missing TCP listener');
            const iat = Math.floor(Date.now() / 1000);
            const part = (value: object) =>
                Buffer.from(JSON.stringify(value)).toString('base64url');
            const input = `${part({ alg: 'EdDSA', typ: 'JWT' })}.${part({
                iss: 'zenera-app',
                aud: 'zenera-runtime',
                sub: 'ann',
                prj: 'keygen-test',
                req: 'GET /api/sessions',
                iat,
                exp: iat + 60,
            })}`;
            const jwt = `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
            const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
                headers: { authorization: `Bearer ${jwt}` },
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ sessions: [] });
        } finally {
            await app.stop();
        }
    });
});
