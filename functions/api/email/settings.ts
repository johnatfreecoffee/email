import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

const KNOWN_KEYS = [
  "sidebar",
  "favorites",
  "viewing",
  "composing",
  "junk",
  "privacy",
  "signatures",
  "notifications",
] as const;

const USER_SIDEBAR_KEY = "sidebar";

// Signatures HTML is the big one; everything else is tiny.
const MAX_VALUE_BYTES = 100_000;

// PostgREST reports a missing table as 404 with code PGRST205 ("could not
// find the table in the schema cache"), or 400/404 with SQLSTATE 42P01.
function isMissingTable(res: { status: number; data: unknown }): boolean {
  const code = (res.data as { code?: string } | null)?.code;
  return code === "PGRST205" || code === "42P01" || res.status === 404;
}

function validKey(key: unknown): key is (typeof KNOWN_KEYS)[number] {
  return typeof key === "string" && (KNOWN_KEYS as readonly string[]).includes(key);
}

function validValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function userIdFromRequest(request: Request): string {
  const raw = request.headers.get("X-MC-User-Id")?.trim() || "local";
  const safe = raw.replace(/[^a-zA-Z0-9._@-]/g, "").slice(0, 128);
  return safe || "local";
}

function domainOrderFromValue(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const order = (value as { domainOrder?: unknown }).domainOrder;
  if (!Array.isArray(order)) return undefined;
  return order.filter((x): x is string => typeof x === "string");
}

function stripDomainOrder(value: Record<string, unknown>): Record<string, unknown> {
  const { domainOrder: _drop, ...rest } = value;
  return rest;
}

async function loadUserSidebarDomainOrder(
  env: Env,
  userId: string
): Promise<{ order: string[] | undefined; tableMissing: boolean }> {
  const res = await supabaseQuery(
    env,
    `/email_user_settings?user_id=eq.${encodeURIComponent(userId)}&key=eq.${encodeURIComponent(USER_SIDEBAR_KEY)}&select=value&limit=1`
  );
  if (!res.ok) {
    if (isMissingTable(res)) return { order: undefined, tableMissing: true };
    return { order: undefined, tableMissing: false };
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  const row = rows[0] as { value?: unknown } | undefined;
  return { order: domainOrderFromValue(row?.value), tableMissing: false };
}

async function upsertUserSidebarDomainOrder(
  env: Env,
  origin: string | undefined,
  userId: string,
  domainOrder: string[]
): Promise<Response | null> {
  const value = { domainOrder };
  if (JSON.stringify(value).length > MAX_VALUE_BYTES) {
    return errorResponse("domain order too large", 413, origin);
  }
  const now = new Date().toISOString();
  const upd = await supabaseQuery(
    env,
    `/email_user_settings?user_id=eq.${encodeURIComponent(userId)}&key=eq.${encodeURIComponent(USER_SIDEBAR_KEY)}`,
    {
      method: "PATCH",
      body: { value, updated_at: now },
    }
  );
  if (!upd.ok) {
    if (isMissingTable(upd)) {
      return jsonResponse(
        {
          error:
            "email_user_settings table missing — run migrations/email-user-settings.sql in the Supabase SQL editor",
          needs_migration: true,
        },
        503,
        origin
      );
    }
    return errorResponse("Failed to save user setting", 500, origin);
  }
  if (!Array.isArray(upd.data) || upd.data.length === 0) {
    const ins = await supabaseQuery(env, "/email_user_settings", {
      method: "POST",
      body: { user_id: userId, key: USER_SIDEBAR_KEY, value },
    });
    if (!ins.ok) {
      if (ins.status === 409) {
        const retry = await supabaseQuery(
          env,
          `/email_user_settings?user_id=eq.${encodeURIComponent(userId)}&key=eq.${encodeURIComponent(USER_SIDEBAR_KEY)}`,
          { method: "PATCH", body: { value, updated_at: now } }
        );
        if (retry.ok) return null;
      }
      return errorResponse("Failed to save user setting", 500, origin);
    }
  }
  return null;
}

// Upsert one settings row via the house PATCH-then-POST idiom. Returns a
// Response on failure, null on success.
async function upsertSetting(
  env: Env,
  origin: string | undefined,
  key: string,
  value: Record<string, unknown>
): Promise<Response | null> {
  if (JSON.stringify(value).length > MAX_VALUE_BYTES) {
    return errorResponse(`value for "${key}" exceeds ${MAX_VALUE_BYTES} bytes`, 413, origin);
  }
  const now = new Date().toISOString();
  const upd = await supabaseQuery(env, `/email_settings?key=eq.${encodeURIComponent(key)}`, {
    method: "PATCH",
    body: { value, updated_at: now },
  });
  if (!upd.ok) {
    if (isMissingTable(upd)) {
      return jsonResponse(
        {
          error: "email_settings table missing — run migrations/email-settings.sql in the Supabase SQL editor",
          needs_migration: true,
        },
        503,
        origin
      );
    }
    return errorResponse("Failed to save setting", 500, origin);
  }
  if (!Array.isArray(upd.data) || upd.data.length === 0) {
    const ins = await supabaseQuery(env, "/email_settings", {
      method: "POST",
      body: { key, value },
    });
    if (!ins.ok) {
      // Two devices raced the insert — settle with one more PATCH.
      if (ins.status === 409) {
        const retry = await supabaseQuery(env, `/email_settings?key=eq.${encodeURIComponent(key)}`, {
          method: "PATCH",
          body: { value, updated_at: now },
        });
        if (retry.ok) return null;
      }
      return errorResponse("Failed to save setting", 500, origin);
    }
  }
  return null;
}

async function mergeUserSidebarIntoSettings(
  env: Env,
  settings: Record<string, unknown>,
  userId: string
): Promise<{ settings: Record<string, unknown>; needsMigration: boolean }> {
  const { order, tableMissing } = await loadUserSidebarDomainOrder(env, userId);
  if (tableMissing) {
    return { settings, needsMigration: false };
  }
  if (!order) return { settings, needsMigration: false };
  const sidebar = settings.sidebar;
  const base =
    sidebar && typeof sidebar === "object" && !Array.isArray(sidebar)
      ? { ...(sidebar as Record<string, unknown>) }
      : {};
  base.domainOrder = order;
  return { settings: { ...settings, sidebar: base }, needsMigration: false };
}

// GET: all settings | PATCH: upsert one key | PUT: bulk upsert (first sync)
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  const userId = userIdFromRequest(request);

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(request, env);
  if (authError) return authError;

  if (request.method === "GET") {
    const res = await supabaseQuery(env, "/email_settings?select=key,value,updated_at");
    if (!res.ok) {
      if (isMissingTable(res)) {
        // The app is healthy — the table just isn't there yet.
        return jsonResponse({ settings: null, needs_migration: true }, 200, origin);
      }
      return errorResponse("Failed to load settings", 500, origin);
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    const settings: Record<string, unknown> = {};
    for (const row of rows as Array<{ key: string; value: unknown }>) {
      if (validKey(row.key)) settings[row.key] = row.value;
    }
    const merged = await mergeUserSidebarIntoSettings(env, settings, userId);
    return jsonResponse({ settings: merged.settings, needs_migration: false }, 200, origin);
  }

  if (request.method === "PATCH") {
    const body = (await request.json()) as { key?: unknown; value?: unknown };
    if (!validKey(body.key)) return errorResponse("Unknown settings key", 400, origin);
    if (!validValue(body.value)) return errorResponse("value must be an object", 400, origin);

    let valueToStore = body.value;
    if (body.key === "sidebar") {
      const domainOrder = domainOrderFromValue(body.value);
      if (domainOrder) {
        const userFailure = await upsertUserSidebarDomainOrder(env, origin, userId, domainOrder);
        if (userFailure) return userFailure;
      }
      valueToStore = stripDomainOrder(body.value);
    }

    const failure = await upsertSetting(env, origin, body.key, valueToStore);
    if (failure) return failure;
    return jsonResponse({ key: body.key, value: body.value }, 200, origin);
  }

  if (request.method === "PUT") {
    const body = (await request.json()) as { settings?: unknown };
    if (!validValue(body.settings)) return errorResponse("settings must be an object", 400, origin);

    const written: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body.settings)) {
      if (!validKey(key) || !validValue(value)) continue;
      let valueToStore = value;
      if (key === "sidebar") {
        const domainOrder = domainOrderFromValue(value);
        if (domainOrder) {
          const userFailure = await upsertUserSidebarDomainOrder(env, origin, userId, domainOrder);
          if (userFailure) return userFailure;
        }
        valueToStore = stripDomainOrder(value);
      }
      const failure = await upsertSetting(env, origin, key, valueToStore);
      if (failure) return failure;
      written[key] = value;
    }
    return jsonResponse({ settings: written, needs_migration: false }, 200, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
