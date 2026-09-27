# omp-router

OhMyPi extension connecting to any OpenAI-compatible AI router (9router,
OmniRoute, yardmaster, …) via its `/v1` API: you add the router URL, its models
appear in omp, and omp's native usage surfaces report the upstream providers'
quotas as seen through the router.

Ported from `pi-router` + the pi-sub router adapter; the omp-native provider,
discovery, login, and usage seams replace pi's hand-rolled machinery.

## Quick start

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/code/omp-extensions/omp-router
```

Then in omp:

```
/router-url http://localhost:20128/v1   # store the endpoint
/login router                           # store the API key (masked prompt)
/router-model                           # browse/select a router model
```

The provider id is `router`; models show up as `router/<router-model-id>`.
Models are discovered from `GET <baseUrl>/models` with a 24 h host-side cache
(`omp models refresh` forces a pull).

## Configuration

Precedence: env > project (trusted repos only) > global.

| Source | Path / variable | Fields |
|--------|-----------------|--------|
| Env | `OMP_ROUTER_BASE_URL` / `ROUTER_BASE_URL`, `OMP_ROUTER_ENABLE_REASONING` / `ROUTER_ENABLE_REASONING` | baseUrl, enableReasoning |
| Project | `<cwd>/.omp/router.json` | `baseUrl`, `enableReasoning` — **ignored unless the repo is trusted** (an untrusted checkout must not redirect the endpoint your API key is sent to; `apiKey` in this file is always ignored) |
| Global | `~/.omp/agent/router.json` | `baseUrl`, `enableReasoning` (written by `/router-url` / `/router-reasoning`) |

The API key is **not** stored in these files: use `/login router` (or
`omp login router`), which stores it in omp's own credential store.

`ROUTER_API_KEY` / `OMP_ROUTER_API_KEY` env vars work as a fallback: discovery
sends them directly, and at session start the extension registers the env
value as an in-session auth override **only when no credential resolves at
all** — so a later `/login router` always wins from the next session on. Do
NOT pin the key under `providers.router.apiKey` in `models.yml`: that override
shadows the stored `/login` credential (omp's config layer beats stored
credentials), which manifests as requests signed with the literal config
string and, ultimately, no loadable models.

## Commands

| Command | Effect |
|---------|--------|
| `/router-url <url>` | Validate + store the endpoint, re-register the provider immediately |
| `/router-model [query]` | Fuzzy-search and select a router model |
| `/router-reasoning` | Toggle thinking-level support on router models |
| `/router-status` | Endpoint, masked key, catalog size, active upstream |
| `/router-usage` | Fetch and render the usage report right now |

## Usage reporting (upstream providers via the router)

The extension registers an omp-native usage provider, so per-credential
caching (5 min TTL), last-good retention, and history are handled by the host.
Two router flavors are supported, tried in order:

1. **Generic JSON** — `GET <baseUrl>/usage[?provider=<upstream>]`
   (`windows.session/weekly/monthly.remaining_pct` + `reset_at`,
   `credits.currency/balance`). Unknown upstream slugs 404 and fall back to
   the aggregate report.
2. **OmniRoute text** — `GET <origin>/api/usage/om-usage[?provider=]`
   ("Provider quota" Session/Weekly + "Personal quota" Daily/Weekly budgets;
   countdowns are converted to absolute reset timestamps). Credit-based
   upstreams (e.g. deepseek) report "Unavailable" windows; the raw USD balance
   is then fetched from the management API (`/api/v1/me/status` →
   `/api/usage/<connectionId>`, needs a `manage`-scope key or
   `ROUTER_MGMT_TOKEN`/`OMNIROUTE_MGMT_TOKEN`).

The `?provider=` slug is derived from the **active model id's first segment**,
so selecting `cmd/deepseek/deepseek-v4` reports the `command-code` upstream's
quota. Aliases normalize (`cmd`→`command-code`, `oc`→`opencode-go`,
`ds`→`deepseek`, `glmcn`→`glm-cn`); generic aliases (`auto`, `combo`, …) fall
back to the aggregate snapshot.

## Model mapping notes

- Curated context-window corrections (models.dev-verified) with 9router's
  default-floor de-poisoning: GLM-5.2/5.3 → 1M ctx, DeepSeek V4 → 1M,
  Kimi K3 → 1M, GLM-5.1/5/4.6/4.7 → 200k. Truthful above-floor router values
  are never overridden.
- Thinking efforts per detected family as omp `thinking` capability:
  deepseek/zai (GLM) → `high+max`, gemini-3 → `requiresEffort`, OpenAI →
  `minimal…xhigh`, claude-adaptive → `low…max`; command-code upstreams reject
  off/minimal (`requiresEffort`, no `minimal`).
- Vision: surgical transport-verified overrides/downgrades — the router's
  `capabilities.vision` flag is trusted only where proven (re-probe with
  upstream pi-router's `probe-vision.mjs` when your router image changes).
- `/router-reasoning off` drops thinking capability and
  `compat.supportsReasoningEffort` entirely.

## Development

```bash
npm install
npm run typecheck
npm test
```

`extensions/test/unit.test.ts` covers config precedence/trust gating, model
mapping, both usage flavors (mocked fetch), and the provider registration
contract.
