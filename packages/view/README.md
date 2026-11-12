<div align="center"> 
  <img
    src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/zenera-logo-with-media-queries.svg"
    alt="Zenera Logo"
    width="20"
  />
  <div>Powered By Zenera</div>
</div>
<br>

<div align="center">
  <img src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/banner-view-with-media-queries.svg" alt="ZENERA VIEW" width="747">

[![npm](https://img.shields.io/npm/v/@zenera/view.svg)](https://www.npmjs.com/package/@zenera/view)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zenera-ai/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml)

[Install](#install) · [Use](#use) · [How it works](#how-it-works) · [Safety](#safety) · [Family](#the-rest-of-the-family) · [License](#license)

</div>

# @zenera/view

**A live local viewer for a folder. Markdown with tables and Mermaid diagrams,
highlighted code, directory listings - redrawn in place as the files change.**

> Part of [ZeneraNeo](https://github.com/zenera-ai/ZeneraNeo). It ships with
> [`zen`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md)
> as the `view` **subcommand**, and works just as well as a library on its own.

## Why

Agents write reports, plans, traces and diagrams to disk, and keep rewriting
them while they work. `@zenera/view` turns that folder into a page you can leave
open: every change shows up within a second, with no reload, no lost scroll
position, and no flicker of diagrams that did not change.

- **Markdown as GitHub draws it** - GFM tables, task lists, heading anchors and
  [Mermaid](https://mermaid.js.org) diagrams.
- **Highlighted code** - `.json`, `.jsonl`, `.py`, `.ts`, `.yaml`, `.patch` and more.
- **Directories as listings**, so the whole tree is navigable from one page.
- **Everything else as is** - images, HTML and PDF are handed to the browser.
- **Live, minimal updates** - only the nodes that changed are repainted.
- **Local and offline** - loopback only, nothing fetched from the network.

## Install

Node.js 24+, ESM only. It comes with the CLI:

```sh
npm i -g @zenera/cli
```

or on its own, as a library:

```sh
npm i @zenera/view
```

## Use

### From the command line

```sh
zen view                              # this folder
zen view finetune/STATUS.md --open    # one file, opened in the browser
```

`zen view` serves until Ctrl-C and prints its address. `--port`, `--throttle`
and `--hidden` map to the options below; `zen view --help` has the details.

### From code

```ts
import { serveView } from '@zenera/view';

const server = await serveView({ root: './reports', start: '/STATUS.md' });
console.log(server.url); // http://127.0.0.1:<port>/STATUS.md
// ...
await server.close();
```

### Options

| option       | default                        | meaning                                     |
| ------------ | ------------------------------ | ------------------------------------------- |
| `root`       | -                              | the directory served; nothing outside it    |
| `port`       | derived from `root`, else free | a page left open reconnects after a restart |
| `start`      | `/`                            | the page `url` opens                        |
| `hidden`     | `false`                        | serve dotfiles; `.env`, `.git` never are    |
| `maxBytes`   | 2 MB                           | the most of one file rendered               |
| `maxClients` | 64                             | pages open at once                          |
| `throttleMs` | 1000                           | least time between two pushes of one path   |

## How it works

The server parses each file into a sanitized HTML syntax tree (remark + GFM for
markdown, lowlight for code). It pushes that tree to the page over server-sent
events, on connect and again whenever the file changes. The page is a small
React app that turns the tree into elements, so an update repaints only the
nodes that differ. Mermaid runs in the browser from the copy installed with
this package.

Files are watched through their directory, so a writer that replaces a file by
renaming a temporary file over it is still followed. A slow poll backs up
`fs.watch`. Each change is rendered once however many pages show the file, and
one path is pushed at most once per `throttleMs`.

## Safety

- Listens on `127.0.0.1` only, and answers only requests whose `Host` names it,
  so a web page cannot reach it through a DNS name pointed at loopback.
- Every path is resolved to a real path under the root; `..`, symlinks out of
  the root, dotfiles and secrets are refused.
- Markdown is sanitized and raw HTML in it is dropped; the page runs under a
  strict Content-Security-Policy. Files served as they are (HTML, SVG, …) carry
  a `sandbox` CSP, so they run - if at all - in an origin of their own.

## The rest of the family

| Package                                                                                    | What it is                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [`@zenera/cli`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md)   | `zen` - agent projects on the command line                    |
| [`@zenera/neo`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/neo/README.md)   | the runtime - agents, models, tools, skills, memory           |
| [`@zenera/meta`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/meta/README.md) | `zen meta` - the meta-agent that builds and tunes a project   |
| [`@zenera/gym`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/gym/README.md)   | `zen gym` - a mock API from an openapi/swagger document       |
| [`@zenera/rag`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/rag/README.md)   | `zen rag` - indexing and search for documents and API schemas |
| **`@zenera/view`**                                                                         | `zen view` - a live local viewer for a folder                 |

## License

Early days and moving fast - issues, questions and pull requests are welcome.
[MIT](LICENSE).
