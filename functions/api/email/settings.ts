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
] as const;

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

// GET: all settings | PATCH: upsert one key | PUT: bulk upsert (first sync)
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

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
    return jsonResponse({ settings, needs_migration: false }, 200, origin);
  }

  if (request.method === "PATCH") {
    const body = (await request.json()) as { key?: unknown; value?: unknown };
    if (!validKey(body.key)) return errorResponse("Unknown settings key", 400, origin);
    if (!validValue(body.value)) return errorResponse("value must be an object", 400, origin);

    const failure = await upsertSetting(env, origin, body.key, body.value);
    if (failure) return failure;
    return jsonResponse({ key: body.key, value: body.value }, 200, origin);
  }

  if (request.method === "PUT") {
    const body = (await request.json()) as { settings?: unknown };
    if (!validValue(body.settings)) return errorResponse("settings must be an object", 400, origin);

    const written: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body.settings)) {
      if (!validKey(key) || !validValue(value)) continue;
      const failure = await upsertSetting(env, origin, key, value);
      if (failure) return failure;
      written[key] = value;
    }
    return jsonResponse({ settings: written, needs_migration: false }, 200, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
