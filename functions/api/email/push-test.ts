import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";
import { broadcastPush } from "./_web-push";

interface CFContext {
  request: Request;
  env: Env;
}

// POST: Send a test push notification to all registered devices
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);
  if (request.method !== "POST") return errorResponse("Method not allowed", 405, origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  // Get all active subscriptions
  const subsRes = await supabaseQuery(env, "/mc_push_subscriptions?is_active=eq.true");
  if (!subsRes.ok || !Array.isArray(subsRes.data) || subsRes.data.length === 0) {
    return jsonResponse({
      success: false,
      error: "No active push subscriptions found. Enable notifications in Email settings first.",
      subscriptionCount: 0,
    }, 200, origin);
  }

  const vapidPublicKey = env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY;

  if (!vapidPublicKey || !vapidPrivateKey) {
    return errorResponse("VAPID keys not configured on server", 500, origin);
  }

  const testPayload = {
    title: "🧪 Mission Control Test",
    body: "Push notifications are working! This is a test from Mission Control.",
    type: "email",
    messageId: "test-" + Date.now(),
    from: "Brandon",
    subject: "Test Notification",
    domain: "test",
  };

  const results = await broadcastPush(subsRes.data, testPayload, vapidPublicKey, vapidPrivateKey);

  // Deactivate expired subscriptions
  for (const { id, result } of results) {
    if (result.status === 404 || result.status === 410) {
      await supabaseQuery(env, `/mc_push_subscriptions?id=eq.${id}`, {
        method: "PATCH",
        body: { is_active: false, updated_at: new Date().toISOString() },
      });
    }
  }

  return jsonResponse({
    success: results.some(r => r.result.success),
    results: results.map(r => ({
      id: r.id,
      success: r.result.success,
      status: r.result.status,
      error: r.result.error,
    })),
    subscriptionCount: subsRes.data.length,
  }, 200, origin);
};
