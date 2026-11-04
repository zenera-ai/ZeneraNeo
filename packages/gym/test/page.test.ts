// jsdom is already a workspace dev dependency but does not ship TypeScript types.
// @ts-expect-error jsdom provides the runtime used for this browser-form test.
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadSpec } from '../src/spec.ts';
import { indexPage } from '../src/page.ts';

describe('Gym contents page parameter forms', () => {
    it('uses the numeric schema bounds and integer step in the browser form', async () => {
        const specPath = fileURLToPath(
            new URL('../../../examples/mock-apis/specs/calendar.yaml', import.meta.url),
        );
        const operations = await loadSpec(specPath);
        const operationIndex = operations.findIndex(
            (operation) => operation.operationId === 'listEvents',
        );
        expect(operationIndex).toBeGreaterThanOrEqual(0);

        const fetch = vi.fn();
        const dom = new JSDOM(indexPage(operations), {
            runScripts: 'dangerously',
            url: 'http://gym.test/',
            beforeParse(window: { fetch: typeof fetch }) {
                window.fetch = fetch;
            },
        });
        try {
            const dialog = dom.window.document.querySelector('dialog')!;
            Object.defineProperty(dialog, 'showModal', {
                value: () => dialog.setAttribute('open', ''),
            });
            const run = dom.window.document.querySelector<HTMLButtonElement>(
                `button.try[data-op="${operationIndex}"]`,
            )!;
            run.click();

            const calendarId = dom.window.document.querySelector<HTMLInputElement>(
                'input[name="path:calendarId"]',
            )!;
            const maxResults = dom.window.document.querySelector<HTMLInputElement>(
                'input[name="query:maxResults"]',
            )!;
            calendarId.value = 'primary';

            expect(maxResults.type).toBe('number');
            expect(maxResults.min).toBe('1');
            expect(maxResults.max).toBe('2500');
            expect(maxResults.step).toBe('1');

            maxResults.value = '0';
            expect(maxResults.validity.rangeUnderflow).toBe(true);
            maxResults.value = '2501';
            expect(maxResults.validity.rangeOverflow).toBe(true);
            maxResults.value = '1.5';
            expect(maxResults.validity.stepMismatch).toBe(true);
            maxResults.value = '2500';
            expect(maxResults.checkValidity()).toBe(true);
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            dom.window.close();
        }
    });
});
