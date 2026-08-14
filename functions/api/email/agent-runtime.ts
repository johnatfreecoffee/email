import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

const STALE_MS = 120_000;

function isMissingTable(res: { status: number; data: unknown }): boolean {
  const code = (res.data as { code?: string } | null)?.code;
  return code === "PGRST205" || code === "42P01" || res.status === 404;
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  if (request.method === "OPTIONS") return optionsResponse(origin);
  const authError = await checkAuth(request, env);
  if (authError) return authError;
  if (request.method !== "GET") return errorResponse("method", 405, origin);

  const res = await supabaseQuery(env, "/agent_runtime?id=eq.1");
  if (!res.ok) {
    if (isMissingTable(res)) {
      return jsonResponse(
        { hands: "local", worker_seen_at: null, stale: true, online: false, needs_migration: true },
        200,
        origin
      );
    }
    return errorResponse("Failed to load runtime", 500, origin);
  }
  const row = Array.isArray(res.data) ? (res.data[0] as Record<string, unknown> | undefined) : undefined;
  const seen = typeof row?.worker_seen_at === "string" ? row.worker_seen_at : null;
  let stale = true;
  if (seen) {
    const t = Date.parse(seen);
    stale = Number.isNaN(t) || Date.now() - t > STALE_MS;
  }
  return jsonResponse(
    {
      hands: row?.hands || "local",
      worker_seen_at: seen,
      stale,
      online: !stale,
    },
    200,
    origin
  );
};
