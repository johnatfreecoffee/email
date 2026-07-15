import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// GET: List drafts
// POST: Save/create draft
// PATCH: Update draft
// DELETE: Delete draft
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  // GET: List drafts
  if (request.method === "GET") {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (id) {
      const res = await supabaseQuery(env, `/email_drafts?id=eq.${id}&limit=1`);
      if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
        return jsonResponse(res.data[0], 200, origin);
      }
      return errorResponse("Draft not found", 404, origin);
    }

    const res = await supabaseQuery(env, "/email_drafts?order=updated_at.desc&limit=50");
    return jsonResponse(res.data || [], 200, origin);
  }

  // POST: Create draft
  if (request.method === "POST") {
    const body = await request.json() as any;
    const res = await supabaseQuery(env, "/email_drafts", {
      method: "POST",
      body: {
        from_address: body.from || null,
        to_addresses: body.to || [],
        cc_addresses: body.cc || [],
        bcc_addresses: body.bcc || [],
        subject: body.subject || "",
        body_html: body.html || "",
        body_text: body.text || "",
        domain_id: body.domain_id || null,
        reply_to_message_id: body.reply_to_message_id || null,
        compose_mode: body.compose_mode || "new",
      },
    });
    if (!res.ok) return errorResponse("Failed to save draft", 500, origin);
    return jsonResponse(Array.isArray(res.data) ? res.data[0] : res.data, 201, origin);
  }

  // PATCH: Update draft
  if (request.method === "PATCH") {
    const body = await request.json() as any;
    if (!body.id) return errorResponse("id required", 400, origin);

    const updates: any = { updated_at: new Date().toISOString() };
    if (body.from !== undefined) updates.from_address = body.from;
    if (body.to !== undefined) updates.to_addresses = body.to;
    if (body.cc !== undefined) updates.cc_addresses = body.cc;
    if (body.bcc !== undefined) updates.bcc_addresses = body.bcc;
    if (body.subject !== undefined) updates.subject = body.subject;
    if (body.html !== undefined) updates.body_html = body.html;
    if (body.text !== undefined) updates.body_text = body.text;

    const res = await supabaseQuery(env, `/email_drafts?id=eq.${body.id}`, {
      method: "PATCH",
      body: updates,
    });
    return jsonResponse({ updated: true }, 200, origin);
  }

  // DELETE: Delete draft
  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return errorResponse("id required", 400, origin);

    await supabaseQuery(env, `/email_drafts?id=eq.${id}`, { method: "DELETE" });
    return jsonResponse({ deleted: true }, 200, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
