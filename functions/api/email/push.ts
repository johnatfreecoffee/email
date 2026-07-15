import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// POST: Subscribe to push notifications
// GET: Get VAPID public key
// DELETE: Unsubscribe
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  // GET: Return VAPID public key
  if (request.method === "GET") {
    const vapidKey = env.VAPID_PUBLIC_KEY || "";
    return jsonResponse({ vapidPublicKey: vapidKey }, 200, origin);
  }

  // POST: Save push subscription
  if (request.method === "POST") {
    const body = await request.json() as {
      subscription: PushSubscriptionJSON;
      label?: string; // e.g. "John's iPhone", "Chrome Desktop"
    };

    if (!body.subscription || !body.subscription.endpoint) {
      return errorResponse("subscription with endpoint required", 400, origin);
    }

    // Upsert by endpoint
    const existing = await supabaseQuery(
      env,
      `/mc_push_subscriptions?endpoint=eq.${encodeURIComponent(body.subscription.endpoint)}&limit=1`
    );

    if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
      // Update
      await supabaseQuery(env, `/mc_push_subscriptions?id=eq.${existing.data[0].id}`, {
        method: "PATCH",
        body: {
          subscription_json: body.subscription,
          label: body.label || existing.data[0].label,
          is_active: true,
          updated_at: new Date().toISOString(),
        },
      });
      return jsonResponse({ subscribed: true, updated: true }, 200, origin);
    }

    // Insert
    const res = await supabaseQuery(env, "/mc_push_subscriptions", {
      method: "POST",
      body: {
        endpoint: body.subscription.endpoint,
        subscription_json: body.subscription,
        label: body.label || "Unknown Device",
        is_active: true,
      },
    });

    if (!res.ok) {
      return errorResponse("Failed to save subscription", 500, origin);
    }

    return jsonResponse({ subscribed: true }, 201, origin);
  }

  // DELETE: Remove subscription
  if (request.method === "DELETE") {
    const body = await request.json() as { endpoint: string };
    if (!body.endpoint) {
      return errorResponse("endpoint required", 400, origin);
    }

    await supabaseQuery(
      env,
      `/mc_push_subscriptions?endpoint=eq.${encodeURIComponent(body.endpoint)}`,
      { method: "DELETE" }
    );

    return jsonResponse({ unsubscribed: true }, 200, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
