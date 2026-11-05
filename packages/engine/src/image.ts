import {
    buildIdentity,
    localImageTag,
    projectDir,
    projectFile,
    type BuildIdentity,
    type BuildSpec,
    type SandboxConfig,
} from '@zenera/neo';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// The project's `build:` block, as paths
//
// Building is the sandbox's business — podman builds here, a sandbox service
// builds on its own machines — and so is what a build hashes to
// (`buildIdentity` in @zenera/sandbox). What stays on this side is the part
// about the project: which files the config names, and refusing any that
// escape it, because a project is data someone else may have written.
// ---------------------------------------------------------------------------

export interface ResolvedBuild extends BuildSpec, BuildIdentity {
    /** the tag it runs under on this machine */
    tag: string;
}

/**
 * What the config's `build:` block means on this machine, or nothing if it has
 * none. Both paths are resolved against the project root and refused if they
 * escape it.
 */
export function resolveBuild(root: string, config?: SandboxConfig): ResolvedBuild | undefined {
    if (!config?.build) {
        return undefined;
    }
    const dockerfile = projectFile(root, config.build.dockerfile, 'sandbox.build.dockerfile');
    const context = config.build.context
        ? projectDir(root, config.build.context, 'sandbox.build.context')
        : dirname(dockerfile);
    const spec: BuildSpec = { dockerfile, context };
    const id = buildIdentity(spec);
    return { ...spec, ...id, tag: localImageTag(id) };
}
