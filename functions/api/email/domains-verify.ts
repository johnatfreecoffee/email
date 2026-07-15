import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, resendAPI, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// POST: Re-verify a domain + check status
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  if (request.method !== "POST") return errorResponse("Method not allowed", 405, origin);

  const body = await request.json() as { domain_id: string; resend_domain_id: string };

  if (!body.resend_domain_id) return errorResponse("resend_domain_id is required", 400, origin);

  // Trigger verify
  await resendAPI(env, `/domains/${body.resend_domain_id}/verify`, { method: "POST" });

  // Check current status
  const statusRes = await resendAPI(env, `/domains/${body.resend_domain_id}`);

  if (!statusRes.ok) {
    return errorResponse("Failed to check domain status", 500, origin);
  }

  const resendDomain = statusRes.data as { status: string; records: any[] };

  // Update local DB
  if (body.domain_id) {
    await supabaseQuery(env, `/email_domains?id=eq.${body.domain_id}`, {
      method: "PATCH",
      body: {
        status: resendDomain.status === "verified" ? "active" : resendDomain.status,
        dns_records: resendDomain.records,
        updated_at: new Date().toISOString(),
      },
    });
  }

  return jsonResponse({
    status: resendDomain.status,
    records: resendDomain.records,
  }, 200, origin);
};
