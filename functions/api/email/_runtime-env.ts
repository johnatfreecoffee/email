// Runtime integration keys stored in Supabase `email_settings` (key = "integrations").
// Lets users plug in Resend, Cloudflare, xAI, and OpenRouter keys directly from the
// Settings -> Setup UI without editing .env files or redeploying Cloudflare Pages.
//
// Precedence: UI-saved key (when non-empty) > Cloudflare Pages / .env secret.
// Always degrades cleanly to the original `env` when Supabase is unconfigured or
// the `email_settings` table has not been created yet.

import type { Env } from "./_shared";

export interface StoredIntegrations {
  resendApiKey?: string;
  cloudflareApiToken?: string;
  cloudflareAccountId?: string;
  xaiApiKey?: string;
  openrouterKey?: string;
}

export type IntegrationProvider = "resend" | "cloudflare" | "xai" | "openrouter";

export interface ProviderStatus {
  configured: boolean;
  source: "ui" | "env" | "none";
  preview: string | null;
}

// Short per-isolate cache to avoid repeating the same Supabase lookup
// multiple times within a single burst of API calls.
const CACHE_TTL_MS = 10_000;
let cachedKey = "";
let cachedAt = 0;
let cachedValue: StoredIntegrations | null = null;
let cachedHasTable = true;

export function invalidateRuntimeEnvCache() {
  cachedAt = 0;
  cachedValue = null;
}

export function maskSecret(value?: string | null): string | null {
  const v = (value || "").trim();
  if (!v) return null;
  if (v.length <= 8) return "••••••••";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

export async function readStoredIntegrations(
  env: Env,
  bypassCache = false
): Promise<{ integrations: StoredIntegrations; hasTable: boolean }> {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_SERVICE_KEY) {
    return { integrations: {}, hasTable: false };
  }

  const cacheId = `${env.SUPABASE_URL}`;
  if (!bypassCache && cachedValue && cachedKey === cacheId && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { integrations: cachedValue, hasTable: cachedHasTable };
  }

  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/email_settings?key=eq.integrations&select=value&limit=1`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const missingTable =
        res.status === 404 || text.includes("PGRST205") || text.includes("42P01");
      cachedKey = cacheId;
      cachedAt = Date.now();
      cachedValue = {};
      cachedHasTable = !missingTable;
      return { integrations: {}, hasTable: !missingTable };
    }

    const rows = (await res.json()) as Array<{ value?: StoredIntegrations }>;
    const value =
      Array.isArray(rows) && rows[0]?.value && typeof rows[0].value === "object"
        ? rows[0].value
        : {};

    cachedKey = cacheId;
    cachedAt = Date.now();
    cachedValue = value;
    cachedHasTable = true;
    return { integrations: value, hasTable: true };
  } catch {
    return { integrations: {}, hasTable: cachedHasTable };
  }
}

export async function resolveEnv(env: Env, bypassCache = false): Promise<Env> {
  const { integrations } = await readStoredIntegrations(env, bypassCache);
  if (!integrations || Object.keys(integrations).length === 0) return env;

  return {
    ...env,
    RESEND_API_KEY: integrations.resendApiKey?.trim() || env.RESEND_API_KEY,
    CLOUDFLARE_API_TOKEN: integrations.cloudflareApiToken?.trim() || env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: integrations.cloudflareAccountId?.trim() || env.CLOUDFLARE_ACCOUNT_ID,
    XAI_API_KEY: integrations.xaiApiKey?.trim() || env.XAI_API_KEY,
    OPENROUTER_KEY: integrations.openrouterKey?.trim() || env.OPENROUTER_KEY,
  };
}

export async function getIntegrationStatuses(env: Env): Promise<{
  hasSettingsTable: boolean;
  providers: Record<IntegrationProvider, ProviderStatus>;
  cloudflareAccountIdPreview: string | null;
}> {
  const { integrations, hasTable } = await readStoredIntegrations(env, true);

  const build = (uiVal?: string, envVal?: string): ProviderStatus => {
    const ui = (uiVal || "").trim();
    const ev = (envVal || "").trim();
    if (ui) return { configured: true, source: "ui", preview: maskSecret(ui) };
    if (ev) return { configured: true, source: "env", preview: maskSecret(ev) };
    return { configured: false, source: "none", preview: null };
  };

  return {
    hasSettingsTable: hasTable,
    providers: {
      resend: build(integrations.resendApiKey, env.RESEND_API_KEY),
      cloudflare: build(integrations.cloudflareApiToken, env.CLOUDFLARE_API_TOKEN),
      xai: build(integrations.xaiApiKey, env.XAI_API_KEY),
      openrouter: build(integrations.openrouterKey, env.OPENROUTER_KEY),
    },
    cloudflareAccountIdPreview: maskSecret(
      integrations.cloudflareAccountId || env.CLOUDFLARE_ACCOUNT_ID
    ),
  };
}
