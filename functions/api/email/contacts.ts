import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// GET: Search contacts (autocomplete)
// POST: Upsert a contact from send/receive activity
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  // GET: Search / autocomplete
  if (request.method === "GET") {
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const limit = parseInt(url.searchParams.get("limit") || "10");

    let path: string;
    if (q.length > 0) {
      // Search by email or display_name (case-insensitive)
      const encoded = encodeURIComponent(`%${q}%`);
      path = `/email_contacts?or=(email.ilike.${encoded},display_name.ilike.${encoded})&order=send_count.desc,receive_count.desc&limit=${limit}`;
    } else {
      // Return most contacted
      path = `/email_contacts?order=send_count.desc,receive_count.desc&limit=${limit}`;
    }

    const res = await supabaseQuery(env, path);
    return jsonResponse(res.data || [], 200, origin);
  }

  // POST: Upsert contact(s) — called internally from send/inbound
  if (request.method === "POST") {
    const body = await request.json() as {
      contacts: Array<{
        email: string;
        display_name?: string;
        direction: "sent" | "received";
      }>;
    };

    if (!body.contacts || !Array.isArray(body.contacts)) {
      return errorResponse("contacts array required", 400, origin);
    }

    const results = [];
    for (const c of body.contacts) {
      const email = c.email.toLowerCase().trim();
      if (!email || !email.includes("@")) continue;

      // Check if exists
      const existing = await supabaseQuery(env, `/email_contacts?email=eq.${encodeURIComponent(email)}&limit=1`);

      if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
        // Update counts and timestamp
        const current = existing.data[0];
        const updates: any = { updated_at: new Date().toISOString() };

        if (c.direction === "sent") {
          updates.send_count = (current.send_count || 0) + 1;
          updates.last_sent_at = new Date().toISOString();
        } else {
          updates.receive_count = (current.receive_count || 0) + 1;
          updates.last_received_at = new Date().toISOString();
        }

        // Update display name if we have one and existing doesn't
        if (c.display_name && !current.display_name) {
          updates.display_name = c.display_name;
        }

        await supabaseQuery(env, `/email_contacts?id=eq.${current.id}`, {
          method: "PATCH",
          body: updates,
        });
        results.push({ email, action: "updated" });
      } else {
        // Insert new
        await supabaseQuery(env, "/email_contacts", {
          method: "POST",
          body: {
            email,
            display_name: c.display_name || null,
            send_count: c.direction === "sent" ? 1 : 0,
            receive_count: c.direction === "received" ? 1 : 0,
            last_sent_at: c.direction === "sent" ? new Date().toISOString() : null,
            last_received_at: c.direction === "received" ? new Date().toISOString() : null,
          },
        });
        results.push({ email, action: "created" });
      }
    }

    return jsonResponse({ processed: results.length, results }, 200, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
