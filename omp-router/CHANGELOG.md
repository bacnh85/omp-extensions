# Changelog

## 0.1.0 — 2026-09-27

Initial release.

- Router provider registration (`pi.registerProvider`): any OpenAI-compatible
  router endpoint with dynamic model discovery from `GET /v1/models`
  (host-side 24 h model cache; discovery capped at 15 s by omp).
- `/router-url <url>` to store the endpoint (`~/.omp/agent/router.json`,
  project `.omp/router.json` in trusted repos, `OMP_ROUTER_BASE_URL` /
  `ROUTER_BASE_URL` env override).
- `/login router` (and `omp login router`) via the provider's masked OAuth
  login prompt; `ROUTER_API_KEY` env as fallback.
- Model mapping ported from pi-router: curated context-window corrections
  (GLM-5.2/5.3 and DeepSeek V4 at 1M, Kimi K3 at 1M) with the 9router
  default-floor (200k/128k) de-poisoning rule; transport-verified vision
  overrides/downgrades; per-family thinking efforts as omp `thinking`
  capability (deepseek/zai `high+max`, gemini-3 `requiresEffort`,
  command-code upstreams reject off/minimal).
- Native usage provider: omp `UsageReport` fed from the router's generic
  `GET /v1/usage` JSON (yardmaster) or OmniRoute's
  `GET /api/usage/om-usage` text report with `?provider=<upstream>` selection
  driven by the active model id's first segment (`cmd` → `command-code`,
  `oc` → `opencode-go`, `ds` → `deepseek`, `glmcn` → `glm-cn`); credit-based
  upstream balances via the management API (`ROUTER_MGMT_TOKEN` override);
  per-credential caching/last-good/history handled by omp's AuthStorage.
- Commands: `/router-url`, `/router-model`, `/router-reasoning`,
  `/router-status`, `/router-usage`.
