import { Env, supabaseQuery } from "./_shared";

/** Strip Re:/Fwd: and agent session tags so related subjects collapse. */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject || "").trim();
  // Agent Mail tags: (ID: 1 - 12/500K)
  s = s.replace(/\s*\(ID:\s*\d+(?:\s*-\s*[^)]*)?\)\s*/gi, " ");
  // Catch-all prefix noise — keep body after common bracket prefixes for matching
  s = s.replace(/^\[Catch-All\]\s*/i, "");
  // Collapse reply/forward chains
  for (let i = 0; i < 8; i++) {
    const n = s.replace(/^(re|fw|fwd)\s*:\s*/i, "").trim();
    if (n === s) break;
    s = n;
  }
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

function headerGet(headers: Record<string, string> | null | undefined, name: string): string | null {
  if (!headers) return null;
  const t = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === t) return headers[k];
  }
  return null;
}

/** Extract angle-bracket or bare message ids from In-Reply-To / References. */
export function extractMessageIds(...values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    const angle = v.match(/<[^>]+>/g);
    if (angle) {
      for (const a of angle) out.push(a.slice(1, -1).trim());
    }
    // bare tokens (resend ids, etc.)
    for (const part of v.split(/\s+/)) {
      const p = part.replace(/^<|>$/g, "").trim();
      if (p && (p.includes("@") || /^[0-9a-f-]{8,}$/i.test(p))) out.push(p);
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function newThreadId(): string {
  return crypto.randomUUID();
}

/**
 * Resolve a thread_id for a new message.
 * 1) Follow In-Reply-To / References → existing resend_email_id or headers
 * 2) Same domain + normalized subject (recent)
 * 3) Fresh UUID
 */
export async function resolveThreadId(
  env: Env,
  opts: {
    domainId: string | null | undefined;
    subject: string | null | undefined;
    inReplyTo?: string | null;
    headers?: Record<string, string> | null;
  }
): Promise<string> {
  const refIds = extractMessageIds(
    opts.inReplyTo,
    headerGet(opts.headers || null, "in-reply-to"),
    headerGet(opts.headers || null, "references")
  );

  for (const ref of refIds.slice(0, 12)) {
    // Match our stored resend_email_id
    const byResend = await supabaseQuery(
      env,
      `/email_messages?resend_email_id=eq.${encodeURIComponent(ref)}&select=id,thread_id&limit=1`,
      { method: "GET" }
    );
    if (byResend.ok && Array.isArray(byResend.data) && byResend.data[0]) {
      const row = byResend.data[0] as { id: string; thread_id: string | null };
      return row.thread_id || row.id;
    }
  }

  const norm = normalizeSubject(opts.subject);
  if (norm && opts.domainId) {
    // Pull recent domain mail and match subject client-side (PostgREST has no easy normalize)
    const recent = await supabaseQuery(
      env,
      `/email_messages?domain_id=eq.${opts.domainId}&select=id,thread_id,subject&order=received_at.desc&limit=80`,
      { method: "GET" }
    );
    if (recent.ok && Array.isArray(recent.data)) {
      for (const row of recent.data as Array<{ id: string; thread_id: string | null; subject: string }>) {
        if (normalizeSubject(row.subject) === norm) {
          return row.thread_id || row.id;
        }
      }
    }
  }

  return newThreadId();
}
