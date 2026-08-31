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
  /** xAI HTTP API for questions-only when the local worker is offline. */
  XAI_API_KEY?: string;
}

// Validate X-MC-Auth: shared secret → optional mc_sessions.
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

  // 2. Session store (optional — shared-secret above is the primary gate)
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
    return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  // 3. No env configured → accept any non-empty token (local/misconfig escape hatch)
  return null;
}

export function corsHeaders(origin?: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
  // DELETE + Prefer: return=minimal is 204 with an empty body. res.json() throws.
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
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

/** Sign a private Storage object for browser <img> / <a href>. */
export async function signStoragePath(
  env: Env,
  bucket: string,
  path: string,
  expiresIn = 86400
): Promise<string | null> {
  const clean = String(path || "").replace(/^\/+/, "");
  if (!clean || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  const encoded = clean
    .split("/")
    .filter(Boolean)
    .map((p) => encodeURIComponent(p))
    .join("/");
  try {
    const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/${bucket}/${encoded}`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const rel = data.signedURL || data.signedUrl;
    if (!rel || typeof rel !== "string") return null;
    if (/^https?:\/\//i.test(rel)) return rel;
    const pathPart = rel.startsWith("/") ? rel : `/${rel}`;
    return `${env.SUPABASE_URL}/storage/v1${pathPart}`;
  } catch {
    return null;
  }
}

export async function withSignedAttachmentUrls(
  env: Env,
  rows: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    rows.map(async (row) => {
      const storagePath = typeof row.storage_path === "string" ? row.storage_path : "";
      const signed = storagePath ? await signStoragePath(env, "email-attachments", storagePath) : null;
      const publicUrl = storagePath
        ? `${env.SUPABASE_URL}/storage/v1/object/public/email-attachments/${storagePath}`
        : "";
      return {
        ...row,
        signed_url: signed || publicUrl || null,
        url: signed || publicUrl || null,
      };
    })
  );
}

export async function fetchStorageObject(
  env: Env,
  bucket: string,
  path: string
): Promise<Response | null> {
  const clean = String(path || "").replace(/^\/+/, "");
  if (!clean) return null;
  const encoded = clean
    .split("/")
    .filter(Boolean)
    .map((p) => encodeURIComponent(p))
    .join("/");
  try {
    const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${encoded}`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
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
