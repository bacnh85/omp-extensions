import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { RouterSettings } from "./config.js";
import { PROVIDER_ID } from "./config.js";
import { fetchModels, mapModel } from "./client.js";
import { createUsageProvider } from "./usage.js";

/** omp's chat transport posts to `{baseUrl}/chat/completions` verbatim, while
 *  discovery (`fetchModels`) injects `/v1` when the configured URL omits it.
 *  A URL stored without `/v1` (e.g. `https://yardmaster.bacnh.com`) therefore
 *  discovers models fine but chats into the router's web SPA — 200 HTML, zero
 *  SSE events, and omp retries an "empty stop" until it gives up. Normalize
 *  once here so chat, discovery, and usage share the same `/v1`-suffixed
 *  base. Idempotent for URLs that already carry it. */
export function withV1(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Register (or replace) the router provider:
 *
 *  - Models: `fetchDynamicModels` pulls `GET /v1/models` and maps each entry
 *    to an omp model. The host runs this through its shared SQLite model
 *    cache (24 h TTL) and treats the result as authoritative — no extension
 *    side persistence needed (pi-router's models-store.json machinery is
 *    omp core behavior here).
 *  - Auth: the stored `/login router` credential (an API key captured through
 *    the masked `oauth.login` prompt below) resolves ahead of the
 *    ROUTER_API_KEY env fallback via the host's normal auth order.
 *  - Usage: native UsageProvider — omp's AuthStorage caches the report
 *    (5-min TTL + last-good retention), records history, and renders it in
 *    its usage surfaces like any built-in provider. */
export function registerRouterProvider(pi: ExtensionAPI, settings: RouterSettings): void {
  const baseUrl = withV1(settings.baseUrl);
  pi.registerProvider(PROVIDER_ID, {
    baseUrl,
    // NOTE: do NOT set `apiKey` here. It acts as a models.yml-style config
    // override (resolution layer 2) and would shadow the stored `/login
    // router` credential (layers 3/4) — a literal/env-name string went out
    // as `Authorization: Bearer ROUTER_API_KEY` and broke auth entirely.
    // With it omitted, the host resolves the stored login credential, then
    // the ROUTER_API_KEY env var (verified empirically; see README).
    api: "openai-completions",
    authHeader: true,
    fetchDynamicModels: async (apiKey) => {
      const raw = await fetchModels({ ...settings, baseUrl }, undefined, apiKey);
      return raw.map((m) => mapModel(m, settings.enableReasoning));
    },
    oauth: {
      name: "Router (OpenAI-compatible)",
      login: async (callbacks) => {
        const key = await callbacks.onPrompt({
          message: "Router API key",
          placeholder: "sk-…",
          secret: true,
        });
        const trimmed = (key ?? "").trim();
        if (!trimmed) throw new Error("Router login cancelled — no API key entered.");
        return trimmed;
      },
    },
    usage: createUsageProvider({ ...settings, baseUrl }),
  } satisfies ProviderConfig);
}
