import {
  Env,
  jsonResponse,
  errorResponse,
  optionsResponse,
  supabaseQuery,
  checkAuth,
} from "./_shared";
import { isAgentLocal, agentDisplayName } from "./_agent";

interface CFContext {
  request: Request;
  env: Env;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const MODES = new Set(["ask", "custom", "all"]);

function isMissingTable(res: { status: number; data: unknown }): boolean {
  const code = (res.data as { code?: string } | null)?.code;
  return code === "PGRST205" || code === "42P01" || res.status === 404;
}

const MIGRATION =
  "agent_senders table missing — run migrations/email-agent-senders.sql in the Supabase SQL editor";

function normalizeEmail(raw: unknown): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^.*<([^>]+)>.*$/, "$1")
    .replace(/[<>"']/g, "");
}

function normalizeGrant(raw: unknown): { enabled: boolean; mode: string; perms: Record<string, boolean> } {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const p = src.perms && typeof src.perms === "object" ? (src.perms as Record<string, unknown>) : {};
  const perms = {
    read: !!p.read,
    write: !!p.write,
    update: !!p.update,
    delete: !!p.delete,
  };
  let mode = MODES.has(String(src.mode)) ? String(src.mode) : "ask";
  if (mode === "all") {
    perms.read = perms.write = perms.update = perms.delete = true;
  }
  if (mode === "ask") {
    perms.read = true;
    perms.write = perms.update = perms.delete = false;
  }
  if (perms.read && perms.write && perms.update && perms.delete) mode = "all";
  else if (!perms.write && !perms.update && !perms.delete) mode = "ask";
  else mode = "custom";
  return { enabled: !!src.enabled, mode, perms };
}

function publicUser(
  row: Record<string, unknown>,
  grants: Array<Record<string, unknown>>,
  catalog: string[]
) {
  const agents: Record<string, ReturnType<typeof normalizeGrant>> = {};
  for (const local of catalog) agents[local] = normalizeGrant({ enabled: false, mode: "ask" });
  for (const g of grants) {
    const local = String(g.agent_local || "").toLowerCase();
    if (!local) continue;
    agents[local] = normalizeGrant(g);
  }
  return {
    id: row.id,
    first_name: row.first_name || "",
    last_name: row.last_name || "",
    email: normalizeEmail(row.email),
    archived: !!row.archived,
    created_at: row.created_at,
    updated_at: row.updated_at,
    agents,
  };
}

async function loadCatalog(env: Env): Promise<Array<{
  local_part: string;
  display_name: string;
  is_active: boolean;
  mailbox: string;
}>> {
  const res = await supabaseQuery(
    env,
    "/email_addresses?select=id,address,display_name,is_active,domain_id&order=address.asc"
  );
  const domains = await supabaseQuery(env, "/email_domains?select=id,domain");
  const domainById = new Map(
    (Array.isArray(domains.data) ? domains.data : []).map((d: { id: string; domain: string }) => [d.id, d.domain])
  );
  const out: Array<{ local_part: string; display_name: string; is_active: boolean; mailbox: string }> = [];
  if (res.ok && Array.isArray(res.data)) {
    for (const a of res.data as Array<{
      address?: string;
      display_name?: string | null;
      is_active?: boolean;
      domain_id?: string;
    }>) {
      const local = String(a.address || "").toLowerCase();
      if (!isAgentLocal(local)) continue;
      const domain = domainById.get(String(a.domain_id || "")) || "";
      out.push({
        local_part: local,
        display_name: a.display_name || agentDisplayName(local),
        is_active: a.is_active !== false,
        mailbox: domain ? `${local}@${domain}` : local,
      });
    }
  }
  return out;
}

async function loadUserBundle(env: Env, id: string, catalog: string[]) {
  const u = await supabaseQuery(env, `/agent_senders?id=eq.${id}`);
  if (!u.ok || !Array.isArray(u.data) || !u.data[0]) return null;
  const g = await supabaseQuery(env, `/agent_sender_grants?sender_id=eq.${id}`);
  const grants = g.ok && Array.isArray(g.data) ? (g.data as Array<Record<string, unknown>>) : [];
  return publicUser(u.data[0] as Record<string, unknown>, grants, catalog);
}

async function replaceGrants(
  env: Env,
  senderId: string,
  agents: unknown,
  catalog: Set<string>
): Promise<string | null> {
  const src = agents && typeof agents === "object" ? (agents as Record<string, unknown>) : {};
  const del = await supabaseQuery(env, `/agent_sender_grants?sender_id=eq.${senderId}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  if (!del.ok && !isMissingTable(del)) return "failed to replace grants";
  const rows = [];
  for (const [local, raw] of Object.entries(src)) {
    const key = local.trim().toLowerCase();
    if (!catalog.has(key)) continue;
    const g = normalizeGrant(raw);
    rows.push({
      sender_id: senderId,
      agent_local: key,
      enabled: g.enabled,
      mode: g.mode,
      perms: g.perms,
    });
  }
  if (!rows.length) return null;
  const ins = await supabaseQuery(env, "/agent_sender_grants", { method: "POST", body: rows });
  if (!ins.ok) return "failed to save grants";
  return null;
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return optionsResponse(origin);
  const authError = await checkAuth(request, env);
  if (authError) return authError;

  const catalogRows = await loadCatalog(env);
  const catalogLocals = catalogRows.map((a) => a.local_part);
  const catalogSet = new Set(catalogLocals);

  if (request.method === "GET") {
    const tab = url.searchParams.get("tab") === "archived";
    const senders = await supabaseQuery(
      env,
      `/agent_senders?archived=eq.${tab}&order=last_name.asc,first_name.asc`
    );
    if (!senders.ok) {
      if (isMissingTable(senders)) {
        return jsonResponse({ users: [], agents: catalogRows, needs_migration: true }, 200, origin);
      }
      return errorResponse("Failed to load users", 500, origin);
    }
    const rows = Array.isArray(senders.data) ? (senders.data as Array<Record<string, unknown>>) : [];
    const ids = rows.map((r) => r.id).filter(Boolean);
    let grants: Array<Record<string, unknown>> = [];
    if (ids.length) {
      const g = await supabaseQuery(
        env,
        `/agent_sender_grants?sender_id=in.(${ids.join(",")})`
      );
      if (g.ok && Array.isArray(g.data)) grants = g.data as Array<Record<string, unknown>>;
    }
    const bySender = new Map<string, Array<Record<string, unknown>>>();
    for (const g of grants) {
      const sid = String(g.sender_id);
      if (!bySender.has(sid)) bySender.set(sid, []);
      bySender.get(sid)!.push(g);
    }
    const users = rows.map((r) => publicUser(r, bySender.get(String(r.id)) || [], catalogLocals));
    return jsonResponse({ users, agents: catalogRows }, 200, origin);
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(url.searchParams.get("action") || "");
    const id = url.searchParams.get("id") || "";

    if ((action === "archive" || action === "restore") && UUID_RE.test(id)) {
      const upd = await supabaseQuery(env, `/agent_senders?id=eq.${id}`, {
        method: "PATCH",
        body: { archived: action === "archive", updated_at: new Date().toISOString() },
      });
      if (!upd.ok) {
        if (isMissingTable(upd)) return jsonResponse({ error: MIGRATION, needs_migration: true }, 503, origin);
        return errorResponse("Failed to update user", 500, origin);
      }
      const user = await loadUserBundle(env, id, catalogLocals);
      if (!user) return errorResponse("user not found", 404, origin);
      return jsonResponse({ user }, 200, origin);
    }

    const first = String(body.first_name || "").trim();
    const last = String(body.last_name || "").trim();
    const email = normalizeEmail(body.email);
    if (!first) return errorResponse("first name is required", 400, origin);
    if (!last) return errorResponse("last name is required", 400, origin);
    if (!EMAIL_RE.test(email)) return errorResponse("valid email is required", 400, origin);

    const ins = await supabaseQuery(env, "/agent_senders", {
      method: "POST",
      body: { first_name: first, last_name: last, email, archived: false },
    });
    if (!ins.ok) {
      if (isMissingTable(ins)) return jsonResponse({ error: MIGRATION, needs_migration: true }, 503, origin);
      const msg = JSON.stringify(ins.data);
      if (ins.status === 409 || /duplicate|unique/i.test(msg)) {
        return errorResponse("that email is already on the list", 400, origin);
      }
      return errorResponse("Failed to create user", 500, origin);
    }
    const created = Array.isArray(ins.data) ? ins.data[0] : ins.data;
    const newId = (created as { id?: string })?.id;
    if (!newId) return errorResponse("Failed to create user", 500, origin);
    const err = await replaceGrants(env, newId, body.agents, catalogSet);
    if (err) return errorResponse(err, 500, origin);
    const user = await loadUserBundle(env, newId, catalogLocals);
    return jsonResponse({ user }, 200, origin);
  }

  if (request.method === "PUT") {
    const id = url.searchParams.get("id") || "";
    if (!UUID_RE.test(id)) return errorResponse("id required", 400, origin);
    const body = (await request.json()) as Record<string, unknown>;
    const first = String(body.first_name || "").trim();
    const last = String(body.last_name || "").trim();
    const email = normalizeEmail(body.email);
    if (!first) return errorResponse("first name is required", 400, origin);
    if (!last) return errorResponse("last name is required", 400, origin);
    if (!EMAIL_RE.test(email)) return errorResponse("valid email is required", 400, origin);
    const upd = await supabaseQuery(env, `/agent_senders?id=eq.${id}`, {
      method: "PATCH",
      body: { first_name: first, last_name: last, email, updated_at: new Date().toISOString() },
    });
    if (!upd.ok) {
      if (isMissingTable(upd)) return jsonResponse({ error: MIGRATION, needs_migration: true }, 503, origin);
      const msg = JSON.stringify(upd.data);
      if (upd.status === 409 || /duplicate|unique/i.test(msg)) {
        return errorResponse("that email is already on the list", 400, origin);
      }
      return errorResponse("Failed to save user", 500, origin);
    }
    if (!Array.isArray(upd.data) || !upd.data.length) return errorResponse("user not found", 404, origin);
    const err = await replaceGrants(env, id, body.agents, catalogSet);
    if (err) return errorResponse(err, 500, origin);
    const user = await loadUserBundle(env, id, catalogLocals);
    return jsonResponse({ user }, 200, origin);
  }

  return errorResponse("method", 405, origin);
};
