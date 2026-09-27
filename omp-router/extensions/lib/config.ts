import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

/** omp provider id for the router (models, /login target, usage reports). */
export const PROVIDER_ID = "router";

export interface RouterSettings {
  /** Base URL of the router's OpenAI-compatible API (e.g. http://host:20128/v1). */
  baseUrl: string;
  /** Expose thinking-level controls on router models. Default true. */
  enableReasoning: boolean;
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** omp honors PI_CODING_AGENT_DIR (relocates config.yml, agent.db, …) — the
 *  router config file moves with it. */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

/** User-global extension config: `~/.omp/agent/router.json`.
 *  Not omp's config.yml — that file is schema-validated, so an extension-owned
 *  JSON sidecar avoids colliding with (or being rejected by) the settings
 *  schema. Secrets never live here: the API key is stored by omp's own auth
 *  store via `/login router`. */
export function globalConfigPath(): string {
  return join(agentDir(), "router.json");
}

/** Project-scope config: `<cwd>/.omp/router.json`. Trust-gated — see
 *  {@link getSettings}. Non-secret fields only. */
export function projectConfigPath(): string {
  return join(process.cwd(), ".omp", "router.json");
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Read router settings. Precedence (with trustProject: true): env var >
 *  project `.omp/router.json` > global `~/.omp/agent/router.json` > defaults.
 *  Default (trustProject falsy): project config is ignored entirely — an
 *  untrusted checkout must not redirect `baseUrl` to an attacker endpoint
 *  while the stored router key is sent there as Bearer.
 *  Project-scope `apiKey` is ignored (secrets must not come from a
 *  checked-in file). */
export function getSettings(opts: { trustProject?: boolean } = {}): RouterSettings {
  const global = readRouterSection(readFileJson(globalConfigPath())) ?? {};
  const project = opts.trustProject
    ? readRouterSection(readFileJson(projectConfigPath())) ?? {}
    : {};
  // Env names: OMP_ROUTER_* primary, ROUTER_* pi-router parity.
  const envBaseUrl = process.env.OMP_ROUTER_BASE_URL ?? process.env.ROUTER_BASE_URL;
  const envReasoning =
    process.env.OMP_ROUTER_ENABLE_REASONING ?? process.env.ROUTER_ENABLE_REASONING;
  return {
    baseUrl: normalizeUrl(envBaseUrl || project.baseUrl || global.baseUrl || ""),
    enableReasoning:
      parseBooleanFlag(envReasoning) ?? project.enableReasoning ?? global.enableReasoning ?? true,
  };
}

/** Read-modify-write non-secret fields into the GLOBAL router.json (merge,
 *  never clobber other keys). `baseUrl` is normalized (trailing slashes
 *  stripped). Atomicity (tmp+rename) is part of the contract. */
export function writeGlobalSettings(patch: { baseUrl?: string; enableReasoning?: boolean }): void {
  const current = readFileJson(globalConfigPath()) ?? {};
  if (patch.baseUrl !== undefined) current.baseUrl = normalizeUrl(patch.baseUrl);
  if (patch.enableReasoning !== undefined) current.enableReasoning = patch.enableReasoning;
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  const tmp = globalConfigPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, globalConfigPath());
}

export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Router API key present in the environment (display only — request auth and
 *  usage fetches resolve the stored `/login router` credential through omp). */
export function envApiKey(): string | undefined {
  return process.env.OMP_ROUTER_API_KEY ?? process.env.ROUTER_API_KEY ?? undefined;
}

export function maskApiKey(key: string | undefined): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return `(${key.length} chars)`;
  return key.slice(0, 4) + "●".repeat(key.length - 8) + key.slice(-4);
}

export function configSummary(settings: RouterSettings, apiKeyMasked: string | undefined): string {
  const key = envApiKey()
    ? maskApiKey(envApiKey()) + " (env)"
    : maskApiKey(apiKeyMasked);
  const reasoning = settings.enableReasoning
    ? "ON"
    : "OFF (run /router-reasoning to enable thinking levels)";
  return `Endpoint: ${settings.baseUrl || "(not configured)"}
API key: ${key}
Reasoning: ${reasoning}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readFileJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Non-secret fields only; drop any `apiKey` a config file tries to inject. */
function readRouterSection(json: Record<string, unknown> | null): Partial<RouterSettings> | null {
  if (!json || typeof json !== "object") return null;
  const out: Partial<RouterSettings> = {};
  if (typeof json.baseUrl === "string" && json.baseUrl.trim()) out.baseUrl = json.baseUrl.trim();
  if (typeof json.enableReasoning === "boolean") out.enableReasoning = json.enableReasoning;
  return out;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(v)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(v)) return false;
  return undefined;
}
