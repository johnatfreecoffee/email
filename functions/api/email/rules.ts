import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";
import type { RuleCondition, RuleAction } from "./_rules";

interface CFContext {
  request: Request;
  env: Env;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELDS = ["from", "to", "subject"];
const OPS = ["contains", "equals", "ends_with"];
const ACTION_TYPES = ["move_folder", "mark_read", "flag", "junk", "trash"];
const MOVE_FOLDERS = ["inbox", "archive"];

function isMissingTable(res: { status: number; data: unknown }): boolean {
  const code = (res.data as { code?: string } | null)?.code;
  return code === "PGRST205" || code === "42P01" || res.status === 404;
}

const MISSING_TABLE_MSG =
  "email_rules table missing — run migrations/email-rules.sql in the Supabase SQL editor";

function validateConditions(raw: unknown): RuleCondition[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "conditions must be a non-empty array";
  if (raw.length > 20) return "at most 20 conditions";
  const out: RuleCondition[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") return "invalid condition";
    const cond = c as Record<string, unknown>;
    if (!FIELDS.includes(cond.field as string)) return "condition field must be from/to/subject";
    if (!OPS.includes(cond.op as string)) return "condition op must be contains/equals/ends_with";
    const value = typeof cond.value === "string" ? cond.value.trim() : "";
    if (!value || value.length > 500) return "condition value required (max 500 chars)";
    out.push({ field: cond.field as RuleCondition["field"], op: cond.op as RuleCondition["op"], value });
  }
  return out;
}

function validateActions(raw: unknown): RuleAction[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "actions must be a non-empty array";
  if (raw.length > 10) return "at most 10 actions";
  const out: RuleAction[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") return "invalid action";
    const action = a as Record<string, unknown>;
    if (!ACTION_TYPES.includes(action.type as string)) return "unknown action type";
    if (action.type === "move_folder") {
      if (!MOVE_FOLDERS.includes(action.folder as string)) return "move_folder requires folder inbox or archive";
      out.push({ type: "move_folder", folder: action.folder as "inbox" | "archive" });
    } else {
      out.push({ type: action.type as RuleAction["type"] });
    }
  }
  return out;
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(request, env);
  if (authError) return authError;

  if (request.method === "GET") {
    const res = await supabaseQuery(env, "/email_rules?order=priority.asc,created_at.asc");
    if (!res.ok) {
      if (isMissingTable(res)) return jsonResponse([], 200, origin);
      return errorResponse("Failed to load rules", 500, origin);
    }
    return jsonResponse(Array.isArray(res.data) ? res.data : [], 200, origin);
  }

  if (request.method === "POST") {
    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) return errorResponse("name required (max 120 chars)", 400, origin);
    const matchType = body.match_type === "any" ? "any" : "all";
    const conditions = validateConditions(body.conditions);
    if (typeof conditions === "string") return errorResponse(conditions, 400, origin);
    const actions = validateActions(body.actions);
    if (typeof actions === "string") return errorResponse(actions, 400, origin);
    let domainId: string | null = null;
    if (body.domain_id != null) {
      if (typeof body.domain_id !== "string" || !UUID_RE.test(body.domain_id)) {
        return errorResponse("domain_id must be a UUID or null", 400, origin);
      }
      domainId = body.domain_id;
    }

    // Append at the end of the priority order
    let priority = 0;
    const maxRes = await supabaseQuery(env, "/email_rules?select=priority&order=priority.desc&limit=1");
    if (maxRes.ok && Array.isArray(maxRes.data) && maxRes.data.length > 0) {
      priority = ((maxRes.data[0] as { priority: number }).priority ?? 0) + 1;
    } else if (!maxRes.ok && isMissingTable(maxRes)) {
      return jsonResponse({ error: MISSING_TABLE_MSG, needs_migration: true }, 503, origin);
    }

    const ins = await supabaseQuery(env, "/email_rules", {
      method: "POST",
      body: { name, match_type: matchType, conditions, actions, domain_id: domainId, priority },
    });
    if (!ins.ok) {
      if (isMissingTable(ins)) return jsonResponse({ error: MISSING_TABLE_MSG, needs_migration: true }, 503, origin);
      return errorResponse("Failed to create rule", 500, origin);
    }
    return jsonResponse(Array.isArray(ins.data) ? ins.data[0] : ins.data, 201, origin);
  }

  if (request.method === "PATCH") {
    const body = (await request.json()) as Record<string, unknown>;

    // Reorder mode: full priority rewrite from an ordered id list
    if (Array.isArray(body.reorder)) {
      const ids = body.reorder as unknown[];
      if (ids.length > 200 || ids.some((i) => typeof i !== "string" || !UUID_RE.test(i))) {
        return errorResponse("reorder must be an array of rule UUIDs", 400, origin);
      }
      for (let i = 0; i < ids.length; i++) {
        const res = await supabaseQuery(env, `/email_rules?id=eq.${ids[i]}`, {
          method: "PATCH",
          body: { priority: i, updated_at: new Date().toISOString() },
        });
        if (!res.ok) return errorResponse("Failed to reorder rules", 500, origin);
      }
      return jsonResponse({ reordered: ids.length }, 200, origin);
    }

    const id = body.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) return errorResponse("id is required", 400, origin);

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 120) return errorResponse("name required (max 120 chars)", 400, origin);
      updates.name = name;
    }
    if (body.is_active !== undefined) updates.is_active = Boolean(body.is_active);
    if (body.match_type !== undefined) updates.match_type = body.match_type === "any" ? "any" : "all";
    if (body.conditions !== undefined) {
      const conditions = validateConditions(body.conditions);
      if (typeof conditions === "string") return errorResponse(conditions, 400, origin);
      updates.conditions = conditions;
    }
    if (body.actions !== undefined) {
      const actions = validateActions(body.actions);
      if (typeof actions === "string") return errorResponse(actions, 400, origin);
      updates.actions = actions;
    }
    if (body.domain_id !== undefined) {
      if (body.domain_id === null) updates.domain_id = null;
      else if (typeof body.domain_id === "string" && UUID_RE.test(body.domain_id)) updates.domain_id = body.domain_id;
      else return errorResponse("domain_id must be a UUID or null", 400, origin);
    }

    const res = await supabaseQuery(env, `/email_rules?id=eq.${id}`, { method: "PATCH", body: updates });
    if (!res.ok) return errorResponse("Failed to update rule", 500, origin);
    if (!Array.isArray(res.data) || res.data.length === 0) return errorResponse("Rule not found", 404, origin);
    return jsonResponse(res.data[0], 200, origin);
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !UUID_RE.test(id)) return errorResponse("id is required", 400, origin);
    const { ok } = await supabaseQuery(env, `/email_rules?id=eq.${id}`, { method: "DELETE" });
    if (!ok) return errorResponse("Failed to delete rule", 500, origin);
    return jsonResponse({ deleted: true }, 200, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
