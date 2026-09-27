import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  PROVIDER_ID,
  configSummary,
  envApiKey,
  getSettings,
  globalConfigPath,
  maskApiKey,
  normalizeUrl,
  writeGlobalSettings,
} from "./lib/config.js";
import { applyReasoning } from "./lib/client.js";
import { registerRouterProvider } from "./lib/provider.js";
import { createUsageProvider, routerUpstreamPrefix, setUpstreamResolver } from "./lib/usage.js";

/** Re-select the active router model so omp picks up refreshed capability
 *  flags (e.g. thinking efforts after a /router-reasoning toggle). Errors are
 *  swallowed: missing auth or a mid-refresh registry must never break the
 *  session start path. */
async function refreshActiveModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const active = ctx.model;
  if (active?.provider !== PROVIDER_ID || !active.id) return;
  const refreshed = ctx.modelRegistry.find(PROVIDER_ID, active.id);
  if (!refreshed) return;
  try {
    await pi.setModel(refreshed);
  } catch { /* missing auth — ignore */ }
}

/** Masked presence of the resolvable router key (stored /login credential or
 *  env) for status display. Never returns the raw key to the UI. */
async function resolvedKeyMask(ctx: ExtensionContext): Promise<string> {
  if (envApiKey()) return maskApiKey(envApiKey()) + " (env)";
  try {
    const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
    return maskApiKey(key ?? undefined);
  } catch {
    return "(not set)";
  }
}

function httpUrl(value: string): string | undefined {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? normalizeUrl(value) : undefined;
  } catch {
    return undefined;
  }
}

function registerCommands(pi: ExtensionAPI): void {
  // Model list from the last /router-model invocation — the completion hook
  // has no ctx, so it replays this cache (empty until first use).
  let lastRouterModelIds: string[] = [];

  pi.registerCommand("router-url", {
    description: "Set the router base URL (OpenAI-compatible /v1 endpoint).",
    handler: async (args, ctx) => {
      const current = getSettings({ trustProject: ctx.isProjectTrusted() });
      let raw = String(args ?? "").trim();
      if (!raw) {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify(
            `Usage: /router-url <base-url> — current: ${current.baseUrl || "(not configured)"}`,
            "info",
          );
          return;
        }
        raw = (await ctx.ui.input(
          "Router base URL (OpenAI-compatible, conventionally ending in /v1)",
          current.baseUrl || "http://localhost:20128/v1",
        )) ?? "";
      }
      raw = raw.trim();
      const url = httpUrl(raw);
      if (!url) {
        ctx.ui.notify(`Not a valid http(s) URL: "${raw}".`, "error");
        return;
      }
      writeGlobalSettings({ baseUrl: url });
      const updated = getSettings({ trustProject: ctx.isProjectTrusted() });
      registerRouterProvider(pi, updated);
      ctx.ui.notify(
        `Router endpoint saved: ${url}\n` +
        (envApiKey() || (await resolvedKeyMask(ctx)) !== "(not set)"
          ? "Models refresh from <url>/v1/models (24h cache — /router-model to browse)."
          : "Now store the key: /login router (or set OMP_ROUTER_API_KEY)."),
        "info",
      );
    },
  });

  pi.registerCommand("router-reasoning", {
    description: "Toggle thinking-level support on router models.",
    handler: async (_args, ctx) => {
      const current = getSettings({ trustProject: ctx.isProjectTrusted() });
      if (!current.baseUrl) {
        ctx.ui.notify("router not configured — run /router-url first.", "error");
        return;
      }
      const next = !current.enableReasoning;
      writeGlobalSettings({ enableReasoning: next });
      registerRouterProvider(pi, { ...current, enableReasoning: next });
      await refreshActiveModel(pi, ctx);
      // Report the EFFECTIVE flag — env/project precedence can shadow the
      // persisted value.
      const effective = getSettings({ trustProject: ctx.isProjectTrusted() }).enableReasoning;
      ctx.ui.notify(
        effective === next
          ? `router reasoning ${next ? "ENABLED" : "DISABLED"} — use :high/:max model suffixes for thinking levels.`
          : `saved ${String(next)} to ${globalConfigPath()}, but an env/project override keeps it ${String(effective)}.`,
        "info",
      );
    },
  });

  pi.registerCommand("router-model", {
    description: "Search and select a router model by name.",
    getArgumentCompletions: (prefix) => {
      const q = (prefix || "").trim().toLowerCase();
      const items = lastRouterModelIds
        .filter((id) => id.toLowerCase().includes(q))
        .map((id) => ({ value: id, label: id }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const ids = ctx.modelRegistry
        .getAll()
        .filter((m) => m.provider === PROVIDER_ID)
        .map((m) => m.id);
      lastRouterModelIds = ids;
      if (ids.length === 0) {
        ctx.ui.notify(
          "No router models available yet — /router-url to configure the endpoint, /login router for the key.",
          "error",
        );
        return;
      }
      const term = (args || "").trim().toLowerCase();
      const matches = term ? ids.filter((id) => id.toLowerCase().includes(term)) : ids;
      if (matches.length === 0) {
        ctx.ui.notify(`No router models matching "${args}".`, "error");
        return;
      }
      async function trySelect(id: string): Promise<boolean> {
        const model = ctx.modelRegistry.find(PROVIDER_ID, id);
        if (!model) return false;
        try {
          await pi.setModel(model);
          return true;
        } catch {
          return false;
        }
      }
      if (matches.length === 1) {
        const ok = await trySelect(matches[0]);
        ctx.ui.notify(
          ok ? `Selected ${PROVIDER_ID}/${matches[0]}` : `Failed to select ${PROVIDER_ID}/${matches[0]}`,
          ok ? "info" : "error",
        );
        return;
      }
      const choice = await ctx.ui.select("Select router model:", matches.map((id) => ({ value: id, label: id })));
      if (choice) {
        const ok = await trySelect(choice);
        ctx.ui.notify(
          ok ? `Selected ${PROVIDER_ID}/${choice}` : `Failed to select ${PROVIDER_ID}/${choice}`,
          ok ? "info" : "error",
        );
      }
    },
  });

  pi.registerCommand("router-status", {
    description: "Show router connection status and model info.",
    handler: async (_args, ctx) => {
      const settings = getSettings({ trustProject: ctx.isProjectTrusted() });
      const count = ctx.modelRegistry
        .getAll()
        .filter((m) => m.provider === PROVIDER_ID).length;
      const upstream = routerUpstreamPrefix(ctx.model);
      const lines = [
        "── Router Status ──",
        configSummary(settings, await resolvedKeyMask(ctx)),
        `Models in catalog: ${count}`,
        ...(upstream ? [`Active model upstream: ${upstream}`] : []),
        "",
        "Commands:",
        "  /router-url <url>   Set the endpoint",
        "  /login router       Store the API key",
        "  /router-model       Search and select a model",
        "  /router-reasoning   Toggle thinking levels",
        "  /router-usage       Show upstream usage now",
        "",
        `Config: ${globalConfigPath()} (or .omp/router.json in a trusted repo, or OMP_ROUTER_BASE_URL).`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("router-usage", {
    description: "Fetch and show router / upstream-provider usage.",
    handler: async (_args, ctx) => {
      const settings = getSettings({ trustProject: ctx.isProjectTrusted() });
      if (!settings.baseUrl) {
        ctx.ui.notify("router not configured — run /router-url first.", "error");
        return;
      }
      let key: string | undefined;
      try {
        key = (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID)) ?? envApiKey();
      } catch {
        key = envApiKey();
      }
      if (!key) {
        ctx.ui.notify("No router API key — /login router first.", "error");
        return;
      }
      const provider = createUsageProvider(settings);
      ctx.ui.setWorkingMessage("fetching router usage…");
      let report;
      try {
        report = await provider.fetchUsage(
          { provider: PROVIDER_ID, credential: { type: "api_key", apiKey: key } },
          { fetch },
        );
      } catch (error) {
        ctx.ui.notify(`router usage fetch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      } finally {
        ctx.ui.setWorkingMessage();
      }
      if (!report || report.limits.length === 0) {
        const notes = report?.notes?.length ? `\n${report.notes.join("\n")}` : "";
        ctx.ui.notify(
          `No usage data for ${settings.baseUrl}` +
          (routerUpstreamPrefix(ctx.model) ? ` (upstream ${routerUpstreamPrefix(ctx.model)})` : "") +
          notes,
          "info",
        );
        return;
      }
      const lines = ["── Router Usage ──"];
      if (report.metadata?.upstream) lines.push(`Upstream: ${String(report.metadata.upstream)}`);
      for (const limit of report.limits) {
        const amount = limit.amount;
        const pct = amount.remainingFraction !== undefined
          ? ` ${Math.round((1 - amount.remainingFraction) * 100)}% used`
          : "";
        const resets = limit.window?.resetsAt
          ? ` · resets ${new Date(limit.window.resetsAt).toLocaleString()}`
          : "";
        const status = limit.status && limit.status !== "ok" ? ` [${limit.status}]` : "";
        lines.push(
          `  ${limit.label}: ${amount.remaining ?? "?"}${amount.unit === "percent" ? "%" : ""}${pct}${resets}${status}`,
        );
      }
      if (report.notes?.length) lines.push("", ...report.notes.map((n) => `  ℹ ${n}`));
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  // Base URL the currently-registered provider was built with — session_start
  // compares against it to detect a trust-gated repo override.
  let registeredBaseUrl = "";

  // Load-time settings: env + global ONLY (no project scope — no ctx/trust
  // yet, and an untrusted checkout must not own the endpoint the auth key
  // goes to).
  const loadSettings = getSettings();
  registeredBaseUrl = loadSettings.baseUrl;
  if (loadSettings.baseUrl) {
    registerRouterProvider(pi, loadSettings);
  }

  registerCommands(pi);

  // Per-upstream selection for the usage provider follows the live session
  // model (first id segment = OmniRoute upstream connection).
  let activeCtx: ExtensionContext | undefined;
  setUpstreamResolver(() => routerUpstreamPrefix(activeCtx?.model));

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    // Trust-gate the project scope: a trusted repo may add/override the
    // endpoint via .omp/router.json; an untrusted one is ignored
    // (attacker-redirect guard — the stored key is sent there as Bearer).
    const s = getSettings({ trustProject: ctx.isProjectTrusted() });
    if (!s.baseUrl) {
      ctx.ui.notify(
        "router provider not configured — run /router-url <base-url>, or set OMP_ROUTER_BASE_URL.",
        "warning",
      );
      return;
    }
    // Project scope flipped the endpoint: re-register exactly like the
    // /router-url save path so discovery/chat hit the new URL.
    if (s.baseUrl !== registeredBaseUrl) {
      registeredBaseUrl = s.baseUrl;
      registerRouterProvider(pi, s);
    }
    await refreshActiveModel(pi, ctx);
  });

  pi.on("session_shutdown", () => {
    activeCtx = undefined;
  });
}

// Re-exports for tests and downstream consumers.
export { applyReasoning };
export type { ExtensionCommandContext };
