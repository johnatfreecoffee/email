import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = new Set(["received", "working", "waiting", "done", "stuck"]);

function isMissingTable(res: { status: number; data: unknown }): boolean {
  const code = (res.data as { code?: string } | null)?.code;
  return code === "PGRST205" || code === "42P01" || res.status === 404;
}

function encodeEq(value: string): string {
  return encodeURIComponent(value);
}

async function loadJob(env: Env, id: string) {
  const res = await supabaseQuery(env, `/agent_jobs?id=eq.${id}&select=*`);
  if (!res.ok) return { ok: false as const, missing: isMissingTable(res), status: res.status, data: res.data };
  const row = Array.isArray(res.data) ? (res.data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return { ok: true as const, job: null as Record<string, unknown> | null, events: [] as Record<string, unknown>[] };
  const ev = await supabaseQuery(env, `/agent_job_events?job_id=eq.${id}&select=*&order=at.asc`);
  const events = ev.ok && Array.isArray(ev.data) ? (ev.data as Record<string, unknown>[]) : [];
  return { ok: true as const, job: row, events };
}

async function insertEvent(env: Env, jobId: string, kind: string, detail?: string) {
  const body: Record<string, unknown> = { job_id: jobId, kind };
  if (detail) body.detail = detail;
  return supabaseQuery(env, "/agent_job_events", { method: "POST", body });
}

function nowIso(): string {
  return new Date().toISOString();
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return optionsResponse(origin);
  const authError = await checkAuth(request, env);
  if (authError) return authError;

  const id = (url.searchParams.get("id") || "").trim();

  if (request.method === "GET") {
    if (id) {
      if (!UUID_RE.test(id)) return errorResponse("id required", 400, origin);
      const got = await loadJob(env, id);
      if (!got.ok) {
        if (got.missing) return jsonResponse({ job: null, events: [] }, 200, origin);
        return errorResponse("Failed to load job", 500, origin);
      }
      if (!got.job) return errorResponse("not found", 404, origin);
      return jsonResponse({ job: got.job, events: got.events }, 200, origin);
    }

    const parts = ["select=*", "order=updated_at.desc"];
    const agent = (url.searchParams.get("agent") || "").trim().toLowerCase();
    const stage = (url.searchParams.get("stage") || "").trim().toLowerCase();
    if (agent) parts.push(`agent_local=eq.${encodeEq(agent)}`);
    if (stage) {
      if (!STAGES.has(stage)) return errorResponse("stage must be received|working|waiting|done|stuck", 400, origin);
      parts.push(`stage=eq.${encodeEq(stage)}`);
    }
    const res = await supabaseQuery(env, `/agent_jobs?${parts.join("&")}`);
    if (!res.ok) {
      if (isMissingTable(res)) return jsonResponse({ jobs: [] }, 200, origin);
      return errorResponse("Failed to load jobs", 500, origin);
    }
    return jsonResponse({ jobs: Array.isArray(res.data) ? res.data : [] }, 200, origin);
  }

  if (request.method === "PATCH") {
    if (!UUID_RE.test(id)) return errorResponse("id required", 400, origin);
    let body: { notes?: unknown } = {};
    try {
      const parsed = await request.json();
      if (parsed && typeof parsed === "object") body = parsed as { notes?: unknown };
    } catch {
      return errorResponse("invalid json", 400, origin);
    }
    if (typeof body.notes !== "string") return errorResponse("notes required", 400, origin);
    const notes = body.notes;
    const upd = await supabaseQuery(env, `/agent_jobs?id=eq.${id}`, {
      method: "PATCH",
      body: { notes, updated_at: nowIso() },
    });
    if (!upd.ok) {
      if (isMissingTable(upd)) return errorResponse("agent_jobs table missing", 503, origin);
      return errorResponse("Couldn't update notes", 500, origin);
    }
    const row = Array.isArray(upd.data) ? (upd.data[0] as Record<string, unknown> | undefined) : undefined;
    if (!row) return errorResponse("not found", 404, origin);
    await insertEvent(env, id, "note", notes.slice(0, 2000));
    const got = await loadJob(env, id);
    if (!got.ok || !got.job) return jsonResponse({ job: row, events: [] }, 200, origin);
    return jsonResponse({ job: got.job, events: got.events }, 200, origin);
  }

  if (request.method === "POST") {
    let body: { id?: unknown } = {};
    try {
      const parsed = await request.json().catch(() => ({}));
      if (parsed && typeof parsed === "object") body = parsed as { id?: unknown };
    } catch {
      body = {};
    }
    const jobId = id || String(body.id || "").trim();
    if (!UUID_RE.test(jobId)) return errorResponse("id required", 400, origin);
    const stamp = nowIso();
    const upd = await supabaseQuery(env, `/agent_jobs?id=eq.${jobId}`, {
      method: "PATCH",
      body: { remind_requested_at: stamp, updated_at: stamp },
    });
    if (!upd.ok) {
      if (isMissingTable(upd)) return errorResponse("agent_jobs table missing", 503, origin);
      return errorResponse("Couldn't set remind", 500, origin);
    }
    const row = Array.isArray(upd.data) ? (upd.data[0] as Record<string, unknown> | undefined) : undefined;
    if (!row) return errorResponse("not found", 404, origin);
    await insertEvent(env, jobId, "remind");
    const got = await loadJob(env, jobId);
    if (!got.ok || !got.job) return jsonResponse({ job: row, events: [] }, 200, origin);
    return jsonResponse({ job: got.job, events: got.events }, 200, origin);
  }

  return errorResponse("method", 405, origin);
};
