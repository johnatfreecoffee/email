import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// GET: List addresses for a domain  |  POST: Add address  |  DELETE: Remove address
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  if (request.method === "GET") {
    const domainId = url.searchParams.get("domain_id");
    if (!domainId) return errorResponse("domain_id is required", 400, origin);

    const { data, ok } = await supabaseQuery(
      env,
      `/email_addresses?domain_id=eq.${domainId}&order=address.asc`
    );
    if (!ok) return errorResponse("Failed to fetch addresses", 500, origin);
    return jsonResponse(data, 200, origin);
  }

  if (request.method === "POST") {
    const body = await request.json() as {
      domain_id: string;
      address: string;
      display_name?: string;
    };

    if (!body.domain_id || !body.address) {
      return errorResponse("domain_id and address are required", 400, origin);
    }

    // Validate address: only local part, no @
    const localPart = body.address.toLowerCase().trim().replace(/@.*$/, "");
    if (!localPart || /[^a-z0-9._-]/.test(localPart)) {
      return errorResponse("Invalid address. Use only letters, numbers, dots, hyphens, underscores.", 400, origin);
    }

    const { data, ok } = await supabaseQuery(env, "/email_addresses", {
      method: "POST",
      body: {
        domain_id: body.domain_id,
        address: localPart,
        display_name: body.display_name || null,
      },
    });

    if (!ok) return errorResponse(`Failed to create address: ${JSON.stringify(data)}`, 500, origin);
    return jsonResponse(Array.isArray(data) ? data[0] : data, 201, origin);
  }

  if (request.method === "PATCH") {
    const addressId = url.searchParams.get("id");
    if (!addressId) return errorResponse("id is required", 400, origin);

    const body = await request.json() as {
      display_name?: string | null;
      address?: string;
    };

    const updates: Record<string, any> = {};

    if (body.display_name !== undefined) {
      const trimmed = (body.display_name || "").trim();
      updates.display_name = trimmed.length > 0 ? trimmed : null;
    }

    if (body.address !== undefined) {
      const localPart = body.address.toLowerCase().trim().replace(/@.*$/, "");
      if (!localPart || /[^a-z0-9._-]/.test(localPart)) {
        return errorResponse("Invalid address. Use only letters, numbers, dots, hyphens, underscores.", 400, origin);
      }
      // Collision check within same domain
      const existing = await supabaseQuery(
        env,
        `/email_addresses?id=eq.${addressId}&select=domain_id,address`
      );
      if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
        const row = existing.data[0];
        if (row.address !== localPart) {
          const dup = await supabaseQuery(
            env,
            `/email_addresses?domain_id=eq.${row.domain_id}&address=eq.${localPart}&id=neq.${addressId}&select=id`
          );
          if (dup.ok && Array.isArray(dup.data) && dup.data.length > 0) {
            return errorResponse(`Address "${localPart}" already exists on this domain`, 409, origin);
          }
        }
      }
      updates.address = localPart;
    }

    if (Object.keys(updates).length === 0) {
      return errorResponse("No updatable fields provided", 400, origin);
    }

    const { data, ok } = await supabaseQuery(env, `/email_addresses?id=eq.${addressId}`, {
      method: "PATCH",
      body: updates,
    });

    if (!ok) return errorResponse(`Failed to update address: ${JSON.stringify(data)}`, 500, origin);
    return jsonResponse(Array.isArray(data) ? data[0] : data, 200, origin);
  }

  if (request.method === "DELETE") {
    const addressId = url.searchParams.get("id");
    if (!addressId) return errorResponse("id is required", 400, origin);

    const { ok } = await supabaseQuery(env, `/email_addresses?id=eq.${addressId}`, {
      method: "DELETE",
    });
    if (!ok) return errorResponse("Failed to delete address", 500, origin);
    return jsonResponse({ deleted: true }, 200, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
