import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
// Value import: Effort is a const enum — cross-file member references must
// resolve to the real runtime module (tsx/Bun per-file transpile does not
// inline them).
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { RouterSettings } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** One entry from the router's OpenAI-compatible `GET /v1/models`. */
export interface RouterModelRaw {
  id: string;
  owned_by?: string;
  context_length?: unknown;
  max_output_tokens?: unknown;
  capabilities?: { contextWindow?: unknown; maxOutput?: unknown; vision?: unknown };
}

/** omp model shape produced by {@link mapModel}. */
export type RouterModel = ProviderModelConfig;

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 4_096;

// ── Public API ───────────────────────────────────────────────────────────────

export async function fetchModels(
  config: RouterSettings,
  signal?: AbortSignal,
  apiKey?: string,
): Promise<RouterModelRaw[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // Discovery credential (host-resolved /login key) wins; env is the fallback.
  const key =
    apiKey ?? process.env.OMP_ROUTER_API_KEY ?? process.env.ROUTER_API_KEY ?? undefined;
  if (key) headers.Authorization = `Bearer ${key}`;

  // baseUrl conventionally ends in /v1 (README + chat baseUrl); never double
  // the segment — append only when missing.
  const url = /\/v1\/?$/.test(config.baseUrl)
    ? `${config.baseUrl.replace(/\/+$/, "")}/models`
    : `${config.baseUrl}/v1/models`;
  const response = await fetchWithTimeout(url, { headers, signal });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`router returned ${response.status}: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as { data?: RouterModelRaw[] };
  return payload.data ?? [];
}

/** Upstreams that reject assistant tool-call turns without the reasoning
 *  field while thinking mode is on. Verified ONLY for the ocg/ wire — omp's
 *  native opencode-go catalog sets compat.requiresReasoningContentForToolCalls
 *  on deepseek-v4*, glm-5.1 and kimi-k2.7-code. The same model ids served via
 *  zai//cmd//ds/ have no such verified contract, so the flag is scoped to the
 *  ocg/ prefix. Unprefixed opencode-go deployments would need a bare-id row. */
function isOcgReasoningPassback(id: string): boolean {
  return /^ocg\/(deepseek|glm-5\.1|kimi-k2\.7-code)/i.test(id);
}

/** Detect 9router thinkingFormat from model ID, matching the same patterns
 *  used in 9router's thinkingLevels.js and capabilities.js. Each format
 *  defines a distinct set of valid thinking levels. */
function detectThinkingFormat(modelId: string): string {
  const id = modelId.toLowerCase();

  // Pattern overrides (first match wins, matching 9router's PATTERN_THINKING)
  if (id.includes("gpt-5.6-sol")) return "openai-max";   // accepts max
  if (id.includes("codex")) return "codex-pattern";        // cannot disable thinking

  // Model-family detection (matching 9router's FORMAT_LEVELS keys)
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("claude")) {
    // Claude 4.6+ uses adaptive thinking (none, low, medium, high, max).
    // Parse major[.-]minor so claude-3-5/3-7 aren't misread by the minor digit,
    // and dash forms like claude-4-6 resolve to 4.6.
    const v = id.match(/claude[^\d]*(\d+)(?:[-.](\d+))?/);
    const ver = v ? Number(v[1]) + (v[2] ? Number(v[2]) / 10 : 0) : 0;
    if (ver >= 4.6 || /\b(sonnet|opus)-5\b/.test(id)) {
      return "claude-adaptive";
    }
    return "claude-budget";
  }
  if (id.includes("gemini")) {
    if (/gemini-3/.test(id)) return "gemini-level";  // minimal required, no disable
    return "gemini-budget";
  }
  if (id.includes("kimi")) return "kimi";
  if (id.includes("qwen") || id.includes("qwq")) return "qwen";
  if (id.includes("glm")) return "zai";
  if (id.includes("minimax")) return "minimax";
  if (id.includes("hunyuan")) return "hunyuan";
  // Anchored like the other families — a bare `includes("step")` grabbed any
  // id containing "step" (e.g. "multistep", "stepwise") into the step map.
  if (/step-|stepfun/.test(id)) return "step";

  // Default: OpenAI format (GPT, o-series, generic models)
  return "openai";
}

/** omp `thinking` capability per detected format. Direct translation of
 *  pi-router's FORMAT_TO_LEVEL_MAP: a level mapped to `null` in pi (hidden in
 *  the UI) is simply absent from `efforts`; a level remapped to another wire
 *  value (e.g. xhigh→max) collapses to the target entry, because omp clamps
 *  user selection to the listed efforts and `effortMap` stays identity (the
 *  effort string itself is the `reasoning_effort` wire value).
 *
 *  Mirroring 9router's FORMAT_LEVELS:
 *    openai:            minimal…xhigh (no max)
 *    openai-max:        minimal…max
 *    codex-pattern:     cannot disable thinking
 *    claude-adaptive:   none, low, medium, high, max
 *    claude-budget:     none, low, medium, high, xhigh, max
 *    deepseek (hiMax):  none, high, max
 *    gemini-level:      minimal required, no disable
 *    gemini-budget:     none, low, medium, high
 *    kimi (levelMax):   none, low, medium, high, max
 *    qwen/hunyuan/step: none, low, medium, high
 *    zai:               none, high, max (GLM's single thinking-on tier + max)
 *    minimax:           none, minimal…xhigh (no max)
 */
const FORMAT_TO_EFFORTS: Record<string, { efforts: Effort[]; requiresEffort?: boolean }> = {
  "openai":          { efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
  "openai-max":      { efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
  "codex-pattern":   { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh], requiresEffort: true },
  "claude-adaptive": { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
  "claude-budget":   { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
  "deepseek":        { efforts: [Effort.High, Effort.Max] },
  "kimi":            { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] },
  "gemini-level":    { efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High], requiresEffort: true },
  "gemini-budget":   { efforts: [Effort.Low, Effort.Medium, Effort.High] },
  "qwen":            { efforts: [Effort.Low, Effort.Medium, Effort.High] },
  "hunyuan":         { efforts: [Effort.Low, Effort.Medium, Effort.High] },
  "step":            { efforts: [Effort.Low, Effort.Medium, Effort.High] },
  "zai":             { efforts: [Effort.High, Effort.Max] },
  "minimax":         { efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
};

// Verified context windows from models.dev (cited by 9router's capabilities.js
// as its authoritative source). 9router's capabilities.js applies a 200k
// DEFAULT_CAPABILITIES floor to models without an explicit pattern match,
// which under-reports models with larger windows (e.g. GLM-5.2 = 1M).
// This table corrects known gaps client-side.
// Source: https://models.dev/api.json
// Floor constants: 9router/omniroute's DEFAULT_CAPABILITIES pair (context 200000,
// output 128000) for unprofiled models. Anything ≤ these on a matched-override
// model is the router's default-floor stamp, not real metadata — `mapModel`
// uses these to de-poison without inflating truthful reports above the floor.
const DEFAULT_CONTEXT_FLOOR = 200_000;
const DEFAULT_MAX_FLOOR = 128_000;
const CONTEXT_OVERRIDES: { pattern: RegExp; contextWindow: number; maxTokens?: number }[] = [
  // GLM-5.2/5.3 only: 1M context, 128K output (models.dev: zhipuai/glm-5.2; GLM-5.3[1m]
  // Coding Plan route + launch coverage report the same window). Lookahead keeps
  // future glm-5.4+ (unverified profile) off this override.
  { pattern: /glm-5\.[23](?!\d)/i, contextWindow: 1_000_000, maxTokens: 131_072 },
  // DeepSeek V4: 1M context (models.dev + 9router codebuddy/nvidia overrides)
  { pattern: /deepseek-v[34]/i, contextWindow: 1_000_000 },
  // GLM-5.1 / 5 / 5-turbo / 5v-turbo: ~200K context, 128K output. Lookahead keeps
  // glm-5.[23] out (covered above) and variant suffixes with their own distinct
  // windows safe (live catalog reports them above the floor).
  { pattern: /glm-5(?:\.1|-turbo|v-turbo)?(?![0-9.v-])/i, contextWindow: 200_000, maxTokens: 131_072 },
  // GLM-4.6 / 4.7: 200K / 128K (models.dev zhipuai/glm-4.6 = 204800).
  { pattern: /glm-4\.[67](?![0-9.v-])/i, contextWindow: 200_000, maxTokens: 131_072 },
  // Kimi K3: 1M context. Specific pattern — `kimi-k2.7-code` real = 262K so a
  // blanket override would inflate it (pi-commandcode 0.1.6 bug class).
  { pattern: /kimi-k3(?![0-9.v-])/i, contextWindow: 1_048_576, maxTokens: 131_072 },
];

function lookupContextOverride(modelId: string): { contextWindow?: number; maxTokens?: number } {
  for (const entry of CONTEXT_OVERRIDES) {
    if (entry.pattern.test(modelId)) {
      return { contextWindow: entry.contextWindow, ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}) };
    }
  }
  return {};
}

// Transport-verified vision routes (pi-router probe-vision.mjs; OmniRoute's
// /v1/models omits capabilities.vision on most non-openrouter connections and
// the flag lies in BOTH directions). Re-probe when the router image updates.
// 2026-09-06 probe: gemini-3.7-flash prompt 21→1092 (Δ1071);
// deepseek-v4-flash-vision-exp 104→319 (Δ215). combo/glm-5.3-flash also
// passed (Δ1060) but is excluded — combo failover can land on a stripping
// member.
const VISION_OVERRIDES: RegExp[] = [
  // Anchored + explicit effort-tier suffix group: -low…-max are 9router's
  // thinking-level variants of the probed base (same upstream + executor, so
  // same image transport). Sibling models (-preview, -lite, future versions)
  // stay unverified — mirroring CONTEXT_OVERRIDES lookahead discipline.
  /^(cmd|command-code)\/google\/gemini-3\.7-flash(?:-(?:low|medium|high|xhigh|max))?$/i,
  /^(cmd|command-code)\/deepseek\/deepseek-v4-flash-vision-exp(?:-(?:low|medium|high|xhigh|max))?$/i,
];
// Inverse lie, verified 2026-09-06: openrouter entries stamp vision:true but
// the openrouter upstream strips image parts (glm-5.3-flash probe: Δ16, model
// replied NOIMAGE). Surgical list — other vision:true rows are untouched.
const VISION_DOWNGRADES: RegExp[] = [
  /^openrouter\/z-ai\/glm-5\.3-flash/i,
];

/** Net vision for a model id given the router's metadata claim. */
export function resolveVision(id: string, metadataVision: boolean): boolean {
  if (VISION_DOWNGRADES.some((re) => re.test(id))) return false;
  return metadataVision || VISION_OVERRIDES.some((re) => re.test(id));
}

// Upstream connection slugs (OmniRoute ids are "<connection>/<model>") whose
// reasoning_effort schema rejects "none" and "minimal". The `cmd` slug is an
// alias for the same upstream (command-code).
const NO_DISABLE_PREFIX = /^(command-?code|cmd)[-/]/i;

/** omp `thinking` capability for a router model id, honoring the
 *  command-code connections that reject disabled/minimal thinking (would be
 *  forwarded untranslated and rejected with HTTP 400 — same bug class as
 *  pi-commandcode 0.1.4). */
export function thinkingFor(modelId: string): RouterModel["thinking"] {
  const entry = FORMAT_TO_EFFORTS[detectThinkingFormat(modelId)] ?? FORMAT_TO_EFFORTS["openai"];
  if (NO_DISABLE_PREFIX.test(modelId)) {
    const efforts = entry.efforts.filter((e) => e !== Effort.Minimal);
    return { mode: "effort", efforts, requiresEffort: true };
  }
  return {
    mode: "effort",
    efforts: entry.efforts,
    ...(entry.requiresEffort ? { requiresEffort: true } : {}),
  };
}

export function mapModel(raw: RouterModelRaw, enableReasoning: boolean): RouterModel {
  const isCombo = raw.owned_by === "combo";
  const caps = raw.capabilities as
    | { contextWindow?: unknown; maxOutput?: unknown; vision?: unknown }
    | undefined;
  // Context/max-output resolution, single-tier provenance with floor-aware
  // override: top-level `context_length`/`max_output_tokens` are authoritative
  // for their own field UNLESS the pair sits at/below 9router's
  // DEFAULT_CAPABILITIES floor signature (context ≤ 200000 AND max ≤ 128000)
  // while the curated override is at/above it — that pair is the router's
  // registry default stamp, not real metadata. Any present field carrying a
  // truthful above-floor value bypasses the override entirely (preserves e.g.
  // openrouter/z-ai/glm-5.2:free = 256K; the 1.1.1 single-tier contract).
  const topLevelContext = parsePositiveInt(raw.context_length);
  const topLevelMax = parsePositiveInt(raw.max_output_tokens);
  const override = lookupContextOverride(raw.id);
  const ctxAbsent = raw.context_length === undefined || raw.context_length === null;
  const maxAbsent = raw.max_output_tokens === undefined || raw.max_output_tokens === null;
  const ctxUsable = !ctxAbsent && topLevelContext !== undefined;
  const maxUsable = !maxAbsent && topLevelMax !== undefined;
  // All-or-nothing pair-floor-poison gate (see above). `>=` (not strict `>`)
  // so models whose verified window equals the floor (glm-5.1 / glm-4.6 at
  // 200000) still get the max correction when the router stamps the floor pair.
  const ctxFloorPoisoned =
    ctxUsable &&
    (topLevelContext as number) <= DEFAULT_CONTEXT_FLOOR &&
    override.contextWindow !== undefined &&
    override.contextWindow >= DEFAULT_CONTEXT_FLOOR;
  const maxFloorPoisoned =
    maxUsable &&
    (topLevelMax as number) <= DEFAULT_MAX_FLOOR &&
    override.maxTokens !== undefined &&
    override.maxTokens >= DEFAULT_MAX_FLOOR;
  const pairFloorPoisoned = ctxFloorPoisoned && maxFloorPoisoned;
  const useOverride = (ctxAbsent && maxAbsent) || pairFloorPoisoned;
  const ctxFromRouter = !pairFloorPoisoned && ctxUsable ? topLevelContext : undefined;
  const maxFromRouter = !pairFloorPoisoned && maxUsable ? topLevelMax : undefined;
  const contextWindow =
    ctxFromRouter ??
    (useOverride ? override.contextWindow : undefined) ??
    parsePositiveInt(caps?.contextWindow) ??
    FALLBACK_CONTEXT_WINDOW;
  const maxTokens =
    maxFromRouter ??
    (useOverride ? override.maxTokens : undefined) ??
    parsePositiveInt(caps?.maxOutput) ??
    FALLBACK_MAX_TOKENS;
  const inputTypes: ("text" | "image")[] = resolveVision(raw.id, caps?.vision === true)
    ? ["text", "image"]
    : ["text"];

  return {
    id: raw.id,
    name: isCombo ? `🔀 ${raw.id}` : raw.id,
    reasoning: enableReasoning,
    ...(enableReasoning ? { thinking: thinkingFor(raw.id) } : {}),
    input: inputTypes,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: enableReasoning,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
      requiresReasoningContentForToolCalls: isOcgReasoningPassback(raw.id),
    },
  };
}

function parsePositiveInt(value: unknown): number | undefined {
  // Accept numeric strings ("1048576") — heterogeneous OpenAI-compat gateways
  // may serialize context_length/max_output_tokens as strings. Invalid values
  // (NaN, <=0, non-numeric text, null) fall through to the next tier.
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
  return undefined;
}

/** Re-map an already-mapped model with a new enableReasoning flag — used by
 *  /router-reasoning to toggle thinking levels without re-fetching. */
export function applyReasoning(model: RouterModel, enableReasoning: boolean): RouterModel {
  return {
    ...model,
    reasoning: enableReasoning,
    ...(enableReasoning
      ? { thinking: thinkingFor(model.id) }
      : { thinking: undefined }),
    compat: { ...model.compat!, supportsReasoningEffort: enableReasoning },
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  // Combine caller signal with timeout signal
  const signal = init.signal;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
