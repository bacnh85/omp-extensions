import type {
  UsageCredential,
  UsageFetchContext,
  UsageFetchParams,
  UsageLimit,
  UsageProvider,
  UsageReport,
} from "@oh-my-pi/pi-ai";
import { PROVIDER_ID, type RouterSettings } from "./config.js";

// ── Upstream hint ────────────────────────────────────────────────────────────

/** OmniRoute quotas are per upstream connection. omp hands the usage fetcher a
 *  credential but no model, so index.ts registers a resolver over the live
 *  session model; the first path segment of the router model id selects that
 *  upstream's quota (`?provider=<slug>`). */
let upstreamResolver: (() => string | undefined) | undefined;

export function setUpstreamResolver(fn: (() => string | undefined) | undefined): void {
  upstreamResolver = fn;
}

function currentUpstream(): string | undefined {
  return upstreamResolver?.();
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export interface UsagePercentWindow {
  /** Percent of quota remaining (0-100). */
  remaining: number;
  /** Relative reset countdown in seconds (OmniRoute text) — absolute when
   *  derived from an epoch-ms reset (`resetAtMs`). */
  resetInSec?: number;
  resetAtMs?: number;
}

export interface GenericUsage {
  session?: UsagePercentWindow;
  weekly?: UsagePercentWindow;
  monthly?: UsagePercentWindow;
  monthlyCredits?: number;
  creditsCurrency?: string;
}

/** Parse the general router usage API (GET <baseUrl>/usage, JSON —
 *  yardmaster): `{windows: {session, weekly, monthly}: {remaining_pct,
 *  reset_at}, credits: {currency, balance}, providers: []}`. Robust to
 *  missing sections; `{}` when nothing usable is present. */
export function parseGenericUsage(data: unknown): GenericUsage {
  const body = data as {
    windows?: Record<string, { remaining_pct?: number; reset_at?: number }>;
    credits?: { currency?: string; balance?: number };
  } | null;
  if (!body || typeof body !== "object") return {};
  const toWindow = (w: { remaining_pct?: number; reset_at?: number } | undefined): UsagePercentWindow | undefined => {
    if (!w || typeof w.remaining_pct !== "number" || !Number.isFinite(w.remaining_pct)) return undefined;
    const out: UsagePercentWindow = { remaining: Math.max(0, Math.min(100, Math.round(w.remaining_pct))) };
    if (typeof w.reset_at === "number" && w.reset_at > 0) out.resetAtMs = w.reset_at;
    return out;
  };
  const out: GenericUsage = {};
  out.session = toWindow(body.windows?.session);
  out.weekly = toWindow(body.windows?.weekly);
  out.monthly = toWindow(body.windows?.monthly);
  if (typeof body.credits?.balance === "number" && Number.isFinite(body.credits.balance)) {
    out.monthlyCredits = body.credits.balance;
    out.creditsCurrency = body.credits.currency ?? "USD";
  }
  if (!out.session && !out.weekly && !out.monthly && out.monthlyCredits === undefined) return {};
  return out;
}

export interface OmniUsageWindows {
  personalDaily?: UsagePercentWindow;
  personalWeekly?: UsagePercentWindow;
  session?: UsagePercentWindow;
  providerWeekly?: UsagePercentWindow;
}

/** "reset in 2h 55m" → total seconds. */
export function countdownToSeconds(text: string): number | undefined {
  const m = text.match(/(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  const secs = Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60;
  return secs || undefined;
}

/** Parse OmniRoute's `/api/usage/om-usage` plain-text report into windows.
 *  Sections: "Personal quota" (per-key USD budgets: Daily/Weekly) and
 *  "Provider quota" (connection session/weekly). Lines: `<Label>`,
 *  `NN% left`, `⏱ reset in <countdown>`. Robust to missing/unknown blocks. */
export function parseOmniUsageText(text: string): OmniUsageWindows {
  const out: OmniUsageWindows = {};
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let inPersonal = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase() === "personal quota") { inPersonal = true; continue; }
    if (line.toLowerCase() === "provider quota") { inPersonal = false; continue; }
    const usedMatch = line.match(/^(\d+)%\s*left$/);
    if (!usedMatch) continue;
    const label = (lines[i - 1] ?? "").toLowerCase();
    const resetMatch = lines[i + 1]?.match(/reset in (.+)$/);
    const remaining = Number(usedMatch[1]);
    if (remaining < 0 || remaining > 100) continue;
    const window: UsagePercentWindow = { remaining };
    const secs = resetMatch ? countdownToSeconds(resetMatch[1]) : undefined;
    if (secs) window.resetInSec = secs;
    if (inPersonal) {
      if (label.includes("daily")) out.personalDaily = window;
      else if (label.includes("weekly")) out.personalWeekly = window;
    } else {
      if (label.includes("session")) out.session = window;
      else if (label.includes("weekly")) out.providerWeekly = window;
    }
  }
  return out;
}

/** Strip everything up to and including the "Provider quota" section header
 *  so notes never echo personal USD budget lines. */
export function providerQuotaSection(text: string): string | undefined {
  const idx = text.indexOf("Provider quota");
  if (idx < 0) return undefined;
  const section = text.slice(idx);
  return section.trim().length > 0 ? section : undefined;
}

/** First path segment of a router model id = the upstream provider OmniRoute
 *  routes to (e.g. `command-code/deepseek/deepseek-v4-flash` → `command-code`).
 *  Aliases normalize to the canonical provider id (`cmd` → `command-code`);
 *  generic router aliases carry no provider info — undefined so the usage API
 *  picks the best snapshot. */
export function routerUpstreamPrefix(model: { id?: string } | undefined): string | undefined {
  const id = model?.id ?? "";
  const first = id.split("/")[0]?.toLowerCase();
  if (!first) return undefined;
  // Alias normalization: OmniRoute exposes the same upstream under several ids.
  if (first === "cmd") return "command-code";
  if (first === "oc") return "opencode-go";
  if (first === "ds") return "deepseek";
  if (first === "glmcn") return "glm-cn"; // OmniRoute connection slug
  // Generic router aliases / upstreams without cached quota data — no provider
  // selection; the usage API returns the best snapshot instead.
  const generic: Record<string, true> = {
    "auto": true, "aug": true, "no-think": true, "tllm": true, "combo": true,
    "openrouter": true, "nvidia": true, "felo": true, "pepper": true, "mcode": true,
    "ddgw": true, "veoaifree-web": true, "veo-free": true,
  };
  return generic[first] === true ? undefined : first;
}

// ── Report building ──────────────────────────────────────────────────────────

function percentLimit(
  id: string,
  label: string,
  w: UsagePercentWindow,
  upstream: string | undefined,
): UsageLimit {
  const remainingFraction = Math.max(0, Math.min(1, w.remaining / 100));
  const resetsAt = w.resetAtMs ?? (w.resetInSec ? Date.now() + w.resetInSec * 1000 : undefined);
  return {
    id,
    label,
    scope: { provider: PROVIDER_ID, ...(upstream ? { sharedGroup: upstream } : {}) },
    window: { id, label, ...(resetsAt ? { resetsAt } : {}) },
    amount: {
      remaining: w.remaining,
      limit: 100,
      unit: "percent",
      remainingFraction,
      usedFraction: 1 - remainingFraction,
    },
    status: w.remaining <= 0 ? "exhausted" : w.remaining < 20 ? "warning" : "ok",
  };
}

function balanceLimit(balance: number, currency: string, upstream: string | undefined): UsageLimit {
  return {
    id: "balance",
    label: `Balance (${currency})`,
    scope: { provider: PROVIDER_ID, ...(upstream ? { sharedGroup: upstream } : {}) },
    amount: {
      remaining: balance,
      // UsageUnit has no CNY: keep the currency in the label, unit "credits".
      unit: currency === "USD" ? "usd" : "credits",
    },
    status: balance <= 0 ? "exhausted" : "ok",
  };
}

/** Build the normalized report from whatever windows a router flavor
 *  provided. Exported for tests. */
export function buildUsageReport(parts: {
  upstream?: string;
  generic?: GenericUsage;
  omni?: OmniUsageWindows;
  balance?: { amount: number; currency: string };
  notes?: string[];
}): UsageReport {
  const limits: UsageLimit[] = [];
  const g = parts.generic;
  if (g?.session) limits.push(percentLimit("session", "Session", g.session, parts.upstream));
  if (g?.weekly) limits.push(percentLimit("weekly", "Weekly", g.weekly, parts.upstream));
  if (g?.monthly) limits.push(percentLimit("monthly", "Monthly", g.monthly, parts.upstream));
  const o = parts.omni;
  if (o?.session) limits.push(percentLimit("upstream-session", "Upstream session", o.session, parts.upstream));
  if (o?.providerWeekly) limits.push(percentLimit("upstream-weekly", "Upstream weekly", o.providerWeekly, parts.upstream));
  if (o?.personalDaily) limits.push(percentLimit("personal-daily", "Personal daily", o.personalDaily, parts.upstream));
  if (o?.personalWeekly) limits.push(percentLimit("personal-weekly", "Personal weekly", o.personalWeekly, parts.upstream));
  const bal = parts.balance ?? (g?.monthlyCredits !== undefined
    ? { amount: g.monthlyCredits, currency: g.creditsCurrency ?? "USD" }
    : undefined);
  if (bal) limits.push(balanceLimit(bal.amount, bal.currency, parts.upstream));
  return {
    provider: PROVIDER_ID,
    fetchedAt: Date.now(),
    limits,
    ...(parts.notes?.length ? { notes: parts.notes } : {}),
    metadata: parts.upstream ? { upstream: parts.upstream } : undefined,
  };
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

function credentialApiKey(credential: UsageCredential | undefined): string | undefined {
  if (!credential) return undefined;
  return credential.type === "oauth" ? credential.accessToken : credential.apiKey;
}

/** Strip a `/v1` suffix so management routes (under the origin) can be
 *  derived from the OpenAI-compatible baseUrl. */
function routerOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/** OmniRoute management credential (manage-scope key or oma_ CLI token) from
 *  env — optional override. The router key itself works when it holds the
 *  `manage` scope (API Keys dashboard), which unlocks /api/usage/<connectionId>
 *  carrying the raw USD balance for credit-based upstreams (deepseek) that the
 *  key-authable endpoints normalize away. */
function mgmtToken(apiKey: string): string {
  return process.env.ROUTER_MGMT_TOKEN || process.env.OMNIROUTE_MGMT_TOKEN || apiKey;
}

interface RouterCredits {
  amount: number;
  currency: string;
}

/** Raw balance for credit-based upstreams (deepseek: `credits_usd`) via
 *  OmniRoute's management usage API. Only called when the key-authable
 *  om-usage text reports no usable windows — that surface normalizes credits
 *  to meaningless percentages. Connection discovery comes from
 *  /api/v1/me/status (key-authable); the balance from /api/usage/<id>. */
async function fetchRouterCredits(
  ctx: UsageFetchContext,
  baseUrl: string,
  apiKey: string,
  upstream: string,
  signal?: AbortSignal,
): Promise<RouterCredits | undefined> {
  const origin = routerOrigin(baseUrl);
  const timeout = AbortSignal.timeout(7_000);
  const signal_ = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const headers = { Authorization: `Bearer ${apiKey}` };
    // 1. Connection id for this upstream via the key-authable status endpoint.
    const statusRes = await (ctx.fetch ?? fetch)(`${origin}/api/v1/me/status`, { headers, signal: signal_ });
    if (!statusRes.ok) return undefined;
    const status = (await statusRes.json()) as {
      accountQuotas?: Array<{ provider?: string; connectionId?: string }>;
    };
    const connectionId = status.accountQuotas?.find((q) => q.provider === upstream)?.connectionId;
    if (!connectionId) return undefined;
    // 2. Raw usage (management token) — quotas.credits_usd.remaining is the balance.
    const usageRes = await (ctx.fetch ?? fetch)(`${origin}/api/usage/${connectionId}`, {
      headers: { Authorization: `Bearer ${mgmtToken(apiKey)}` },
      signal: signal_,
    });
    if (!usageRes.ok) return undefined;
    const usage = (await usageRes.json()) as { quotas?: Record<string, { remaining?: number }> };
    const credits = usage.quotas?.credits_usd ?? usage.quotas?.credits;
    const remaining = credits?.remaining;
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) return undefined;
    return { amount: remaining, currency: "USD" };
  } catch {
    return undefined; // no mgmt scope / upstream down — report without balance
  }
}

/** omp-native usage provider for the router. Resolution order mirrors
 *  pi-sub's /sub router adapter:
 *  1. Generic JSON `GET <baseUrl>/usage[?provider=<upstream>]` (yardmaster).
 *     Unknown slugs 404 → retry aggregate; routers without the endpoint 404 /
 *     return HTML → fall through.
 *  2. OmniRoute plain text `GET <origin>/api/usage/om-usage[?provider=]`
 *     (+ "No cached usage data" retry without the slug, credit-based-upstream
 *     balance via the management API, disabled-key note).
 *  Returns null when nothing usable is known (omp treats null as "no usage
 *  signal this cycle" and keeps serving the last-good report). */
export function createUsageProvider(settings: RouterSettings): UsageProvider {
  return {
    id: PROVIDER_ID,
    async fetchUsage(
      params: UsageFetchParams,
      ctx: UsageFetchContext,
    ): Promise<UsageReport | null> {
      const baseUrl = settings.baseUrl;
      const apiKey = credentialApiKey(params.credential);
      if (!baseUrl || !apiKey) return null;

      const upstream = currentUpstream();
      const timeout = AbortSignal.timeout(7_000);
      const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
      const doFetch = ctx.fetch ?? fetch;

      // 1. General usage API (JSON).
      try {
        const usageUrl = (q: string) => `${baseUrl.replace(/\/$/, "")}/usage${q}`;
        let response = await doFetch(usageUrl(upstream ? `?provider=${encodeURIComponent(upstream)}` : ""), {
          headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (response.status === 404 && upstream) {
          response = await doFetch(usageUrl(""), {
            headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
            signal,
          });
        }
        const ct = response.headers.get("content-type") ?? "";
        if (response.ok && ct.includes("application/json")) {
          const generic = parseGenericUsage(await response.json());
          if (generic.session || generic.weekly || generic.monthly || generic.monthlyCredits !== undefined) {
            return buildUsageReport({ upstream, generic });
          }
        }
      } catch { /* no general endpoint / transient — fall through */ }

      // 2. OmniRoute per-key usage command (plain text).
      try {
        const url = `${routerOrigin(baseUrl)}/api/usage/om-usage` +
          (upstream ? `?provider=${encodeURIComponent(upstream)}` : "");
        const response = await doFetch(url, {
          headers: { Accept: "text/plain", Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (response.ok) {
          const text = await response.text();
          if (text && !text.includes("disabled")) {
            let w = parseOmniUsageText(text);
            // "No cached usage data" = unknown/wrong slug — retry without
            // ?provider= for the best/all snapshot.
            if (upstream && !w.session && !w.providerWeekly && text.includes("No cached usage data")) {
              const plain = await doFetch(url.replace(/\?provider=.*$/, ""), {
                headers: { Accept: "text/plain", Authorization: `Bearer ${apiKey}` },
                signal,
              });
              if (plain.ok) {
                const plainText = await plain.text();
                if (plainText && !plainText.includes("disabled")) w = parseOmniUsageText(plainText);
              }
            }
            // Credit-based upstreams (deepseek): the usage text prints
            // "Unavailable" windows — pull the real USD balance from the
            // management API instead.
            const balance = !w.session && !w.providerWeekly && upstream
              ? await fetchRouterCredits(ctx, baseUrl, apiKey, upstream, params.signal)
              : undefined;
            if (balance || w.session || w.providerWeekly || w.personalDaily || w.personalWeekly) {
              return buildUsageReport({
                upstream,
                omni: w,
                balance,
                notes: text.includes("Unavailable") && !balance
                  ? [`Upstream ${upstream}: usage windows unavailable (credit-based upstream?)`]
                  : undefined,
              });
            }
            // Report exists but carries no parseable quota — surface the
            // provider section (never personal budget lines) as a note.
            const section = providerQuotaSection(text);
            return buildUsageReport({ upstream, notes: section ? [section] : undefined });
          }
          // Usage command exists but is disabled for this key.
          return buildUsageReport({
            upstream,
            notes: [
              `OmniRoute usage command is disabled for this router key — ` +
              `enable it in the dashboard (API Keys → the key ending ${apiKey.slice(-4)} → usage command).`,
            ],
          });
        }
      } catch { /* non-OmniRoute or transient — no usage signal */ }

      return null;
    },
  };
}
