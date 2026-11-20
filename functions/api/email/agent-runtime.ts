import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

const STALE_MS = 120_000;
const VALID_HANDS = new Set(["auto", "local", "box", "api"]);

function isMissingTable(res: { status: number; data: unknown }): boolean {
  const code = (res.data as { code?: string } | null)?.code;
  return code === "PGRST205" || code === "42P01" || res.status === 404;
}

function isOnline(seen: string | null): boolean {
  if (!seen) return false;
  const t = Date.parse(seen);
  return !Number.isNaN(t) && Date.now() - t <= STALE_MS;
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  if (request.method === "OPTIONS") return optionsResponse(origin);
  const authError = await checkAuth(request, env);
  if (authError) return authError;

  if (request.method === "POST" || request.method === "PATCH") {
    let body: { hands?: string } = {};
    try {
      body = (await request.json()) as { hands?: string };
    } catch {
      return errorResponse("Invalid JSON body", 400, origin);
    }
    const hands = String(body.hands || "").trim().toLowerCase();
    if (!VALID_HANDS.has(hands)) {
      return errorResponse("hands must be one of: auto, local, box, api", 400, origin);
    }
    const up = await supabaseQuery(env, "/agent_runtime?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: { id: 1, hands },
    });
    if (!up.ok) {
      if (isMissingTable(up)) {
        return errorResponse("agent_runtime table missing — run the Setup SQL bundle first", 400, origin);
      }
      return errorResponse("Failed to save agent routing mode", 500, origin);
    }
    return jsonResponse({ ok: true, hands }, 200, origin);
  }

  if (request.method !== "GET") return errorResponse("method", 405, origin);

  const res = await supabaseQuery(env, "/agent_runtime?id=eq.1");
  if (!res.ok) {
    if (isMissingTable(res)) {
      return jsonResponse(
        {
          hands: "auto",
          worker_seen_at: null,
          box_seen_at: null,
          stale: true,
          online: false,
          box_online: false,
          needs_migration: true,
        },
        200,
        origin
      );
    }
    return errorResponse("Failed to load runtime", 500, origin);
  }
  const row = Array.isArray(res.data) ? (res.data[0] as Record<string, unknown> | undefined) : undefined;
  const workerSeen = typeof row?.worker_seen_at === "string" ? row.worker_seen_at : null;
  const boxSeen = typeof row?.box_seen_at === "string" ? row.box_seen_at : null;
  const online = isOnline(workerSeen);
  const boxOnline = isOnline(boxSeen);
  const rawHands = typeof row?.hands === "string" ? row.hands : "auto";
  const hands = VALID_HANDS.has(rawHands) ? rawHands : "auto";

  return jsonResponse(
    {
      hands,
      worker_seen_at: workerSeen,
      box_seen_at: boxSeen,
      stale: !online,
      online,
      box_online: boxOnline,
    },
    200,
    origin
  );
};
