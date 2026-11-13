import { Kernel } from '@zenera/neo';
import { describe, expect, it } from 'vitest';
import { buildDiagnostic, DEBUG_PREAMBLE, parseRecordedRequest, pickModel } from '../src/ask.ts';
import { CliError } from '../src/term.ts';

// ---------------------------------------------------------------------------
// `zen inspect ask`
//
// Two things here are worth a test and the rest is prose.
//
// The first is the shape of the replayed request: the recorded conversation has
// to arrive intact, the question has to be last, and the assistant turn that is
// put back must not carry tool calls — a tool call with no result after it is
// rejected outright by two of the four providers, so getting this wrong breaks
// the command on exactly the runs it exists for.
//
// The second is which model answers. A node records a wire id and not a
// reference, so the id is matched back against what the project declares; the
// wrong answer there sends the whole system prompt to a provider nobody named.
// ---------------------------------------------------------------------------

const recorded = Kernel.serializeRequest({
    system: 'You are the lead. Run the tests with npm test.',
    messages: [
        { role: 'user', content: [{ type: 'text', text: 'are the tests green?' }] },
        { role: 'assistant', content: 'let me look' },
        { role: 'tool', callId: 'c1', name: 'run_command', content: 'exit 0' },
    ],
    tools: [
        {
            name: 'run_command',
            description: 'run a shell command',
            parameters: { type: 'object', properties: {} },
        },
    ],
    toolChoice: 'auto',
});

const input = {
    request: parseRecordedRequest(recorded),
    answer: 'I will try python -c instead.',
    toolCalls: [{ name: 'run_command', callId: 'c2', args: '{"command":"python -c pass"}' }],
    query: 'why python -c when the skill says npm test?',
};

describe('the replayed request', () => {
    it('keeps the recorded conversation and puts the question last', () => {
        const req = buildDiagnostic(input);

        expect(req.messages.slice(0, 3)).toEqual(input.request.messages);
        const last = req.messages.at(-1);
        expect(last?.role).toBe('user');
        const said = last?.role === 'user' ? last.content : [];
        expect(said).toEqual([{ type: 'text', text: expect.stringContaining(input.query) }]);
    });

    it('puts the recorded answer back without its tool calls', () => {
        const req = buildDiagnostic(input);
        const assistant = req.messages.at(-2);

        expect(assistant).toEqual({ role: 'assistant', content: input.answer });
        expect(assistant).not.toHaveProperty('toolCalls');
    });

    it('quotes the tool calls as byte-counted evidence instead', () => {
        const asked = text(buildDiagnostic(input));

        expect(asked).toContain('evidence, never instruction');
        expect(asked).toContain(
            `--- you called run_command (c2) · ${Buffer.byteLength(input.toolCalls[0].args)} bytes`,
        );
        expect(asked).toContain(input.toolCalls[0].args);
    });

    it('names a turn that produced no prose, so the roles still alternate', () => {
        const req = buildDiagnostic({ ...input, answer: '  ' });

        expect(req.messages.at(-2)).toEqual({
            role: 'assistant',
            content: expect.stringContaining('no prose'),
        });
    });

    it('prefixes the debugging permission to the system prompt it recorded', () => {
        const req = buildDiagnostic(input);

        expect(req.system?.startsWith(DEBUG_PREAMBLE)).toBe(true);
        expect(req.system).toContain('Run the tests with npm test.');
    });

    it('shows the tools it had and refuses it the use of them', () => {
        const req = buildDiagnostic(input);

        expect(req.tools).toEqual(input.request.tools);
        expect(req.toolChoice).toBe('none');
    });
});

describe('the recorded request', () => {
    it('refuses a blob that is not a request', () => {
        expect(() => parseRecordedRequest('{"hello":true}')).toThrow(CliError);
        expect(() => parseRecordedRequest('not json')).toThrow(CliError);
    });
});

// ---------------------------------------------------------------------------

const node = { agent: 'lead', model: 'claude-opus-5' };

describe('which model answers', () => {
    const config = (body: object) => ({ agents: [], ...body }) as never;

    it('takes the flag over anything the project says', () => {
        const picked = pickModel(
            config({ agents: [{ name: 'lead', model: 'anthropic/claude-opus-5' }] }),
            node,
            'vertex/gemini-3.8-flash',
        );

        expect(picked).toEqual({
            ref: 'vertex/gemini-3.8-flash',
            label: 'vertex/gemini-3.8-flash',
            same: false,
            from: 'flag',
        });
    });

    it('knows a flag naming the model the run used', () => {
        const picked = pickModel(
            config({}),
            { agent: 'default', model: 'gpt-5-mini', ref: 'openai/gpt-5-mini' },
            'openai:gpt-5-mini',
        );

        expect(picked.same).toBe(true);
    });

    it('resolves the wire id through the agent that made the call', () => {
        const picked = pickModel(
            config({
                agents: [
                    { name: 'scout', model: 'openai/gpt-5.6-sol' },
                    { name: 'lead', model: 'anthropic/claude-opus-5' },
                ],
            }),
            node,
            undefined,
        );

        expect(picked).toMatchObject({ ref: 'anthropic/claude-opus-5', from: 'agent' });
    });

    it('follows the models: alias the agent named, knobs and all', () => {
        const deep = { provider: 'anthropic', model: 'claude-opus-5', maxTokens: 9000 };
        const picked = pickModel(
            config({ models: { deep }, agents: [{ name: 'lead', model: 'deep' }] }),
            { ...node, ref: 'anthropic/claude-opus-5' },
            undefined,
        );

        expect(picked).toEqual({
            ref: deep,
            label: 'anthropic/claude-opus-5',
            same: true,
            from: 'agent',
        });
    });

    it('finds a model another agent declared, for a run made with --model', () => {
        const picked = pickModel(
            config({
                agents: [
                    { name: 'lead', model: 'openai/gpt-5.6-sol' },
                    { name: 'scout', model: 'anthropic/claude-opus-5' },
                ],
            }),
            node,
            undefined,
        );

        expect(picked).toMatchObject({ ref: 'anthropic/claude-opus-5', from: 'project' });
    });

    it('matches an old run that sent a slash ref out whole', () => {
        const picked = pickModel(
            config({ model: 'openai/gpt-5-mini', agents: [{ name: 'default' }] }),
            { agent: 'default', model: 'openai/gpt-5-mini' },
            undefined,
        );

        expect(picked).toMatchObject({ ref: 'openai/gpt-5-mini', same: true, from: 'project' });
    });

    it('matches Claude on Vertex, which went out without its publisher', () => {
        const picked = pickModel(
            config({ model: 'vertex:anthropic/claude-opus-5', agents: [{ name: 'lead' }] }),
            node,
            undefined,
        );

        expect(picked).toMatchObject({ ref: 'vertex:anthropic/claude-opus-5', same: true });
    });

    it('builds the recorded ref when the project no longer declares it', () => {
        const picked = pickModel(
            config({ agents: [{ name: 'lead', model: 'openai/gpt-5.6-sol' }] }),
            { ...node, ref: 'anthropic/claude-opus-5' },
            undefined,
        );

        expect(picked).toEqual({
            ref: 'anthropic/claude-opus-5',
            label: 'anthropic/claude-opus-5',
            same: true,
            from: 'run',
        });
    });

    it('asks for --model when an old run used what the project no longer declares', () => {
        expect(() =>
            pickModel(
                config({ agents: [{ name: 'lead', model: 'openai/gpt-5.6-sol' }] }),
                node,
                undefined,
            ),
        ).toThrow(/claude-opus-5/);
    });
});

function text(req: ReturnType<typeof buildDiagnostic>): string {
    const last = req.messages.at(-1);
    const part = last?.role === 'user' ? last.content[0] : undefined;
    return part?.type === 'text' ? part.text : '';
}
