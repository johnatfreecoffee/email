import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// Sender reputation management for Settings → Junk Mail.
// GET ?verdict=spam|trusted&search=&limit=&offset= — list overrides/cached verdicts
// PATCH {from_address, verdict} — flip a sender (user_override=true)
// DELETE ?from_address= — forget a sender (classify fresh next time)
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(request, env);
  if (authError) return authError;

  if (request.method === "GET") {
    const verdict = url.searchParams.get("verdict");
    if (verdict !== "spam" && verdict !== "trusted") {
      return errorResponse("verdict must be spam or trusted", 400, origin);
    }
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const search = url.searchParams.get("search");

    let path = `/email_sender_reputation?verdict=eq.${verdict}&order=last_seen_at.desc.nullslast&limit=${limit}&offset=${offset}`;
    path += `&select=from_address,verdict,spam_score,user_override,last_seen_at`;
    if (search) {
      const q = encodeURIComponent(search.replace(/[,()"'\\]/g, " ").trim());
      path += `&from_address=ilike.*${q}*`;
    }

    const { data, ok } = await supabaseQuery(env, path);
    if (!ok) return errorResponse("Failed to load senders", 500, origin);
    return jsonResponse(Array.isArray(data) ? data : [], 200, origin);
  }

  if (request.method === "PATCH") {
    const body = (await request.json()) as { from_address?: string; verdict?: string };
    if (!body.from_address) return errorResponse("from_address is required", 400, origin);
    if (body.verdict !== "spam" && body.verdict !== "trusted") {
      return errorResponse("verdict must be spam or trusted", 400, origin);
    }
    const now = new Date().toISOString();
    const score = body.verdict === "spam" ? 1.0 : 0.0;
    const upd = await supabaseQuery(
      env,
      `/email_sender_reputation?from_address=eq.${encodeURIComponent(body.from_address)}`,
      {
        method: "PATCH",
        body: { verdict: body.verdict, spam_score: score, user_override: true, updated_at: now },
      }
    );
    if (!upd.ok) return errorResponse("Failed to update sender", 500, origin);
    if (!Array.isArray(upd.data) || upd.data.length === 0) {
      const ins = await supabaseQuery(env, "/email_sender_reputation", {
        method: "POST",
        body: { from_address: body.from_address, verdict: body.verdict, spam_score: score, user_override: true },
      });
      if (!ins.ok) return errorResponse("Failed to update sender", 500, origin);
    }
    return jsonResponse({ from_address: body.from_address, verdict: body.verdict }, 200, origin);
  }

  if (request.method === "DELETE") {
    const fromAddress = url.searchParams.get("from_address");
    if (!fromAddress) return errorResponse("from_address is required", 400, origin);
    const { ok } = await supabaseQuery(
      env,
      `/email_sender_reputation?from_address=eq.${encodeURIComponent(fromAddress)}`,
      { method: "DELETE" }
    );
    if (!ok) return errorResponse("Failed to delete sender", 500, origin);
    return jsonResponse({ deleted: true }, 200, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
