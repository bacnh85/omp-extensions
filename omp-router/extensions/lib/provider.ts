import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { RouterSettings } from "./config.js";
import { PROVIDER_ID } from "./config.js";
import { fetchModels, mapModel } from "./client.js";
import { createUsageProvider } from "./usage.js";

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
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: settings.baseUrl,
    // Env-name fallback; the /login-stored credential wins (host resolution
    // order). Without either, discovery runs keyless and only picks up
    // models the router exposes anonymously.
    apiKey: "ROUTER_API_KEY",
    api: "openai-completions",
    authHeader: true,
    fetchDynamicModels: async (apiKey) => {
      const raw = await fetchModels(settings, undefined, apiKey);
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
    usage: createUsageProvider(settings),
  } satisfies ProviderConfig);
}
