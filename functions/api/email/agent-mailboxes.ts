import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";
import { isAgentLocal, agentDisplayName } from "./_agent";

interface CFContext {
  request: Request;
  env: Env;
}

function slugify(raw: string): string {
  let s = String(raw || "").trim().toLowerCase();
  s = s.replace(/@.*$/, "");
  if (!s.startsWith("a.") && !s.startsWith("e.")) s = `a.${s.replace(/^a\.?/, "")}`;
  s = s.replace(/[^a-z0-9._-]/g, "-").replace(/\.+/g, ".").replace(/-+/g, "-");
  s = s.replace(/^[._-]+|[._-]+$/g, "");
  return s;
}

async function loadAgents(env: Env) {
  const addr = await supabaseQuery(
    env,
    "/email_addresses?select=id,address,display_name,is_active,domain_id,created_at&order=address.asc"
  );
  const domains = await supabaseQuery(env, "/email_domains?select=id,domain,status&order=domain.asc");
  const domainRows = Array.isArray(domains.data) ? (domains.data as Array<{ id: string; domain: string; status: string }>) : [];
  const domainById = new Map(domainRows.map((d) => [d.id, d]));
  const agents = [];
  if (addr.ok && Array.isArray(addr.data)) {
    for (const a of addr.data as Array<{
      id: string;
      address?: string;
      display_name?: string | null;
      is_active?: boolean;
      domain_id?: string;
      created_at?: string;
    }>) {
      const local = String(a.address || "").toLowerCase();
      if (!isAgentLocal(local)) continue;
      const d = domainById.get(String(a.domain_id || ""));
      agents.push({
        id: a.id,
        local_part: local,
        display_name: a.display_name || agentDisplayName(local),
        is_active: a.is_active !== false,
        domain_id: a.domain_id || null,
        domain: d?.domain || "",
        mailbox: d?.domain ? `${local}@${d.domain}` : local,
        created_at: a.created_at || null,
      });
    }
  }
  return {
    agents,
    domains: domainRows.map((d) => ({ id: d.id, domain: d.domain, status: d.status })),
  };
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return optionsResponse(origin);
  const authError = await checkAuth(request, env);
  if (authError) return authError;

  if (request.method === "GET") {
    const data = await loadAgents(env);
    return jsonResponse(data, 200, origin);
  }

  if (request.method === "POST") {
    const body = (await request.json()) as { domain_id?: string; name?: string; slug?: string };
    const domainId = String(body.domain_id || "").trim();
    const name = String(body.name || "").trim();
    const local = slugify(body.slug || name);
    if (!domainId) return errorResponse("Pick a domain first (Settings → Accounts).", 400, origin);
    if (!isAgentLocal(local) || local.length < 4) {
      return errorResponse("Use a short id like marketing or a.noknok", 400, origin);
    }
    const dup = await supabaseQuery(
      env,
      `/email_addresses?domain_id=eq.${domainId}&address=eq.${local}&select=id`
    );
    if (dup.ok && Array.isArray(dup.data) && dup.data.length) {
      return errorResponse(`${local} already exists on that domain`, 409, origin);
    }
    const ins = await supabaseQuery(env, "/email_addresses", {
      method: "POST",
      body: {
        domain_id: domainId,
        address: local,
        display_name: name || agentDisplayName(local),
        is_active: true,
      },
    });
    if (!ins.ok) return errorResponse(`Couldn't create that agent: ${JSON.stringify(ins.data)}`, 500, origin);
    const created = Array.isArray(ins.data) ? ins.data[0] : ins.data;
    const data = await loadAgents(env);
    return jsonResponse({ agent: created, ...data }, 201, origin);
  }

  if (request.method === "PATCH") {
    const id = url.searchParams.get("id") || "";
    if (!id) return errorResponse("id required", 400, origin);
    const body = (await request.json()) as { display_name?: string; is_active?: boolean };
    const updates: Record<string, unknown> = {};
    if (typeof body.display_name === "string") {
      const t = body.display_name.trim();
      updates.display_name = t || null;
    }
    if (typeof body.is_active === "boolean") updates.is_active = body.is_active;
    if (!Object.keys(updates).length) return errorResponse("nothing to update", 400, origin);
    const upd = await supabaseQuery(env, `/email_addresses?id=eq.${id}`, {
      method: "PATCH",
      body: updates,
    });
    if (!upd.ok) return errorResponse("Couldn't update that agent", 500, origin);
    const data = await loadAgents(env);
    return jsonResponse(data, 200, origin);
  }

  return errorResponse("method", 405, origin);
};
