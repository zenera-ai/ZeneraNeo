# Running every model through a Bifrost gateway

[Bifrost](https://github.com/maximhq/bifrost) is an AI gateway: one endpoint and
one virtual key in front of every vendor, with budgets, rate limits, fallbacks
and logging on the gateway side. Zenera can send all of its model and embedding
traffic through it without a change to `agents.yaml`.

This is **gateway mode**. It is a property of the machine, not of the project:
the same project runs directly against the vendors on a laptop that holds vendor
keys, and through the gateway on a machine that holds only a virtual key.

## Turning it on

With the keyring:

```sh
zen key add bifrost --url https://bifrost.example.com   # prompts for the virtual key
zen key mode bifrost                                   # every run from now on
zen key check bifrost                                  # does the gateway accept it?
```

The key is never taken from the command line. Paste it at the echo-off prompt,
or pipe it in:

```sh
pbpaste | zen key add bifrost --url https://bifrost.example.com
```

Or with nothing but the environment - in a shell, CI, or the project's `.env`:

```sh
export BIFROST_BASE_URL=https://bifrost.example.com
export BIFROST_API_KEY=sk-bf-…
```

## Environment variables

| Variable           | Needed                                         | Value                                                                                                             |
| ------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `BIFROST_BASE_URL` | yes - **setting it is what turns the mode on** | The gateway **root**. No `/v1`, `/openai` or `/genai`: those are appended per request. A trailing `/` is dropped. |
| `BIFROST_API_KEY`  | when the gateway enforces virtual keys         | The virtual key (`sk-bf-…`)                                                                                       |

Vendor variables - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, … - are not read while
`BIFROST_BASE_URL` is set. In `bifrost` mode the keyring does not export them at
all.

As everywhere else in zen, a real environment variable wins over the keyring.
`zen key mode bifrost` exports both variables before a run; a `BIFROST_BASE_URL`
exported in a shell or a `.env` turns the mode on whatever the keyring says.

## What happens to a request

Each model keeps **its own vendor's SDK and wire format**, and is sent to the
gateway's matching drop-in endpoint instead of to the vendor:

| Kind in `agents.yaml`            | SDK                | Endpoint     | Model id on the wire |
| -------------------------------- | ------------------ | ------------ | -------------------- |
| `openai`, `openai-compatible`    | OpenAI             | `/openai`    | `openai/<id>`        |
| `anthropic`                      | Anthropic          | `/anthropic` | `anthropic/<id>`     |
| `google`                         | GenAI              | `/genai`     | `gemini/<id>`        |
| `vertex` (Gemini)                | GenAI (non-vertex) | `/genai`     | `vertex/<id>`        |
| `vertex` (Claude, `anthropic/…`) | Anthropic          | `/anthropic` | `vertex/claude-…`    |
| `openrouter`                     | OpenAI             | `/openai`    | `openrouter/<id>`    |

So `vertex/gemini-3.5-flash` goes out as a Gemini `generateContent` request to
`<url>/genai/v1beta/models/vertex/gemini-3.5-flash:generateContent`, carrying the
virtual key.

The protocol is kept on purpose. Bifrost's unified chat-completions endpoint
would work for every model, and would cost exactly what the native adapters are
there for: thinking budgets, Gemini thought signatures, cache accounting.

The details:

- **The model id is qualified on the wire only.** A model's `id`, the run
  trajectory, and an embedder's id keep the id written in `agents.yaml`. A
  memory and a rag index record the embedder id and refuse a different one, so
  switching modes must not change it - and does not.
- **Every provider is rerouted**, declared ones included. A provider's own
  `apiKey`, `baseURL` and `token` are set aside; its `headers`, `timeoutMs` and
  `maxRetries` are kept. Only a pre-built `client` (code only) stays where it is.
- **OpenRouter goes through the OpenAI endpoint**, since Bifrost has no
  OpenRouter drop-in. OpenRouter-only knobs (`routing`, `fallbacks`, `plugins`,
  `serviceTier`, …) are therefore a load error in this mode.
- **The key is sent twice**: as each SDK's own key header (`Authorization`,
  `x-api-key`, `x-goog-api-key`) and as `x-bf-vk`.
- **Embeddings go through the gateway too** - memory and `zen rag` included.
- **Retries are unchanged**: the transport still retries 408, 429 and 5xx;
  Bifrost's own fallbacks happen behind that.
- **Errors name the route**: a failure reads `vertex via bifrost …`, not just
  `vertex`.

## The sandbox

Both variables are passed into the sandbox container - the key as a secret, the
url as plain environment - so a `zen rag … search` run by an agent inside the
container goes through the gateway as well. The gateway must therefore be
reachable from the container: a `localhost` url on the host is not, and a
`network: none` sandbox reaches nothing.

## The CLI in gateway mode

### `zen key`

| Command                           | What it does                                                        |
| --------------------------------- | ------------------------------------------------------------------- |
| `zen key add bifrost --url <url>` | Stores the virtual key and the gateway url. `--url` is required     |
| `zen key mode [direct\|bifrost]`  | Bare: prints the mode. With a word: switches                        |
| `zen key check bifrost`           | `GET <url>/v1/models` with the key                                  |
| `zen key ls`                      | Shows the url in the `WHERE` column and a `mode bifrost` line       |
| `zen key env`                     | In `bifrost` mode, exports `BIFROST_API_KEY` and `BIFROST_BASE_URL` |

A `BIFROST_BASE_URL` in the environment puts all of these in `bifrost` mode with
an empty keyring, as it does a run: `mode` says it was set by the environment,
and `ls` and `check` list and probe `bifrost/$BIFROST_API_KEY` against that url.
`zen key mode direct` is saved but has no effect until the variable is unset.

Several gateway keys can be held at once (`zen key add bifrost/prod --url …`);
`zen key use bifrost/prod` picks the one runs use.

What `zen key check` reports:

| Gateway answer                                          | Verdict   | Meaning                                                        |
| ------------------------------------------------------- | --------- | -------------------------------------------------------------- |
| `200`                                                   | `live`    | The key works                                                  |
| `401`, `403` (`virtual_key_required`, `access_blocked`) | `dead`    | The key is missing, wrong, inactive or expired                 |
| `402` (`budget_exceeded`)                               | `blocked` | The key is fine; its budget is spent. A new key would not help |
| `404`, an html page                                     | `unknown` | The url is not the gateway root                                |
| no answer                                               | `unknown` | Network                                                        |

A plain `http://` url to anything but `localhost` is accepted with a warning:
the virtual key would cross the network unencrypted.

### `zen models`

In gateway mode every listing is **what the gateway serves**, not what the
vendors do - a run can reach nothing else:

- One `GET <url>/v1/models` covers every provider. Its `<upstream>/<id>` names
  are split back into refs: `vertex/gemini-3.5-flash` lists as itself - a ref
  _is_ the gateway's name for a model - and `gemini/…` as `google/…`.
- Upstreams no zen provider names (`bedrock`, `groq`, `azure`, …) are left out:
  no ref in `agents.yaml` could reach them.
- There is no built-in fallback list. If the gateway cannot be asked, the
  listing is empty and says why.
- Listings are cached per gateway url, separately from the vendor ones.
- `zen models` (the overview) and `browse` ask the gateway rather than reading
  the cache only - one request covers everything.
- Every command prints `⇄ bifrost mode only what <url> serves` on stderr;
  `browse` shows a `⇄ bifrost` badge on every screen; `--json` gains a
  `gateway` field.
- `zen models test <ref>` asks through the gateway.

### `zen check`

The credential audit reports `BIFROST_API_KEY`, not the vendor variables, as the
credential every model needs. The model probes go through the gateway.

## Turning it off

```sh
zen key mode direct
```

The vendor keys in the keyring are exported again from the next run. If
`BIFROST_BASE_URL` is exported in a shell or a `.env`, unset it there - the
environment wins over the keyring.

## Checking that thought signatures survive

Gemini 3 returns an opaque `thoughtSignature` with every function call and
refuses (`400`) a replayed call that lacks it. A gateway that converts requests
to its own format and back can drop it. A tool round trip that _succeeds_ does
not prove it was kept: the gateway could be replacing it with Google's
documented dummy value, or re-attaching it from a cache of its own.

1. **Is it returned?**

    ```sh
    curl -s "$BIFROST_BASE_URL/genai/v1beta/models/vertex/gemini-3.5-flash:generateContent" \
      -H "x-goog-api-key: $BIFROST_API_KEY" -H "x-bf-vk: $BIFROST_API_KEY" \
      -H 'content-type: application/json' \
      -d '{"contents":[{"role":"user","parts":[{"text":"Temperature in Lisbon?"}]}],
           "tools":[{"functionDeclarations":[{"name":"get_temperature",
             "parameters":{"type":"object","properties":{"city":{"type":"string"}}}}]}],
           "generationConfig":{"thinkingConfig":{"thinkingLevel":"low"}}}' \
      | jq '.candidates[0].content.parts[] | {functionCall, thoughtSignature}'
    ```

    A missing or null `thoughtSignature` beside the `functionCall` means it was
    dropped. Repeat against `:streamGenerateContent?alt=sse` and grep for it -
    zen streams, and a gateway can keep it on one path and lose it on the other.

2. **Is it forwarded?** Replay the second turn three times: with the real
   signature, with it removed, and with it altered. If the gateway forwards it,
   only the first succeeds. If the removed one also succeeds, the gateway is
   supplying a signature of its own. Run the same three directly against Vertex
   first, to confirm they are valid controls.

3. **What was actually sent?** `zen inspect node --part request` on an
   `llm_call` shows the signature zen sent; Bifrost's request log shows what it
   sent upstream.

## Known limits

- **Thought signature passthrough is not yet verified** against a live Bifrost.
  Run the check above before relying on Gemini 3 tool use through the gateway.
- **Gateways that use `Authorization` for login** (auth enabled on inference)
  are not supported as they are: the OpenAI SDK sends the virtual key as
  `Authorization: Bearer`, which such a gateway reads as a login. `x-bf-vk` is
  sent as well, but the conflicting header is not removed.
- **Upstreams without a zen provider** - Bedrock, Groq, Azure, … - cannot be
  named from `agents.yaml`, even though the gateway serves them.
- **Custom `openai-compatible` endpoints** (a vLLM, say) are rerouted as
  `openai/<id>`, which is the wrong upstream for them.
- **`zen meta`** wires copilot to a provider directly and does not go through
  the gateway.

## See also

- [Agent configuration - gateway mode](agents-yaml.md#gateway-mode-bifrost)
- [`zen key`](../packages/cli/templates/editor/.github/skills/zen-cli/references/keys.md)
- [`zen models`](../packages/cli/templates/editor/.github/skills/zen-cli/references/models.md)
