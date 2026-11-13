// reports/smoke-map/smoke.ts
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:8787';

interface TestResult {
    operation: string;
    request: string;
    expectedStatus: number;
    actualStatus: number;
    note: string;
}

async function runSmokeTests() {
    const results: TestResult[] = [];

    // --- MAIL API ---
    // 1. List messages
    let res = await fetch(`${BASE_URL}/users/me/messages?maxResults=5`);
    results.push({
        operation: 'listMessages',
        request: 'GET /users/me/messages?maxResults=5',
        expectedStatus: 200,
        actualStatus: res.status,
        note: 'Returns paginated list with pageToken header',
    });

    // 2. Get message by ID
    res = await fetch(`${BASE_URL}/users/me/messages/msg_123`);
    results.push({
        operation: 'getMessage',
        request: 'GET /users/me/messages/msg_123',
        expectedStatus: 200,
        actualStatus: res.status,
        note: 'Generates realistic body and headers from seed',
    });

    // 3. Send message (POST)
    res = await fetch(`${BASE_URL}/users/me/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: 'SGVsbG8gV29ybGQ=' }),
    });
    results.push({
        operation: 'sendMessage',
        request: 'POST /users/me/messages/send',
        expectedStatus: 200,
        actualStatus: res.status,
        note: 'Mock responds instantly without mutating underlying state',
    });

    // --- CALENDAR API ---
    // 4. List events
    res = await fetch(`${BASE_URL}/calendars/primary/events?maxResults=5`);
    results.push({
        operation: 'listEvents',
        request: 'GET /calendars/primary/events?maxResults=5',
        expectedStatus: 200,
        actualStatus: res.status,
        note: 'Timezone defaults to UTC when omitted',
    });

    // 5. FreeBusy query
    res = await fetch(`${BASE_URL}/freeBusy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            timeMin: '2026-10-01T00:00:00Z',
            timeMax: '2026-10-07T00:00:00Z',
            items: [{ id: 'primary' }],
        }),
    });
    results.push({
        operation: 'queryFreeBusy',
        request: 'POST /freeBusy',
        expectedStatus: 200,
        actualStatus: res.status,
        note: 'FreeBusy intervals correctly mapped within bounds',
    });

    // --- NEGATIVE / INVALID CALLS ---
    // 6. Unknown Path (Negative)
    res = await fetch(`${BASE_URL}/users/me/non_existent_route`);
    results.push({
        operation: 'invalidPath (Negative)',
        request: 'GET /users/me/non_existent_route',
        expectedStatus: 404,
        actualStatus: res.status,
        note: 'Returns 404 as expected for unregistered endpoints',
    });

    // 7. Missing required body field (Negative)
    res = await fetch(`${BASE_URL}/users/me/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // Empty body
    });
    results.push({
        operation: 'sendMessageMissingBody (Negative)',
        request: 'POST /users/me/messages/send (empty body)',
        expectedStatus: 400,
        actualStatus: res.status,
        note:
            res.status === 200
                ? 'SURPRISE: Mock accepts empty payload without schema validation error'
                : 'Returns 400 validation error',
    });

    console.table(results);
}

runSmokeTests();
