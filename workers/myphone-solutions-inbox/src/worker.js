/**
 * Cloudflare Email Routing handler for myphone.solutions.
 * KV keeps a copy. Delivery is POST /api/email/ingest only (no forward, no send).
 * Outcome is written back onto that KV copy. Response bodies are never stored.
 */
const KV_TTL_SECONDS = 1209600;
const RAW_LIMIT = 200000;
const REPLAY_LOCK = "__replay_lock";

export function headerValue(headers, name) {
  if (!headers) return "";
  const target = String(name).toLowerCase();
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(target) || "";
  }
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === target) return v || "";
  }
  return "";
}

export function stableIngestMessageId(headers, raw) {
  const fromHeader = String(headerValue(headers, "message-id") || "")
    .trim()
    .replace(/^<|>$/g, "");
  if (fromHeader && !/[\u0000-\u001f\u007f]/.test(fromHeader)) {
    return fromHeader.slice(0, 512);
  }
  return null;
}

export async function hashRawIngestId(raw) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(raw || "").slice(0, 50000))
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
  return `raw:${hex}`;
}

function headersObject(messageHeaders) {
  const headers = {};
  if (!messageHeaders) return headers;
  if (typeof messageHeaders.entries === "function") {
    for (const [k, v] of messageHeaders.entries()) headers[k] = v;
    return headers;
  }
  for (const [k, v] of messageHeaders) headers[k] = v;
  return headers;
}

function kvExpiration(existing) {
  if (existing && Number.isFinite(existing)) return existing;
  return Math.floor(Date.now() / 1000) + KV_TTL_SECONDS;
}

async function writeKv(env, key, record, expiration) {
  if (!env.INBOX) return;
  await env.INBOX.put(key, JSON.stringify(record), { expiration: kvExpiration(expiration) });
}

function parseRecord(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function postIngest(env, record) {
  const secret = env.EMAIL_INGEST_SECRET;
  const ingestUrl = env.INGEST_URL;
  if (!ingestUrl || !secret) {
    return { ok: false, error: "missing_secret", httpStatus: null };
  }
  let res;
  try {
    res = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Email-Ingest-Secret": secret,
      },
      body: JSON.stringify({
        domain: env.DOMAIN || "myphone.solutions",
        from: record.from,
        to: record.to,
        subject: record.subject,
        headers: record.headers || {},
        raw: record.raw,
        received_at: record.received_at,
        ingest_message_id: record.ingest_message_id,
      }),
    });
  } catch {
    return { ok: false, error: "network", httpStatus: null };
  }
  if (!res.ok) {
    console.error("myphone-solutions-inbox: ingest failed", res.status);
    try {
      await res.body?.cancel?.();
    } catch {
      /* ignore */
    }
    return { ok: false, error: "http", httpStatus: res.status };
  }
  let duplicate = false;
  try {
    const parsed = await res.json();
    duplicate = parsed?.duplicate === true;
  } catch {
    duplicate = false;
  }
  return { ok: true, duplicate, error: null, httpStatus: res.status };
}

function applyOutcome(record, outcome) {
  return {
    from: record.from,
    to: record.to,
    subject: record.subject,
    raw: record.raw,
    headers: record.headers || {},
    received_at: record.received_at,
    ingest_message_id: record.ingest_message_id,
    ingest_status: outcome.ok ? "ok" : "failed",
    ingest_http_status: outcome.httpStatus ?? null,
    ingest_error: outcome.ok ? null : outcome.error,
    ingest_at: new Date().toISOString(),
  };
}

export async function handleEmail(message, env) {
  const rawFull = await new Response(message.raw).text();
  const raw = rawFull.slice(0, RAW_LIMIT);
  const headers = headersObject(message.headers);
  const receivedAt = new Date().toISOString();
  const key = `${receivedAt}_${crypto.randomUUID().slice(0, 8)}`;
  const expiration = kvExpiration();
  let ingestMessageId = stableIngestMessageId(headers, raw);
  if (!ingestMessageId) ingestMessageId = await hashRawIngestId(raw);

  const record = {
    from: message.from,
    to: message.to,
    subject: headerValue(headers, "subject") || "",
    raw,
    headers,
    received_at: receivedAt,
    ingest_message_id: ingestMessageId,
    ingest_status: "pending",
    ingest_http_status: null,
    ingest_error: null,
    ingest_at: receivedAt,
  };

  try {
    await writeKv(env, key, record, expiration);
  } catch (err) {
    console.error("myphone-solutions-inbox: kv put failed");
  }

  const outcome = await postIngest(env, record);
  if (!outcome.ok && outcome.error === "missing_secret") {
    console.error("myphone-solutions-inbox: missing INGEST_URL or EMAIL_INGEST_SECRET");
  }
  const saved = applyOutcome(record, outcome);
  try {
    await writeKv(env, key, saved, expiration);
  } catch {
    console.error("myphone-solutions-inbox: kv outcome put failed");
  }
  return { key, record: saved };
}

export async function replayInbox(env) {
  const summary = { recovered: 0, duplicate: 0, failed: 0, skipped: 0, attempted: 0 };
  if (!env.INBOX) return summary;
  let cursor;
  do {
    const page = await env.INBOX.list({ cursor, limit: 100 });
    for (const entry of page.keys || []) {
      if (!entry || entry.name === REPLAY_LOCK) continue;
      const text = await env.INBOX.get(entry.name);
      const record = parseRecord(text);
      if (!record || typeof record.raw !== "string") continue;
      if (!headerValue(record.headers, "message-id")) {
        const match = String(record.raw).match(/^message-id:\s*(.+)$/im);
        if (match) {
          record.headers = { ...(record.headers || {}), "message-id": match[1].trim() };
        }
      }
      if (record.ingest_status === "ok") {
        summary.skipped += 1;
        continue;
      }
      if (!record.received_at) {
        const stamp = String(entry.name).split("_")[0];
        if (!Number.isNaN(Date.parse(stamp))) record.received_at = stamp;
      }
      if (!record.ingest_message_id) {
        record.ingest_message_id =
          stableIngestMessageId(record.headers, record.raw) || (await hashRawIngestId(record.raw));
      }
      summary.attempted += 1;
      const outcome = await postIngest(env, record);
      const saved = applyOutcome(record, outcome);
      try {
        await writeKv(env, entry.name, saved, entry.expiration);
      } catch {
        console.error("myphone-solutions-inbox: kv replay put failed");
      }
      if (!outcome.ok) {
        summary.failed += 1;
      } else if (outcome.duplicate) {
        summary.duplicate += 1;
      } else {
        summary.recovered += 1;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return summary;
}

export async function handleReplayRequest(request, env) {
  const nonce = env.REPLAY_NONCE;
  if (!nonce) return new Response("not found", { status: 404 });
  const got = request.headers.get("X-Replay-Nonce");
  if (!got || got !== nonce) return new Response("unauthorized", { status: 401 });
  const existing = env.INBOX ? await env.INBOX.get(REPLAY_LOCK) : null;
  if (existing) return new Response("consumed", { status: 409 });
  const summary = await replayInbox(env);
  if (env.INBOX && summary.failed === 0) {
    await env.INBOX.put(REPLAY_LOCK, JSON.stringify({ at: new Date().toISOString() }), {
      expirationTtl: KV_TTL_SECONDS,
    });
  }
  return Response.json(summary);
}

export default {
  async email(message, env) {
    try {
      await handleEmail(message, env);
    } catch (err) {
      console.error("myphone-solutions-inbox: email handler failed");
    }
  },

  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || path !== "/replay") {
      return new Response("not found", { status: 404 });
    }
    try {
      return await handleReplayRequest(request, env);
    } catch {
      return new Response("failed", { status: 500 });
    }
  },
};
