import {
  Env,
  jsonResponse,
  errorResponse,
  optionsResponse,
  supabaseQuery,
  resendAPI,
  cloudflareDNS,
  checkAuth,
} from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

const STALE_MS = 120_000;

type Tile = {
  id: string;
  ok: boolean;
  configured: boolean;
  detail: string;
};

async function pingResend(env: Env): Promise<Tile> {
  if (!env.RESEND_API_KEY) return { id: "resend", ok: false, configured: false, detail: "RESEND_API_KEY missing" };
  const r = await resendAPI(env, "/domains");
  if (!r.ok) return { id: "resend", ok: false, configured: true, detail: "key rejected" };
  const n = Array.isArray((r.data as { data?: unknown[] })?.data) ? (r.data as { data: unknown[] }).data.length : 0;
  return { id: "resend", ok: true, configured: true, detail: n ? `${n} domain(s)` : "connected" };
}

async function pingSupabase(env: Env): Promise<Tile> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return { id: "supabase", ok: false, configured: false, detail: "SUPABASE_URL / SERVICE_KEY missing" };
  }
  const r = await supabaseQuery(env, "/email_domains?select=id&limit=1");
  if (!r.ok) return { id: "supabase", ok: false, configured: true, detail: "query failed" };
  return { id: "supabase", ok: true, configured: true, detail: "connected" };
}

async function pingCloudflare(env: Env): Promise<Tile> {
  if (!env.CLOUDFLARE_API_TOKEN) {
    return { id: "cloudflare", ok: false, configured: false, detail: "CLOUDFLARE_API_TOKEN missing" };
  }
  const r = await cloudflareDNS(env, "/user/tokens/verify");
  const ok = r.ok && (r.data as { success?: boolean })?.success !== false;
  return { id: "cloudflare", ok, configured: true, detail: ok ? "token valid" : "token rejected" };
}

async function pingDomain(env: Env): Promise<Tile> {
  const r = await supabaseQuery(env, "/email_domains?select=domain,status");
  if (!r.ok || !Array.isArray(r.data)) {
    return { id: "domain", ok: false, configured: false, detail: "no domains table" };
  }
  const rows = r.data as Array<{ domain?: string; status?: string }>;
  const ready = rows.filter((d) => {
    const s = (d.status || "").toLowerCase();
    return s === "dns_configured" || s === "verified" || s === "active" || !!d.domain;
  });
  if (!rows.length) return { id: "domain", ok: false, configured: false, detail: "add a domain in Accounts" };
  return { id: "domain", ok: ready.length > 0, configured: true, detail: `${rows.length} domain(s)` };
}

async function pingBox(env: Env): Promise<Tile> {
  const r = await supabaseQuery(env, "/agent_runtime?id=eq.1");
  if (!r.ok || !Array.isArray(r.data) || !r.data[0]) {
    return { id: "box", ok: false, configured: false, detail: "no heartbeat yet" };
  }
  const seen = (r.data[0] as { box_seen_at?: string }).box_seen_at;
  if (!seen) return { id: "box", ok: false, configured: false, detail: "not running — see worker/BOX.md" };
  const t = Date.parse(seen);
  const stale = Number.isNaN(t) || Date.now() - t > STALE_MS;
  return { id: "box", ok: !stale, configured: true, detail: stale ? "offline" : "online" };
}

async function pingChat(env: Env): Promise<Tile> {
  const key = env.XAI_API_KEY;
  if (!key) return { id: "chat", ok: false, configured: false, detail: "XAI_API_KEY missing" };
  return { id: "chat", ok: true, configured: true, detail: "ready (questions only when worker is offline)" };
}

async function pingWorker(env: Env): Promise<Tile> {
  const r = await supabaseQuery(env, "/agent_runtime?id=eq.1");
  if (!r.ok || !Array.isArray(r.data) || !r.data[0]) {
    return { id: "machine", ok: false, configured: false, detail: "no heartbeat yet" };
  }
  const seen = (r.data[0] as { worker_seen_at?: string }).worker_seen_at;
  if (!seen) return { id: "machine", ok: false, configured: true, detail: "never seen" };
  const t = Date.parse(seen);
  const stale = Number.isNaN(t) || Date.now() - t > STALE_MS;
  return {
    id: "machine",
    ok: !stale,
    configured: true,
    detail: stale ? "offline" : "online",
  };
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  if (request.method === "OPTIONS") return optionsResponse(origin);
  const authError = await checkAuth(request, env);
  if (authError) return authError;
  if (request.method !== "GET") return errorResponse("method", 405, origin);

  const [resend, supabase, cloudflare, domain, machine, chat, box] = await Promise.all([
    pingResend(env),
    pingSupabase(env),
    pingCloudflare(env),
    pingDomain(env),
    pingWorker(env),
    pingChat(env),
    pingBox(env),
  ]);

  return jsonResponse(
    {
      tiles: [resend, supabase, cloudflare, domain, machine, chat, box],
    },
    200,
    origin
  );
};
