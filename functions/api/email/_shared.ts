// Shared helpers for email API functions

export interface Env {
  RESEND_API_KEY: string;
  CLOUDFLARE_API_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  OPENROUTER_KEY?: string;
  /** Shared-secret gate for the standalone email fork (X-MC-Auth header). */
  MC_API_SECRET?: string;
}

// Validate X-MC-Auth: shared secret → mc_sessions → legacy token.
// Returns null on pass, a 401 Response on fail. Callers: if (err) return err.
export async function checkAuth(request: Request, env?: Env): Promise<Response | null> {
  const token = request.headers.get("X-MC-Auth");
  const origin = request.headers.get("Origin") || undefined;

  if (!token) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  // 1. Shared-secret gate (standalone fork primary auth)
  if (env?.MC_API_SECRET && token === env.MC_API_SECRET) {
    return null;
  }

  // 2. Session store + legacy fallback (shared Supabase / MC compatibility)
  if (env?.SUPABASE_URL && env?.SUPABASE_SERVICE_KEY) {
    const now = new Date().toISOString();
    const sessRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/mc_sessions?token=eq.${encodeURIComponent(token)}&expires_at=gte.${now}&limit=1`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const sessions = await sessRes.json();
    if (Array.isArray(sessions) && sessions.length > 0) {
      return null;
    }
    // Legacy MC back-door hash for "[redacted]"
    if (token === legacyHashPassword("[redacted]")) {
      return null;
    }
    return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  // 3. No env configured → accept any non-empty token (local/misconfig escape hatch)
  return null;
}

// Legacy hash for backward compatibility
function legacyHashPassword(password: string): string {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return "mc_" + Math.abs(hash).toString(16);
}

export function corsHeaders(origin?: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-MC-Auth",
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonResponse(data: unknown, status = 200, origin?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

export function errorResponse(message: string, status = 400, origin?: string) {
  return jsonResponse({ error: message }, status, origin);
}

export function optionsResponse(origin?: string) {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// Supabase REST helper
export async function supabaseQuery(
  env: Env,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
) {
  const url = `${env.SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.method === "POST" ? "return=representation" : "return=representation",
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  return { data, status: res.status, ok: res.ok, headers: res.headers };
}

// Resend API helper
export async function resendAPI(
  env: Env,
  path: string,
  options: { method?: string; body?: unknown } = {}
) {
  const res = await fetch(`https://api.resend.com${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  return { data, status: res.status, ok: res.ok };
}

// Cloudflare DNS API helper
export async function cloudflareDNS(
  env: Env,
  path: string,
  options: { method?: string; body?: unknown } = {}
) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  return { data, status: res.status, ok: res.ok };
}
