import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, writeGlobalSettings, maskApiKey } from "../lib/config.js";
// Value import: Effort is a const enum with a real runtime module.
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { fetchModels, mapModel, applyReasoning, type RouterModel } from "../lib/client.js";
import {
  parseGenericUsage,
  parseOmniUsageText,
  routerUpstreamPrefix,
  providerQuotaSection,
  buildUsageReport,
  createUsageProvider,
  setUpstreamResolver,
} from "../lib/usage.js";
import { registerRouterProvider } from "../lib/provider.js";

// ── Isolation ────────────────────────────────────────────────────────────────
// Point PI_CODING_AGENT_DIR at a temp dir so tests never touch the user's live
// ~/.omp/agent (router.json / auth store). Static imports are safe: no module
// in this package reads env or files at import time, only at call time.
const TMP_HOME = join(tmpdir(), "omp-router-test-" + process.pid);
before(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = TMP_HOME;
});
after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── config ───────────────────────────────────────────────────────────────────

describe("config", () => {
  const configPath = () => join(TMP_HOME, "router.json");

  function writeConfig(json: unknown): void {
    writeFileSync(configPath(), JSON.stringify(json));
  }

  it("getSettings reads baseUrl from global router.json and normalizes it", () => {
    try { unlinkSync(configPath()); } catch { /* ignore */ }
    writeConfig({ baseUrl: "http://localhost:20128/v1/", enableReasoning: false });
    const s = getSettings();
    assert.equal(s.baseUrl, "http://localhost:20128/v1"); // normalized
    assert.equal(s.enableReasoning, false);
  });

  it("defaults when no config exists", () => {
    try { unlinkSync(configPath()); } catch { /* ignore */ }
    const s = getSettings();
    assert.equal(s.baseUrl, "");
    assert.equal(s.enableReasoning, true);
  });

  it("env overrides config; malformed JSON config is ignored", () => {
    writeFileSync(configPath(), "{not json");
    process.env.OMP_ROUTER_BASE_URL = "http://from-env/";
    try {
      assert.equal(getSettings().baseUrl, "http://from-env");
    } finally {
      delete process.env.OMP_ROUTER_BASE_URL;
    }
  });

  it("ROUTER_BASE_URL is the pi-parity fallback for OMP_ROUTER_BASE_URL", () => {
    process.env.ROUTER_BASE_URL = "http://legacy-env/v1";
    try {
      assert.equal(getSettings().baseUrl, "http://legacy-env/v1");
    } finally {
      delete process.env.ROUTER_BASE_URL;
    }
  });

  it("project .omp/router.json applies only with trustProject", () => {
    try { unlinkSync(configPath()); } catch { /* ignore */ }
    const repoPath = join(process.cwd(), ".omp", "router.json");
    mkdirSync(join(process.cwd(), ".omp"), { recursive: true });
    writeFileSync(repoPath, JSON.stringify({ baseUrl: "http://repo-scope/v1", enableReasoning: false }));
    try {
      assert.equal(getSettings().baseUrl, ""); // untrusted → ignored
      const trusted = getSettings({ trustProject: true });
      assert.equal(trusted.baseUrl, "http://repo-scope/v1");
      assert.equal(trusted.enableReasoning, false);
    } finally {
      unlinkSync(repoPath);
    }
  });

  it("project apiKey is never read (secrets stay out of checked-in files)", () => {
    const repoPath = join(process.cwd(), ".omp", "router.json");
    mkdirSync(join(process.cwd(), ".omp"), { recursive: true });
    writeFileSync(repoPath, JSON.stringify({ apiKey: "sk-leak" }));
    try {
      assert.equal("apiKey" in getSettings({ trustProject: true }), false);
    } finally {
      unlinkSync(repoPath);
    }
  });

  it("writeGlobalSettings merges without clobbering sibling keys (atomic file)", () => {
    writeConfig({ baseUrl: "http://a/v1", other: { keep: true } });
    writeGlobalSettings({ enableReasoning: false });
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    assert.deepEqual(raw.other, { keep: true });
    assert.equal(raw.enableReasoning, false);
    assert.equal(getSettings().baseUrl, "http://a/v1");
    assert.equal(existsSync(configPath() + ".tmp"), false, "no tmp leftover");
  });

  it("maskApiKey never reveals a full key", () => {
    assert.equal(maskApiKey(undefined), "(not set)");
    assert.equal(maskApiKey("short"), "(5 chars)");
    const masked = maskApiKey("sk-1234567890abcdef");
    assert.ok(masked.startsWith("sk-1"));
    assert.ok(masked.endsWith("cdef"));
    assert.ok(!masked.includes("234567890ab"));
  });
});

// ── client: model mapping ────────────────────────────────────────────────────

/** compat is a per-api union on ProviderModelConfig; router models always
 *  carry the OpenAI-compat member (thinkingFormat is its discriminator). */
type OpenAICompatView = Extract<RouterModel["compat"], { thinkingFormat?: unknown }>;
const oc = (m: RouterModel): OpenAICompatView => m.compat as OpenAICompatView;

describe("client mapModel", () => {
  it("maps a plain model with fallback context/output and no vision", () => {
    const m = mapModel({ id: "some-model" }, true);
    assert.equal(m.id, "some-model");
    assert.equal(m.contextWindow, 128_000);
    assert.equal(m.maxTokens, 4_096);
    assert.deepEqual(m.input, ["text"]);
    assert.equal(m.reasoning, true);
    assert.deepEqual(m.thinking, { mode: "effort", efforts: ["minimal", "low", "medium", "high", "xhigh"] });
    assert.equal(oc(m).thinkingFormat, "openai");
    assert.equal(oc(m).maxTokensField, "max_tokens");
  });

  it("deepseek gets the hiMax effort set (high, max)", () => {
    const m = mapModel({ id: "ds/deepseek/deepseek-v4" }, true);
    assert.deepEqual(m.thinking?.efforts, ["high", "max"]);
  });

  it("zai (GLM) maps to the single thinking-on tier + max", () => {
    const m = mapModel({ id: "glm-cn/glm-5.2" }, true);
    assert.deepEqual(m.thinking?.efforts, ["high", "max"]);
  });

  it("gemini-3 requires effort (no disable), minimal allowed", () => {
    const m = mapModel({ id: "oc/google/gemini-3.7-flash" }, true);
    assert.deepEqual(m.thinking?.efforts, ["minimal", "low", "medium", "high"]);
    assert.equal(m.thinking?.requiresEffort, true);
  });

  it("command-code upstreams reject off/minimal (requiresEffort, no minimal)", () => {
    const m = mapModel({ id: "command-code/deepseek/deepseek-v4" }, true);
    assert.deepEqual(m.thinking?.efforts, ["high", "max"]);
    assert.equal(m.thinking?.requiresEffort, true);
    const cmd = mapModel({ id: "cmd/google/gemini-3.7-flash" }, true);
    assert.equal(cmd.thinking?.efforts.includes(Effort.Minimal), false);
    assert.equal(cmd.thinking?.requiresEffort, true);
  });

  it("enableReasoning=false strips thinking + reasoning flags", () => {
    const m = mapModel({ id: "glm-cn/glm-5.2" }, false);
    assert.equal(m.reasoning, false);
    assert.equal(m.thinking, undefined);
    assert.equal(oc(m).supportsReasoningEffort, false);
  });

  it("applyReasoning re-maps without refetching", () => {
    const off = mapModel({ id: "kimi/kimi-k3" }, false);
    const on = applyReasoning(off, true);
    assert.equal(on.reasoning, true);
    assert.deepEqual(on.thinking?.efforts, ["low", "medium", "high", "max"]);
    assert.equal(oc(on).supportsReasoningEffort, true);
  });

  it("numeric strings parse as context/max values", () => {
    const m = mapModel({ id: "x", context_length: "1048576", max_output_tokens: "131072" }, true);
    assert.equal(m.contextWindow, 1_048_576);
    assert.equal(m.maxTokens, 131_072);
  });

  it("default-floor pair stamp is de-poisoned by the curated override", () => {
    // glm-5.3 stamped with the 200000/128000 router default floor → override to 1M/131072.
    const m = mapModel({ id: "glm-cn/glm-5.3", context_length: 200_000, max_output_tokens: 128_000 }, true);
    assert.equal(m.contextWindow, 1_000_000);
    assert.equal(m.maxTokens, 131_072);
    // Truthful above-floor value is never overridden.
    const truthy = mapModel({ id: "openrouter/z-ai/glm-5.2:free", context_length: 256_000, max_output_tokens: 128_000 }, true);
    assert.equal(truthy.contextWindow, 256_000);
  });

  it("vision: override wins, openrouter downgrade wins over metadata", () => {
    const ov = mapModel({ id: "cmd/google/gemini-3.7-flash", capabilities: {} }, true);
    assert.deepEqual(ov.input, ["text", "image"]); // metadata absent → override
    const down = mapModel({ id: "openrouter/z-ai/glm-5.3-flash", capabilities: { vision: true } }, true);
    assert.deepEqual(down.input, ["text"]); // metadata lie → downgraded
  });

  it("combo models get the shuffle prefix", () => {
    const m = mapModel({ id: "combo/glm-5.3-flash", owned_by: "combo" }, true);
    assert.equal(m.name, "🔀 combo/glm-5.3-flash");
  });
});

// ── client: fetchModels URL handling ─────────────────────────────────────────

describe("client fetchModels", () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];

  after(() => { globalThis.fetch = realFetch; });

  it("appends /models to /v1 baseUrl, injects /v1 when missing", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as Response;
    }) as typeof fetch;
    await fetchModels({ baseUrl: "http://h:20128/v1", enableReasoning: true });
    await fetchModels({ baseUrl: "http://h:20128", enableReasoning: true });
    assert.deepEqual(calls, ["http://h:20128/v1/models", "http://h:20128/v1/models"]);
  });

  it("env key is sent as Bearer when no discovery key is passed", async () => {
    let auth: string | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ data: [] }), { status: 200 }) as unknown as Response;
    }) as typeof fetch;
    process.env.ROUTER_API_KEY = "sk-env-test";
    try {
      await fetchModels({ baseUrl: "http://h/v1", enableReasoning: true });
      assert.equal(auth, "Bearer sk-env-test");
    } finally {
      delete process.env.ROUTER_API_KEY;
    }
  });

  it("non-OK response throws with status + body excerpt", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 502 }) as unknown as Response) as typeof fetch;
    await assert.rejects(
      () => fetchModels({ baseUrl: "http://h/v1", enableReasoning: true }),
      /502/,
    );
  });
});

// ── usage parsers ────────────────────────────────────────────────────────────

describe("usage parsers", () => {
  it("generic JSON: windows + credits parse; nothing usable → {}", () => {
    const g = parseGenericUsage({
      windows: {
        session: { remaining_pct: 55, reset_at: 1234567890123 },
        weekly: { remaining_pct: 80.4, reset_at: 0 },
        monthly: { remaining_pct: "bad" },
      },
      credits: { currency: "CNY", balance: 88.5 },
    });
    assert.deepEqual(g.session, { remaining: 55, resetAtMs: 1234567890123 });
    assert.deepEqual(g.weekly, { remaining: 80 }); // clamped + rounded
    assert.equal(g.monthly, undefined);
    assert.equal(g.monthlyCredits, 88.5);
    assert.equal(g.creditsCurrency, "CNY");
    assert.deepEqual(parseGenericUsage(null), {});
    assert.deepEqual(parseGenericUsage("nope"), {});
    assert.deepEqual(parseGenericUsage({ windows: {} }), {});
  });

  it("om-usage: full report parses all four windows with countdowns", () => {
    const p = parseOmniUsageText(
      [
        "Personal quota",
        "Daily",
        "80% left",
        "⏱ reset in 15h 0m",
        "",
        "Weekly",
        "90% left",
        "⏱ reset in 7d 0h 0m",
        "",
        "Provider quota",
        "Session",
        "47% left",
        "⏱ reset in 9m",
        "",
        "Weekly",
        "28% left",
        "⏱ reset in 1d 0h 0m",
      ].join("\n"),
    );
    assert.equal(p.personalDaily?.remaining, 80);
    assert.equal(p.personalWeekly?.remaining, 90);
    assert.equal(p.session?.remaining, 47);
    assert.equal(p.providerWeekly?.remaining, 28);
    assert.equal(p.personalDaily?.resetInSec, 15 * 3600);
    assert.equal(p.session?.resetInSec, 9 * 60);
    assert.equal(p.providerWeekly?.resetInSec, 86400);
  });

  it("om-usage: section switching + out-of-range + non-report text", () => {
    const p = parseOmniUsageText(
      ["Provider quota", "Weekly", "10% left", "Personal quota", "Weekly", "20% left"].join("\n"),
    );
    assert.equal(p.providerWeekly?.remaining, 10);
    assert.equal(p.personalWeekly?.remaining, 20);
    assert.equal(p.session, undefined);
    assert.deepEqual(parseOmniUsageText(["Daily", "150% left"].join("\n")), {});
    assert.deepEqual(parseOmniUsageText("Usage command is disabled for this API key."), {});
    assert.deepEqual(parseOmniUsageText(""), {});
  });

  it("upstream prefix: aliases normalize, generic aliases drop out", () => {
    assert.equal(routerUpstreamPrefix({ id: "command-code/deepseek/deepseek-v4" }), "command-code");
    assert.equal(routerUpstreamPrefix({ id: "cmd/google/gemini-3.7-flash" }), "command-code");
    assert.equal(routerUpstreamPrefix({ id: "oc/foo/bar" }), "opencode-go");
    assert.equal(routerUpstreamPrefix({ id: "glmcn/glm-5.2" }), "glm-cn");
    assert.equal(routerUpstreamPrefix({ id: "combo/glm-5.3-flash" }), undefined);
    assert.equal(routerUpstreamPrefix({ id: "auto" }), undefined);
    assert.equal(routerUpstreamPrefix({ id: "zai/glm-5.2" }), "zai");
  });

  it("providerQuotaSection keeps only the upstream section", () => {
    const text = "Personal quota\nDaily\n10% left\nProvider quota\nSession\n47% left";
    assert.equal(providerQuotaSection(text), "Provider quota\nSession\n47% left");
    assert.equal(providerQuotaSection("no section here"), undefined);
  });
});

// ── usage report building ────────────────────────────────────────────────────

describe("buildUsageReport", () => {
  it("percent windows normalize to omp limits with status + scope", () => {
    const r = buildUsageReport({
      upstream: "command-code",
      generic: { session: { remaining: 3, resetAtMs: 123 }, weekly: { remaining: 90 } },
    });
    assert.equal(r.provider, "router");
    const session = r.limits.find((l) => l.id === "session")!;
    assert.equal(session.label, "Session");
    assert.equal(session.amount.remainingFraction, 0.03);
    assert.equal(session.status, "warning"); // < 20
    assert.equal(session.window?.resetsAt, 123);
    assert.equal(session.scope.sharedGroup, "command-code");
    const weekly = r.limits.find((l) => l.id === "weekly")!;
    assert.equal(weekly.status, "ok");
    assert.deepEqual(r.metadata, { upstream: "command-code" });
  });

  it("omni windows keep upstream ids; exhausted at zero; balance unit by currency", () => {
    const r = buildUsageReport({
      omni: { session: { remaining: 0 } },
      balance: { amount: 12.5, currency: "USD" },
    });
    const s = r.limits.find((l) => l.id === "upstream-session")!;
    assert.equal(s.status, "exhausted");
    assert.equal(s.label, "Upstream session");
    const bal = r.limits.find((l) => l.id === "balance")!;
    assert.equal(bal.amount.unit, "usd");
    const cny = buildUsageReport({ balance: { amount: 1, currency: "CNY" } });
    assert.equal(cny.limits[0].amount.unit, "credits");
    assert.equal(cny.limits[0].label, "Balance (CNY)");
  });
});

// ── usage provider fetch flow (mocked network) ───────────────────────────────

describe("usage provider fetchUsage", () => {
  const realFetch = globalThis.fetch;
  const settings = { baseUrl: "http://h:20128/v1", enableReasoning: true };

  after(() => { globalThis.fetch = realFetch; });
  // Reset the upstream resolver so other tests never inherit one.
  after(() => { setUpstreamResolver(undefined); });

  function mockFetch(routes: (url: string, init?: RequestInit) => Response | undefined): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const res = routes(url, init);
      if (!res) throw new Error(`unexpected fetch ${url}`);
      return res;
    }) as typeof fetch;
  }

  function fetchWith(fetchImpl: typeof fetch, key = "sk-1", upstream?: string) {
    if (upstream) setUpstreamResolver(() => upstream);
    return createUsageProvider(settings).fetchUsage(
      { provider: "router", credential: { type: "api_key", apiKey: key } },
      { fetch: fetchImpl },
    );
  }

  it("generic JSON endpoint wins and carries provider filter + bearer", async () => {
    const seen: string[] = [];
    const report = await fetchWith(
      mockFetch((url) => {
        seen.push(url);
        if (url === "http://h:20128/v1/usage?provider=command-code") {
          return new Response(
            JSON.stringify({ windows: { session: { remaining_pct: 42, reset_at: Date.now() + 3_600_000 } } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ) as unknown as Response;
        }
        return undefined;
      }),
      "sk-1",
      "command-code",
    );
    assert.ok(report);
    assert.equal(report.limits[0].id, "session");
    assert.equal(report.limits[0].amount.remaining, 42);
    assert.deepEqual(report.metadata, { upstream: "command-code" });
    assert.equal(seen[0], "http://h:20128/v1/usage?provider=command-code");
  });

  it("generic 404 with provider falls back to aggregate URL", async () => {
    const seen: string[] = [];
    const report = await fetchWith(
      mockFetch((url) => {
        seen.push(url);
        if (url.endsWith("/usage")) {
          return new Response(
            JSON.stringify({ windows: { weekly: { remaining_pct: 70 } } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ) as unknown as Response;
        }
        return new Response("nf", { status: 404 }) as unknown as Response;
      }),
      "sk-1",
      "unknown-slug",
    );
    assert.deepEqual(seen, [
      "http://h:20128/v1/usage?provider=unknown-slug",
      "http://h:20128/v1/usage",
    ]);
    assert.equal(report?.limits[0].id, "weekly");
  });

  it("om-usage text path: upstream + personal windows both map to limits", async () => {
    const report = await fetchWith(
      mockFetch((url) => {
        if (url === "http://h:20128/api/usage/om-usage?provider=command-code") {
          return new Response(
            [
              "Personal quota",
              "Daily",
              "10% left",
              "⏱ reset in 1h 0m",
              "Provider quota",
              "Session",
              "47% left",
              "⏱ reset in 9m",
              "Weekly",
              "28% left",
            ].join("\n"),
            { status: 200, headers: { "content-type": "text/plain" } },
          ) as unknown as Response;
        }
        return new Response("nf", { status: 404 }) as unknown as Response; // generic endpoint absent
      }),
      "sk-1",
      "command-code",
    );
    assert.ok(report);
    assert.deepEqual(report.limits.map((l) => l.id), ["upstream-session", "upstream-weekly", "personal-daily"]);
    const session = report.limits[0];
    assert.ok(session.window?.resetsAt, "countdown converted to absolute reset");
    assert.ok(session.window.resetsAt! > Date.now());
    assert.equal(report.limits[2].amount.remaining, 10);
  });

  it("credit-based upstream: unusable om windows → management balance fetch", async () => {
    const report = await fetchWith(
      mockFetch((url) => {
        if (url.endsWith("/api/usage/om-usage?provider=deepseek")) {
          return new Response("Provider quota\nUnavailable", { status: 200 }) as unknown as Response;
        }
        if (url.endsWith("/api/v1/me/status")) {
          return new Response(
            JSON.stringify({ accountQuotas: [{ provider: "deepseek", connectionId: "conn-1" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ) as unknown as Response;
        }
        if (url.endsWith("/api/usage/conn-1")) {
          return new Response(
            JSON.stringify({ quotas: { credits_usd: { remaining: 7.25 } } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ) as unknown as Response;
        }
        return new Response("nf", { status: 404 }) as unknown as Response;
      }),
      "sk-1",
      "deepseek",
    );
    assert.ok(report);
    const bal = report.limits.find((l) => l.id === "balance");
    assert.ok(bal, "balance limit present");
    assert.equal(bal.amount.remaining, 7.25);
  });

  it("disabled usage command surfaces the hint as a note", async () => {
    const report = await fetchWith(
      mockFetch((url) => {
        if (url.includes("/api/usage/om-usage")) {
          return new Response("Usage command is disabled for this API key.", { status: 200 }) as unknown as Response;
        }
        return new Response("nf", { status: 404 }) as unknown as Response;
      }),
      "sk-abcd1234",
    );
    assert.ok(report);
    assert.equal(report.limits.length, 0);
    assert.match(report.notes?.[0] ?? "", /disabled.*1234/);
  });

  it("nothing usable anywhere → null (no usage signal)", async () => {
    const report = await fetchWith(
      mockFetch(() => new Response("nf", { status: 404 }) as unknown as Response),
    );
    assert.equal(report, null);
  });

  it("no key or no baseUrl → null without touching the network", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("must not fetch");
    }) as typeof fetch;
    const provider = createUsageProvider(settings);
    assert.equal(await provider.fetchUsage({ provider: "router", credential: { type: "api_key" } }, { fetch: fetchImpl }), null);
    const unconfigured = createUsageProvider({ baseUrl: "", enableReasoning: true });
    assert.equal(
      await unconfigured.fetchUsage({ provider: "router", credential: { type: "api_key", apiKey: "k" } }, { fetch: fetchImpl }),
      null,
    );
    assert.equal(called, false);
  });
});

// ── provider registration ────────────────────────────────────────────────────

describe("provider registration", () => {
  type CapturedProvider = { name: string; config: Record<string, unknown> };

  function fakePi() {
    // Holder object: the closure assigns AFTER fakePi returns, so a plain
    // snapshot would stay undefined.
    const holder: { captured?: CapturedProvider } = {};
    const pi = {
      registerProvider(name: string, config: Record<string, unknown>) {
        holder.captured = { name, config };
      },
    } as unknown as Parameters<typeof registerRouterProvider>[0];
    return { pi, holder };
  }

  const SETTINGS = { baseUrl: "http://h:20128/v1", enableReasoning: true };

  it("registers provider with dynamic discovery, oauth login, and usage", () => {
    const { pi, holder } = fakePi();
    registerRouterProvider(pi, SETTINGS);
    const captured = holder.captured;
    assert.ok(captured);
    assert.equal(captured.name, "router");
    const cfg = captured.config;
    assert.equal(cfg.baseUrl, "http://h:20128/v1");
    assert.equal(cfg.api, "openai-completions");
    assert.equal(cfg.apiKey, "ROUTER_API_KEY");
    assert.equal(typeof cfg.fetchDynamicModels, "function");
    assert.ok(cfg.oauth && typeof (cfg.oauth as { login: unknown }).login === "function");
    assert.ok(cfg.usage && typeof (cfg.usage as { fetchUsage: unknown }).fetchUsage === "function");
  });

  it("oauth login rejects an empty key and trims a real one", async () => {
    const { pi, holder } = fakePi();
    registerRouterProvider(pi, SETTINGS);
    const oauth = holder.captured!.config.oauth as { login: (cb: object) => Promise<string> };
    await assert.rejects(
      () => oauth.login({ onPrompt: async () => "   " }),
      /no API key/,
    );
    assert.equal(await oauth.login({ onPrompt: async () => " sk-live-abc " }), "sk-live-abc");
  });

  it("fetchDynamicModels maps raw entries to omp models", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: [{ id: "glm-cn/glm-5.3", context_length: 200_000, max_output_tokens: 128_000 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response) as typeof fetch;
    try {
      const { pi, holder } = fakePi();
      registerRouterProvider(pi, SETTINGS);
      const models = await (holder.captured!.config.fetchDynamicModels as (k?: string) => Promise<Array<{ id: string; contextWindow: number; thinking?: { efforts: string[] } }>>)("sk-1");
      assert.equal(models.length, 1);
      assert.equal(models[0].id, "glm-cn/glm-5.3");
      assert.equal(models[0].contextWindow, 1_000_000); // floor-poison corrected
      assert.deepEqual(models[0].thinking?.efforts, ["high", "max"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
