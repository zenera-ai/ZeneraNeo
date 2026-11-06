import { describe, expect, it } from 'vitest';
import { parseA2ui } from '../src/a2ui.ts';

const create = {
    version: 'v0.9',
    createSurface: {
        surfaceId: 'main',
        catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
    },
};
const update = {
    version: 'v0.9',
    updateComponents: {
        surfaceId: 'main',
        components: [{ id: 'root', component: 'Text', text: 'Hello' }],
    },
};

describe('parseA2ui', () => {
    it('reads a bare array of messages', () => {
        expect(parseA2ui(JSON.stringify([create, update]))).toEqual([create, update]);
    });

    it('reads pretty-printed output with surrounding whitespace', () => {
        expect(parseA2ui(`\n  ${JSON.stringify([create, update], null, 2)}\n`)).toHaveLength(2);
    });

    it('reads one message and the { messages } envelope', () => {
        expect(parseA2ui(JSON.stringify(create))).toEqual([create]);
        expect(parseA2ui(JSON.stringify({ messages: [create, update] }))).toEqual([create, update]);
    });

    it('unwraps a single code fence', () => {
        const json = JSON.stringify([create, update], null, 2);
        expect(parseA2ui('```json\n' + json + '\n```')).toHaveLength(2);
        expect(parseA2ui('```\n' + json + '\n```')).toHaveLength(2);
    });

    it('leaves prose, including prose that holds JSON, alone', () => {
        expect(parseA2ui('Here is the form:\n' + JSON.stringify([create, update]))).toBeUndefined();
        expect(parseA2ui('# Answer\n\nDone.')).toBeUndefined();
        expect(parseA2ui('')).toBeUndefined();
    });

    it('leaves JSON of another shape alone', () => {
        expect(parseA2ui('[]')).toBeUndefined();
        expect(parseA2ui('{"answer": 42}')).toBeUndefined();
        expect(parseA2ui('[1, 2, 3]')).toBeUndefined();
        expect(parseA2ui('null')).toBeUndefined();
        expect(parseA2ui('[{"version":"v0.9"}]')).toBeUndefined();
        expect(parseA2ui('{ not json')).toBeUndefined();
    });

    it('refuses other protocol versions and mixed arrays', () => {
        expect(parseA2ui(JSON.stringify([{ ...create, version: 'v0.8' }]))).toBeUndefined();
        expect(parseA2ui(JSON.stringify([create, { note: 'hi' }]))).toBeUndefined();
    });

    it('accepts v0.9.1, which the renderer also speaks', () => {
        expect(parseA2ui(JSON.stringify([{ ...create, version: 'v0.9.1' }]))).toHaveLength(1);
    });
});
