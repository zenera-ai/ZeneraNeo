# @zenera/browser

An html page in a real browser, served as a zen chat serves it: checked for errors, driven,
photographed. It is what `zen page` (in [`@zenera/cli`](../cli)) runs on, and what agents' browser
tools will run on.

- **`PageHost`** answers a local page's requests with `@zenera/engine`'s `serveViewPath`, the code
  behind a chat's `/v/` pages: its files under the view CSP, its `*.api.py` functions run in a
  `ProcessSandbox`. No port: an in-process server on a private Unix socket.
- **`PageSession`** is one tab: in a remote browser when `ZEN_BROWSER_URL` names one (a Playwright
  `run-server` at `ws://…`, or a DevTools endpoint at `http://…`), else in a local headless
  Chromium. It routes the page's requests (its own files, three CDNs, nothing else), waits for
  the page to settle, collects what went wrong, and takes snapshots with refs and screenshots.
- **`checkPage`** loads a page once and reports errors, failed function calls and sideways
  scrolling, with screenshots at the chat panel's width, a wide one and dark.
- **`WIDTH_PRESETS`** are the widths a page is looked at: `panel` 400, `wide-panel` 640, `tab`
  1280, one on each side of the kit's layout breakpoints. Screenshots are cut at `SHOT_HEIGHT`
  (1600 px), or split into parts, so a model can still read them.
- **`resolveTarget`** turns a page folder, an html file or a URL into the pages and the files
  they are served from; **`installBrowser`** fetches the headless Chromium.

```ts
import {
    checkPage,
    DEFAULT_WIDTHS,
    PageHost,
    PageSession,
    pythonPath,
    resolveTarget,
} from '@zenera/browser';

const target = resolveTarget('/workspace/pages/todo', process.cwd());
const host = await PageHost.start({ trees: target.trees!, pythonPath: pythonPath() });
const session = await PageSession.open(host);
const report = await checkPage(session, target.pages[0]!, {
    widths: [...DEFAULT_WIDTHS],
    dark: true,
    outDir: target.outDir,
    timeoutMs: 15_000,
});
await session.close();
await host.close();
```

The Playwright version is pinned and must match the browser the sandbox base image carries
(`PLAYWRIGHT_VERSION` in `@zenera/sandbox`; a test keeps them equal).
