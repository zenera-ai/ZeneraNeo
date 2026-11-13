// packages/meta/src/prepare.ts
//
// Everything a meta agent session needs before it starts, shared by `zen meta run` and `zen meta chat`.
// Main: `prepare(values, project)` - load the project's .env, open the keyring, choose the model, wire the key,
// settle the session id (refusing a resume across models). Also `announce` (the stderr lines a run opens with),
// `projectModel` (agents.yaml's `model:`) and `asProvider`.
// Used by: `command.ts` (`go()` for run/resume, `chat()`, and `model()` for `projectModel`).

import * as Projects from '@zenera/engine';
import {
    assertOwner,
    ensureHome,
    isProvider,
    KeyStore,
    loadProjectEnv,
    PROVIDERS,
    type Provider,
} from '@zenera/engine';
import { gatewayOf, readProjectConfig } from '@zenera/neo';
import { randomUUID } from 'node:crypto';
import { credentialError, cyan, dim, note, splitRef, usageError, warn } from './host.ts';
import { locate, RESUME_PROMPT, type Binary } from './launch.ts';
import { chooseModel, fallbackRef, misspelledProvider, MODEL_ENV, readMeta } from './model.ts';
import type { ModelChoice } from './model.ts';
import { sameModel, sessionModel } from './tokens.ts';
import { providersWarning, wire, wireGateway, type Wiring } from './wire.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The flags that decide the model, the key and the session. */
export interface Selection {
    provider?: string;
    model?: string;
    resume?: string;
    continue?: boolean;
    'session-id'?: string;
}

export interface Prepared<F extends Selection> {
    /** the flags, with `resume` dropped when the session cannot be carried to this model */
    values: F;
    owner: Provider;
    chosen: ModelChoice;
    gateway: boolean;
    wiring: Wiring;
    binary: Binary;
    /** named up front, so a run killed before copilot reports its id can still be resumed */
    session?: string;
}

/**
 * `prompt` is what the session will be told first: a bare resume (the
 * `RESUME_PROMPT`) cannot become a new session, since it would have nothing to
 * continue, so a model change refuses it instead of starting over.
 */
export async function prepare<F extends Selection>(
    values: F,
    project: Projects.Project,
    prompt?: string,
): Promise<Prepared<F>> {
    const fresh = values['session-id'];
    if (fresh !== undefined) {
        if (values.resume || values.continue) {
            throw usageError('--session-id starts a new session', 'drop --resume / --continue');
        }
        if (!UUID.test(fresh)) {
            throw usageError(`--session-id must be a UUID, not ${fresh}`, 'try: uuidgen');
        }
    }
    const shell = process.env[MODEL_ENV];
    loadProjectEnv(project.dir);
    ensureHome();
    const store = await KeyStore.open();
    store.materialize();
    // After materialize: a keyring in bifrost mode is what sets the url.
    const gateway = gatewayOf();

    const only = values.provider ? asProvider(values.provider) : undefined;
    // The fallback can cost a gateway listing, so it is only looked up when nothing else answers.
    const chosen =
        chooseModel({
            flag: values.model,
            shell,
            env: process.env[MODEL_ENV],
            stored: (await readMeta()).model,
            project: projectModel(project.dir),
        }) ?? chooseModel({ fallback: await fallbackRef(store, only, gateway !== undefined) });
    if (!chosen) {
        if (only) {
            throw credentialError(`no ${only} key`, `add one: zen key add ${only}`);
        }
        throw credentialError(
            'no model for the meta agent',
            store.entries.length === 0
                ? 'add a key: zen key add openai'
                : 'set one: zen meta model <provider>/<id>',
        );
    }

    const { provider, id } = splitRef(chosen.ref);
    const owner = only ?? provider ?? 'openai';
    const meant = misspelledProvider(chosen.ref);
    if (meant && !only) {
        warn(`${chosen.ref} names no provider — did you mean ${meant}/${id}?`);
    }
    const entry = gateway ? undefined : store.active(owner);
    if (!gateway && !entry) {
        throw credentialError(`no ${owner} key`, `add one: zen key add ${owner}`);
    }

    const wiring = gateway ? wireGateway(gateway, owner, id) : wire(store, entry!, id);
    // Copilot cannot carry a session to another model: the resume fails on the first call.
    const ran = values.resume ? sessionModel(values.resume) : undefined;
    if (values.resume && ran && !sameModel(ran, wiring.model)) {
        if (prompt === RESUME_PROMPT) {
            throw usageError(
                `session ${values.resume} ran on ${ran}, and the meta model is now ${wiring.model} - copilot cannot carry a session to another model`,
                `switch back for it: zen meta model ${owner}/${ran.replace(/^.*\//, '')} - or ask again, which starts a new session`,
            );
        }
        warn(
            `session ${values.resume} ran on ${ran}; the meta model is now ${wiring.model}, so this starts a new session`,
        );
        values = { ...values, resume: undefined };
    }
    return {
        values,
        owner,
        chosen,
        gateway: gateway !== undefined,
        wiring,
        binary: locate(),
        session: values.resume ?? (values.continue ? undefined : (fresh ?? randomUUID())),
    };
}

/** What a session says on stderr before it starts: the warnings, then which model on which key. */
export function announce(p: Prepared<Selection>, project: Projects.Project): void {
    for (const line of p.wiring.warnings) {
        warn(line);
    }
    const competing = providersWarning();
    if (competing) {
        warn(competing);
    }
    if (p.chosen.from === 'default') {
        const what = p.gateway
            ? 'the best model the gateway serves'
            : `the best ${p.owner} model zen knows of`;
        note(dim(`no model set — using ${p.chosen.ref}, ${what}`));
        note(dim('set another: zen meta model <provider>/<id>'));
    }
    note(cyan(`${p.owner} · ${p.wiring.model} · ${project.name}`));
}

/** The project's own `model:`, with a `models:` alias resolved to what it names. */
export function projectModel(dir: string): string | undefined {
    try {
        const { config } = readProjectConfig(dir);
        const top = typeof config.model === 'string' ? config.model : undefined;
        const alias = top ? config.models?.[top] : undefined;
        if (!alias) {
            return top;
        }
        if (typeof alias === 'string') {
            return alias;
        }
        const owner = PROVIDERS.find((p) => p === alias.provider);
        return owner ? `${owner}/${alias.model}` : alias.model;
    } catch {
        return undefined;
    }
}

export function asProvider(name: string): Provider {
    const owner = assertOwner(name);
    if (!isProvider(owner)) {
        throw usageError(`${name} is not a model provider`);
    }
    return owner;
}
