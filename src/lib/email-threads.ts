import type { EmailMessage } from "@/components/email/email-layout";

/** Strip Re:/Fwd: and agent (ID: n) tags for conversation matching. */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject || "").trim();
  s = s.replace(/\s*\(ID:\s*\d+(?:\s*-\s*[^)]*)?\)\s*/gi, " ");
  s = s.replace(/^\[Catch-All\]\s*/i, "");
  for (let i = 0; i < 8; i++) {
    const n = s.replace(/^(re|fw|fwd)\s*:\s*/i, "").trim();
    if (n === s) break;
    s = n;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function threadKey(msg: Pick<EmailMessage, "id" | "thread_id" | "subject" | "domain_id">): string {
  if (msg.thread_id) return `t:${msg.thread_id}`;
  const sub = normalizeSubject(msg.subject);
  if (sub) return `s:${msg.domain_id}:${sub}`;
  return `m:${msg.id}`;
}

export interface ThreadCollapse {
  /** One row per conversation (latest message). */
  display: EmailMessage[];
  /** threadKey → member count */
  counts: Record<string, number>;
  /** threadKey → all members newest-first */
  members: Record<string, EmailMessage[]>;
  /** message id → threadKey */
  keyById: Record<string, string>;
}

/**
 * Collapse a flat list into conversations. Order = newest activity first
 * (same as input order when already sorted by received_at desc).
 */
export function collapseThreads(messages: EmailMessage[]): ThreadCollapse {
  const members: Record<string, EmailMessage[]> = {};
  const keyById: Record<string, string> = {};
  const order: string[] = [];

  for (const msg of messages) {
    const key = threadKey(msg);
    keyById[msg.id] = key;
    if (!members[key]) {
      members[key] = [];
      order.push(key);
    }
    members[key].push(msg);
  }

  const counts: Record<string, number> = {};
  const display: EmailMessage[] = [];

  for (const key of order) {
    const list = members[key];
    // newest first
    list.sort((a, b) => +new Date(b.received_at) - +new Date(a.received_at));
    members[key] = list;
    counts[key] = list.length;

    const latest = list[0];
    // Aggregate flags for list row
    const anyUnread = list.some((m) => !m.is_read);
    const anyStarred = list.some((m) => m.is_starred);
    const merged: EmailMessage = {
      ...latest,
      is_read: !anyUnread,
      is_starred: anyStarred || latest.is_starred,
      // surface count for UI
      thread_count: list.length,
      thread_key: key,
    };
    display.push(merged);
  }

  return { display, counts, members, keyById };
}
