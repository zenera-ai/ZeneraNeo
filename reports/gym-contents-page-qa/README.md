# Gym contents page: numeric input constraints

Scope: QA-5 exploratory pass over numeric Run-form fields, using the example calendar specification. Date: 2026-11-04. This is a focused fix and regression report, not full coverage of all operations or assistive technologies.

## Findings

### Fixed — P3 papercut: numeric constraints were not represented in the form

- **Steps:** Open `GET /users/{userId}/messages` → Run. Enter `me` for `userId` and `501` for `maxResults`; submit.
- **Expected:** Since the specification declares `maxResults` as an integer with minimum 1 and maximum 500, the input should communicate and enforce those constraints before making the request.
- **Before:** The dialog rendered it as a plain text input with only the placeholder `integer`. The browser considered `501` valid and sent the request. Gym correctly returned HTTP 400 with `query/maxResults must be <= 500`.
- **After:** Numeric parameters render as number inputs. Integer fields use step 1; number fields use their declared `multipleOf` or `any`. Inclusive `minimum` and `maximum` are reflected in native browser constraints. Required validation and server validation remain in place.
- **Severity:** P3 usability papercut. The backend already enforced its contract and gave a useful error; the UI now gives immediate feedback before making an avoidable request.
- **Evidence:** [maxresults-501.png](maxresults-501.png) captures the pre-fix rejection. `packages/gym/test/page.test.ts` exercises the generated form against the real calendar spec and checks lower/upper bounds, integer step, and a valid endpoint. The focused form/spec tests pass (32 tests); build and workspace typecheck pass.
- **Scope note:** The same form code uses text inputs for date-time fields; this pass did not obtain a reliable server response for an invalid date-time, so that is unverified and is not reported as a defect.

## Other checks that behaved as expected

- Leaving required `userId` empty triggers native required-field validation before a request is sent.
- `orderBy` in `GET /calendars/{calendarId}/events` is a select limited to `startTime` and `updated`.
- Server-side lower-bound, integer, and maximum validation responses were readable.

## Limits

One valid request accidentally triggered first-use handler generation. The configured OpenAI credential returned an exhausted-credit error and produced no handler. The server remains stopped; no further valid requests were made. Therefore, prefilled request bodies, successful generated responses, and broader interaction/accessibility behavior remain unverified. This report covers the focused numeric form issue and its local regression check only.
