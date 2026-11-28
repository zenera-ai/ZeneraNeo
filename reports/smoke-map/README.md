## Problem

When running tests against `@zenera/faker` mock endpoints (`mail.yaml` and `calendar.yaml`), developers need a repeatable baseline to verify route availability, schema strictness, and status code responses.

## The improvement

Added an automated smoke-testing script (`reports/smoke-map/smoke.ts`) and a summary mapping report that exercises every operation across valid and negative scenarios using deterministic seed values (`--seed 42`).

## How I know

1. Started the local mock server:
   `zen faker serve examples/mock-apis/specs/*.yaml --seed 42 --port 8787`
2. Executed the test runner:
   `npx tsx reports/smoke-map/smoke.ts`
3. Confirmed test execution table and observed edge status behavior:

| Operation                | Request                                      | Expected | Actual | Notes                                                                                                                            |
| :----------------------- | :------------------------------------------- | :------: | :----: | :------------------------------------------------------------------------------------------------------------------------------- |
| `listMessages`           | `GET /users/me/messages?maxResults=5`        |   200    |  200   | Returns paginated list of message identifiers.                                                                                   |
| `getMessage`             | `GET /users/me/messages/msg_123`             |   200    |  501   | Surprise: Returns 501 Not Implemented. Generator failed at faker build time due to schema regex vs path parameter echo conflict. |
| `sendMessage`            | `POST /users/me/messages/send`               |   200    |  400   | Surprise: Mock server enforces strict payload schema validation, rejecting minimal/incomplete JSON bodies.                       |
| `listEvents`             | `GET /calendars/primary/events?maxResults=5` |   200    |  200   | Successfully returns calendar event list seeded deterministically.                                                               |
| `queryFreeBusy`          | `POST /freeBusy`                             |   200    |  200   | Processes date range inputs and returns mapped availability windows.                                                             |
| `invalidPath`            | `GET /users/me/non_existent_route`           |   404    |  404   | Gracefully returns clean 404 JSON response.                                                                                      |
| `sendMessageMissingBody` | `POST /users/me/messages/send (empty)`       |   400    |  400   | Empty JSON body triggers schema validation failure.                                                                              |

## What I decided not to do

- Did not modify the OpenAPI schema files (`mail.yaml`), treating them as immutable specifications.
- Did not write stateful persistence tests, as the mock server is designed to be stateless.

## Open questions

- The `GET /users/{userId}/messages/{id}` generator fails during `zen faker build` when mock parameter echoing (e.g., `id: "ada"`) conflicts with the schema's regex `pattern`. Should the generator fallback to valid regex-compliant mock values when parameter echoing is active?
