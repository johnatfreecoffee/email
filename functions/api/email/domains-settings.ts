import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// PATCH /api/email/domains-settings — update domain metadata in Supabase:
//   * catch_all_enabled — drives the "[Catch-All]" subject prefix MC adds to
//     mail addressed to an unknown local-part on the domain
//   * catch_all_subject_prefix — the literal prefix string
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  if (request.method !== "PATCH" && request.method !== "POST") return errorResponse("Method not allowed", 405, origin);

  const body = await request.json() as {
    domain_id: string;
    catch_all_enabled?: boolean;
    catch_all_subject_prefix?: string;
    catchall_destination_address_id?: string | null;
  };

  if (!body.domain_id) return errorResponse("domain_id is required", 400, origin);

  const dRes = await supabaseQuery(env, `/email_domains?id=eq.${body.domain_id}&select=id,domain&limit=1`);
  if (!dRes.ok || !Array.isArray(dRes.data) || dRes.data.length === 0) {
    return errorResponse("Domain not found", 404, origin);
  }

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.catch_all_enabled !== undefined) updates.catch_all_enabled = body.catch_all_enabled;
  if (body.catch_all_subject_prefix !== undefined) updates.catch_all_subject_prefix = body.catch_all_subject_prefix;
  if (body.catchall_destination_address_id !== undefined) {
    // null clears the destination; a UUID assigns it. Validate the address
    // belongs to this domain to avoid cross-domain attribution.
    if (body.catchall_destination_address_id) {
      const addrRes = await supabaseQuery(
        env,
        `/email_addresses?id=eq.${body.catchall_destination_address_id}&domain_id=eq.${body.domain_id}&select=id&limit=1`
      );
      if (!addrRes.ok || !Array.isArray(addrRes.data) || addrRes.data.length === 0) {
        return errorResponse("catchall_destination_address_id must reference an address on this domain", 400, origin);
      }
    }
    updates.catchall_destination_address_id = body.catchall_destination_address_id;
  }

  if (Object.keys(updates).length === 1) {
    return errorResponse("No fields to update", 400, origin);
  }

  const { data, ok } = await supabaseQuery(env, `/email_domains?id=eq.${body.domain_id}`, {
    method: "PATCH",
    body: updates,
  });
  if (!ok) return errorResponse("Failed to update domain settings", 500, origin);
  return jsonResponse(Array.isArray(data) ? data[0] : data, 200, origin);
};
