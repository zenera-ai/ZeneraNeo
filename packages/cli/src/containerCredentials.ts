/**
 * Runtime staging for credential files mounted into an agent container.
 * stageContainerCredentials copies only known credential files into the server's
 * private, ephemeral zen home and rewrites their environment paths before engines open.
 * Used by server commands in the image: bwrap can bind these container-owned copies
 * when keys are allowed, without re-binding an external Podman secret mount.
 */
import { credentials, home } from '@zenera/engine';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, EXIT } from './term.ts';

export async function stageContainerCredentials(): Promise<void> {
    const files = credentials().filter((credential) => credential.holds === 'file');
    if (!files.length) return;
    await mkdir(home(), { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(home(), '.server-credentials-'));
    const staged: Record<string, string> = {};
    try {
        for (const file of files) {
            const path = join(dir, `${file.env}.json`);
            await copyFile(file.value, path);
            await chmod(path, 0o600);
            staged[file.env] = path;
        }
        Object.assign(process.env, staged);
    } catch (err) {
        await rm(dir, { recursive: true, force: true });
        throw new CliError(
            `cannot stage runtime credential files: ${err instanceof Error ? err.message : err}`,
            EXIT.credentials,
            'credential files must be readable by the server; do not mount the whole host keyring',
        );
    }
}
