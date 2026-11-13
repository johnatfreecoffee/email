// Optimistic unread-count engine (pure — unit tested against the server
// tally in functions/api/email/unread-counts.ts).
//
// EXACT mirror of the server bucket rules:
//   trash → its own badge only
//   agent folder → silent (no domain / folder / starred contribution)
//   archive → spam → sent → inbox (catch-all split) → catchall
//   starred is additive on top.

export const AGENT_FOLDER_ID = "agent";

export interface UnreadCounts {
  domains: Record<string, number>;
  folders: Record<string, Record<string, number>>;
  totals: Record<string, number>;
}

/** Flags that decide which unread-count buckets a message contributes to. */
export interface CountMsg {
  domain_id: string | null;
  folder: string | null;
  is_starred?: boolean | null;
  is_archived?: boolean | null;
  is_trash?: boolean | null;
  is_catch_all?: boolean | null;
  is_spam?: boolean | null;
}

export type Bucket = "archive" | "spam" | "sent" | "catchall" | "inbox";

export function primaryBucket(m: CountMsg): Bucket | null {
  if (m.folder === AGENT_FOLDER_ID) return null;
  if (m.is_archived) return "archive";
  if (m.folder === "spam" || m.is_spam) return "spam";
  if (m.folder === "sent") return "sent";
  if (m.folder === "inbox") return m.is_catch_all ? "catchall" : "inbox";
  if (m.is_catch_all) return "catchall";
  return null;
}

/**
 * Each pair is (before, after) for one message *while counting as unread* —
 * null on a side where it doesn't count (e.g. marking read → after = null).
 * Returns a new counts object; never mutates `prev`.
 */
export function applyTransitions(
  prev: UnreadCounts,
  pairs: Array<[CountMsg | null, CountMsg | null]>
): UnreadCounts {
  const next: UnreadCounts = {
    domains: { ...prev.domains },
    folders: Object.fromEntries(Object.entries(prev.folders).map(([k, v]) => [k, { ...v }])),
    totals: { ...prev.totals },
  };
  const bump = (obj: Record<string, number>, key: string, delta: number) => {
    obj[key] = Math.max(0, (obj[key] || 0) + delta);
  };
  const apply = (m: CountMsg, delta: 1 | -1) => {
    if (!m.domain_id) return;
    if (!next.folders[m.domain_id]) next.folders[m.domain_id] = {};
    const f = next.folders[m.domain_id];
    if (m.is_trash) {
      bump(f, "trash", delta);
      bump(next.totals, "trash", delta);
      return;
    }
    // Server skips agent-folder rows entirely (domain badge included).
    if (m.folder === AGENT_FOLDER_ID) return;
    bump(next.domains, m.domain_id, delta);
    const bucket = primaryBucket(m);
    if (bucket) {
      bump(f, bucket, delta);
      bump(next.totals, bucket, delta);
    }
    if (m.is_starred) {
      bump(f, "starred", delta);
      bump(next.totals, "starred", delta);
    }
  };
  for (const [before, after] of pairs) {
    if (before) apply(before, -1);
    if (after) apply(after, 1);
  }
  return next;
}

export function emptyCounts(): UnreadCounts {
  return { domains: {}, folders: {}, totals: {} };
}
