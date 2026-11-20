// Plug-and-play Setup configuration API:
// - GET: returns masked provider key status (never exposes raw keys)
// - POST action="save_key": live-verifies a pasted key against Resend / Cloudflare / xAI / OpenRouter and persists it to email_settings
// - POST action="clear_key": removes a UI-saved override (reverts to env var if set)
// - POST action="provision_webhook": 1-click registers /api/email/inbound on Resend
// - POST action="list_cf_zones": fetches active Cloudflare zones for 1-click domain picking

import {
  Env,
  jsonResponse,
  errorResponse,
  optionsResponse,
  supabaseQuery,
  checkAuth,
} from "./_shared";
import {
  type IntegrationProvider,
  type StoredIntegrations,
  readStoredIntegrations,
  resolveEnv,
  getIntegrationStatuses,
  invalidateRuntimeEnvCache,
} from "./_runtime-env";

interface CFContext {
  request: Request;
  env: Env;
}

interface CfZone {
  id: string;
  name: string;
  status: string;
}

async function fetchCfZones(token: string): Promise<CfZone[]> {
  try {
    const res = await fetch(
      "https://api.cloudflare.com/client/v4/zones?per_page=30&status=active",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { result?: Array<{ id?: string; name?: string; status?: string }> };
    if (!Array.isArray(data?.result)) return [];
    return data.result
      .filter((z) => z.id && z.name)
      .map((z) => ({
        id: String(z.id),
        name: String(z.name),
        status: String(z.status || "active"),
      }));
  } catch {
    return [];
  }
}

async function verifyProviderKey(
  provider: IntegrationProvider,
  value: string
): Promise<{ ok: boolean; detail: string; zones?: CfZone[] }> {
  const key = value.trim();
  if (!key) return { ok: false, detail: "Key cannot be empty" };

  try {
    if (provider === "resend") {
      const res = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        return { ok: false, detail: body.message || `Resend rejected key (HTTP ${res.status})` };
      }
      const data = (await res.json()) as { data?: unknown[] };
      const count = Array.isArray(data?.data) ? data.data.length : 0;
      return { ok: true, detail: count ? `Connected · ${count} domain(s) in Resend` : "Connected to Resend" };
    }

    if (provider === "cloudflare") {
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${key}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        errors?: Array<{ message?: string }>;
      };
      if (!res.ok || data.success === false) {
        return {
          ok: false,
          detail: data.errors?.[0]?.message || `Cloudflare rejected token (HTTP ${res.status})`,
        };
      }
      const zones = await fetchCfZones(key);
      return {
        ok: true,
        detail: zones.length
          ? `Token valid · ${zones.length} active zone(s) found`
          : "Token valid (no active zones returned — check Zone:Read permission)",
        zones,
      };
    }

    if (provider === "xai") {
      const res = await fetch("https://api.x.ai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        return { ok: false, detail: `xAI rejected key (HTTP ${res.status})` };
      }
      return { ok: true, detail: "Connected · Cloud Q&A ready" };
    }

    if (provider === "openrouter") {
      const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        return { ok: false, detail: `OpenRouter rejected key (HTTP ${res.status})` };
      }
      return { ok: true, detail: "Connected · LLM junk assist enabled" };
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Network verification failed" };
  }

  return { ok: false, detail: "Unknown provider" };
}

async function saveIntegrations(
  env: Env,
  next: StoredIntegrations
): Promise<{ ok: boolean; needsMigration?: boolean; error?: string }> {
  const res = await supabaseQuery(env, "/email_settings", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: {
      key: "integrations",
      value: next,
      updated_at: new Date().toISOString(),
    },
  });
  if (!res.ok) {
    const code = (res.data as { code?: string } | null)?.code;
    const missing = res.status === 404 || code === "PGRST205" || code === "42P01";
    return {
      ok: false,
      needsMigration: missing,
      error: missing
        ? "Run the SQL migration in Supabase first so email_settings exists."
        : "Failed to save configuration to Supabase.",
    };
  }
  invalidateRuntimeEnvCache();
  return { ok: true };
}

export const onRequest = async (context: CFContext) => {
  const { request } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);
  const authError = await checkAuth(request, context.env);
  if (authError) return authError;

  if (request.method === "GET") {
    const status = await getIntegrationStatuses(context.env);
    return jsonResponse(status, 200, origin);
  }

  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405, origin);
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    provider?: IntegrationProvider;
    value?: string;
    accountId?: string;
    endpoint?: string;
  };

  const action = body.action;

  if (action === "save_key") {
    const provider = body.provider;
    const value = (body.value || "").trim();
    if (!provider || !["resend", "cloudflare", "xai", "openrouter"].includes(provider)) {
      return errorResponse("Valid provider required", 400, origin);
    }
    if (!value) {
      return errorResponse("API key / token is required", 400, origin);
    }

    const verify = await verifyProviderKey(provider, value);
    if (!verify.ok) {
      return jsonResponse({ ok: false, verified: false, detail: verify.detail }, 200, origin);
    }

    const { integrations } = await readStoredIntegrations(context.env, true);
    const next: StoredIntegrations = { ...integrations };
    if (provider === "resend") next.resendApiKey = value;
    if (provider === "cloudflare") {
      next.cloudflareApiToken = value;
      if (typeof body.accountId === "string" && body.accountId.trim()) {
        next.cloudflareAccountId = body.accountId.trim();
      }
    }
    if (provider === "xai") next.xaiApiKey = value;
    if (provider === "openrouter") next.openrouterKey = value;

    const saved = await saveIntegrations(context.env, next);
    if (!saved.ok) {
      return jsonResponse(
        {
          ok: false,
          verified: true,
          saved: false,
          needs_migration: !!saved.needsMigration,
          detail: saved.error || "Verified key, but could not persist to database.",
        },
        200,
        origin
      );
    }

    const status = await getIntegrationStatuses(context.env);
    return jsonResponse(
      {
        ok: true,
        verified: true,
        saved: true,
        detail: verify.detail,
        zones: verify.zones,
        status,
      },
      200,
      origin
    );
  }

  if (action === "clear_key") {
    const provider = body.provider;
    if (!provider || !["resend", "cloudflare", "xai", "openrouter"].includes(provider)) {
      return errorResponse("Valid provider required", 400, origin);
    }
    const { integrations } = await readStoredIntegrations(context.env, true);
    const next: StoredIntegrations = { ...integrations };
    if (provider === "resend") delete next.resendApiKey;
    if (provider === "cloudflare") {
      delete next.cloudflareApiToken;
      delete next.cloudflareAccountId;
    }
    if (provider === "xai") delete next.xaiApiKey;
    if (provider === "openrouter") delete next.openrouterKey;

    const saved = await saveIntegrations(context.env, next);
    if (!saved.ok) return errorResponse(saved.error || "Failed to clear key", 500, origin);
    const status = await getIntegrationStatuses(context.env);
    return jsonResponse({ ok: true, status }, 200, origin);
  }

  if (action === "provision_webhook") {
    const env = await resolveEnv(context.env, true);
    if (!env.RESEND_API_KEY) {
      return jsonResponse(
        { ok: false, detail: "Connect your Resend API key first." },
        200,
        origin
      );
    }

    const reqOrigin = new URL(request.url).origin;
    const endpoint = (body.endpoint || `${reqOrigin}/api/email/inbound`).trim();

    if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(endpoint)) {
      return jsonResponse(
        {
          ok: false,
          detail:
            "Resend cannot POST webhooks to localhost. Deploy to Cloudflare Pages (or paste your tunnel URL) first.",
        },
        200,
        origin
      );
    }

    // Check existing webhooks first so provisioning is idempotent
    const listRes = await fetch("https://api.resend.com/webhooks", {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    });
    if (listRes.ok) {
      const listData = (await listRes.json().catch(() => ({}))) as {
        data?: Array<{ id?: string; endpoint?: string; events?: string[] }>;
      };
      const hit = (listData.data || []).find(
        (w) => String(w.endpoint || "").toLowerCase() === endpoint.toLowerCase()
      );
      if (hit) {
        return jsonResponse(
          {
            ok: true,
            alreadyExists: true,
            endpoint,
            webhookId: hit.id,
            detail: "Inbound webhook is already connected to this app.",
          },
          200,
          origin
        );
      }
    }

    const createRes = await fetch("https://api.resend.com/webhooks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        endpoint,
        events: ["email.received", "email.sent"],
      }),
    });

    const createData = (await createRes.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      error?: string;
    };

    if (!createRes.ok) {
      return jsonResponse(
        {
          ok: false,
          detail:
            createData.message ||
            createData.error ||
            `Resend could not create webhook (HTTP ${createRes.status}). Make sure your API key has Full Access.`,
        },
        200,
        origin
      );
    }

    return jsonResponse(
      {
        ok: true,
        created: true,
        endpoint,
        webhookId: createData.id,
        detail: "Inbound webhook created on Resend!",
      },
      200,
      origin
    );
  }

  if (action === "list_cf_zones") {
    const env = await resolveEnv(context.env, true);
    if (!env.CLOUDFLARE_API_TOKEN) {
      return jsonResponse({ ok: true, zones: [] }, 200, origin);
    }
    const zones = await fetchCfZones(env.CLOUDFLARE_API_TOKEN);
    return jsonResponse({ ok: true, zones }, 200, origin);
  }

  return errorResponse("Unknown action", 400, origin);
};
