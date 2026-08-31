import {
  Env,
  jsonResponse,
  errorResponse,
  optionsResponse,
  supabaseQuery,
  checkAuth,
  withSignedAttachmentUrls,
} from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = new Set(["received", "working", "waiting", "done", "stuck"]);
const JOB_SELECT =
  "id,session_id,agent_local,mailbox,base_subject,stage,email_thread_id,last_message_id,used_k,used_tokens,received_at,started_at,last_reply_at,done_at,stuck_at,updated_at,notes,remind_requested_at";

type JobRow = Record<string, unknown>;

function isMissingTable(res: { status: number; data: unknown }): boolean {
  const code = (res.data as { code?: string } | null)?.code;
  return code === "PGRST205" || code === "42P01" || res.status === 404;
}

function q(v: string): string {
  return encodeURIComponent(v);
}

function asRecord(data: unknown): JobRow | null {
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") return data[0] as JobRow;
  if (data && typeof data === "object" && !Array.isArray(data) && "id" in (data as object)) return data as JobRow;
  return null;
}

function truncatePreview(text: unknown): string {
  if (typeof text !== "string" || !text) return "";
  return text.substring(0, 240).replace(/\n/g, " ");
}

async function appendEvent(env: Env, jobId: string, kind: string, detail?: string | null) {
  return supabaseQuery(env, "/agent_job_events", {
    method: "POST",
    body: { job_id: jobId, kind, detail: detail ?? null },
  });
}

async function loadJob(env: Env, id: string) {
  return supabaseQuery(env, `/agent_jobs?id=eq.${q(id)}&select=${JOB_SELECT}&limit=1`);
}

async function loadEvents(env: Env, jobId: string) {
  return supabaseQuery(
    env,
    `/agent_job_events?job_id=eq.${q(jobId)}&select=id,job_id,at,kind,detail&order=at.asc`
  );
}

const BODY_TEXT_CAP = 50_000;
const BODY_HTML_CAP = 150_000;

function clip(text: unknown, cap: number): string {
  if (typeof text !== "string" || !text) return "";
  return text.length > cap ? text.slice(0, cap) : text;
}

async function loadAttachmentsByMessage(env: Env, ids: string[]) {
  const map = new Map<string, Array<Record<string, unknown>>>();
  const clean = ids.filter((id) => UUID_RE.test(id));
  if (!clean.length) return map;
  const res = await supabaseQuery(
    env,
    `/email_attachments?message_id=in.(${clean.join(",")})&select=id,message_id,filename,content_type,size_bytes,storage_path&order=filename.asc`
  );
  if (!res.ok || !Array.isArray(res.data)) return map;
  const signed = await withSignedAttachmentUrls(env, res.data as Array<Record<string, unknown>>);
  for (const row of signed) {
    const mid = String(row.message_id || "");
    if (!mid) continue;
    const list = map.get(mid) || [];
    list.push(row);
    map.set(mid, list);
  }
  return map;
}

async function loadMessages(env: Env, job: JobRow) {
  const select =
    "id,from_address,from_name,to_addresses,cc_addresses,subject,received_at,direction,body_text,body_html,thread_id";
  const mapRows = async (rows: unknown) => {
    if (!Array.isArray(rows)) return [];
    const ids = rows.map((row) => String((row as Record<string, unknown>).id || "")).filter(Boolean);
    const atts = await loadAttachmentsByMessage(env, ids);
    return rows.map((row) => {
      const m = row as Record<string, unknown>;
      const id = String(m.id || "");
      return {
        id,
        from: m.from_address || "",
        from_name: m.from_name || "",
        to: m.to_addresses || [],
        subject: m.subject || "",
        received_at: m.received_at,
        direction: m.direction,
        preview: truncatePreview(m.body_text),
        body: clip(m.body_text, BODY_TEXT_CAP),
        body_html: clip(m.body_html, BODY_HTML_CAP),
        attachments: atts.get(id) || [],
      };
    });
  };

  const threadId = typeof job.email_thread_id === "string" ? job.email_thread_id.trim() : "";
  if (threadId) {
    const byThread = await supabaseQuery(
      env,
      `/email_messages?thread_id=eq.${q(threadId)}&select=${select}&order=received_at.asc&limit=50`
    );
    if (byThread.ok && Array.isArray(byThread.data) && byThread.data.length) return mapRows(byThread.data);
  }

  const lastId = typeof job.last_message_id === "string" ? job.last_message_id : "";
  if (lastId && UUID_RE.test(lastId)) {
    const one = await supabaseQuery(env, `/email_messages?id=eq.${q(lastId)}&select=${select}&limit=1`);
    const row = asRecord(one.data);
    const tid = row && typeof row.thread_id === "string" ? row.thread_id : "";
    if (tid) {
      const byThread = await supabaseQuery(
        env,
        `/email_messages?thread_id=eq.${q(tid)}&select=${select}&order=received_at.asc&limit=50`
      );
      if (byThread.ok && Array.isArray(byThread.data) && byThread.data.length) return mapRows(byThread.data);
    }
    if (one.ok && row) return mapRows([row]);
  }
  return [];
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
      const res = await loadJob(env, id);
      if (!res.ok) {
        if (isMissingTable(res)) {
          return jsonResponse({ job: null, events: [], messages: [], needs_migration: true }, 200, origin);
        }
        return errorResponse("Failed to load job", 500, origin);
      }
      const job = asRecord(res.data);
      if (!job) return errorResponse("not found", 404, origin);
      const ev = await loadEvents(env, String(job.id));
      const events = ev.ok && Array.isArray(ev.data) ? ev.data : [];
      const messages = await loadMessages(env, job);
      return jsonResponse({ job, events, messages }, 200, origin);
    }

    const agent = (url.searchParams.get("agent") || "").trim().toLowerCase();
    const stage = (url.searchParams.get("stage") || "").trim().toLowerCase();
    if (stage && !STAGES.has(stage)) {
      return errorResponse("stage must be received|working|waiting|done|stuck", 400, origin);
    }
    let path = `/agent_jobs?select=${JOB_SELECT}&order=updated_at.desc&limit=500`;
    if (agent) path += `&agent_local=eq.${q(agent)}`;
    if (stage) path += `&stage=eq.${q(stage)}`;
    const res = await supabaseQuery(env, path);
    if (!res.ok) {
      if (isMissingTable(res)) return jsonResponse({ jobs: [], needs_migration: true }, 200, origin);
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
    const upd = await supabaseQuery(env, `/agent_jobs?id=eq.${q(id)}`, {
      method: "PATCH",
      body: { notes, updated_at: new Date().toISOString() },
    });
    if (!upd.ok) {
      if (isMissingTable(upd)) return errorResponse("agent_jobs table missing", 503, origin);
      return errorResponse("Couldn't update notes", 500, origin);
    }
    const job = asRecord(upd.data);
    if (!job) return errorResponse("not found", 404, origin);
    await appendEvent(env, id, "note", notes.slice(0, 2000));
    const ev = await loadEvents(env, id);
    return jsonResponse({ job, events: ev.ok && Array.isArray(ev.data) ? ev.data : [] }, 200, origin);
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
    const stamp = new Date().toISOString();
    const upd = await supabaseQuery(env, `/agent_jobs?id=eq.${q(jobId)}`, {
      method: "PATCH",
      body: { remind_requested_at: stamp, updated_at: stamp },
    });
    if (!upd.ok) {
      if (isMissingTable(upd)) return errorResponse("agent_jobs table missing", 503, origin);
      return errorResponse("Couldn't set remind", 500, origin);
    }
    const job = asRecord(upd.data);
    if (!job) return errorResponse("not found", 404, origin);
    await appendEvent(env, jobId, "remind");
    const ev = await loadEvents(env, jobId);
    return jsonResponse({ job, events: ev.ok && Array.isArray(ev.data) ? ev.data : [] }, 200, origin);
  }

  return errorResponse("method", 405, origin);
};
