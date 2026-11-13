import assert from "node:assert/strict";
import test from "node:test";
import { applyTransitions, emptyCounts, type CountMsg } from "./unread-buckets";
import { MutationTracker } from "./mutation-tracker";
import { LatestRequest, reanchorIndex, stepIndex } from "./list-nav";
import { pushInitAction, shouldShowPushBanner } from "./push-policy";
import { tallyUnreadCounts, type UnreadRow } from "../../functions/api/email/unread-counts";

// ---------------- Unread counts: client optimistic == server tally ----------------

type Row = UnreadRow & { id: string; is_read: boolean };

function serverCounts(rows: Row[], domainIds: string[]) {
  const unread = rows.filter((r) => !r.is_read && !r.is_trash);
  const trash = rows.filter((r) => !r.is_read && r.is_trash);
  return tallyUnreadCounts(domainIds, unread, trash, []);
}

/** Drop zero entries so "missing" and "0" compare equal. */
function norm(c: { domains: Record<string, number>; folders: Record<string, Record<string, number>>; totals: Record<string, number> }) {
  const strip = (o: Record<string, number>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== 0).sort());
  return {
    domains: strip(c.domains),
    folders: Object.fromEntries(
      Object.entries(c.folders)
        .map(([k, v]) => [k, strip(v)] as const)
        .filter(([, v]) => Object.keys(v).length > 0)
        .sort()
    ),
    totals: strip(c.totals),
  };
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const FOLDERS = ["inbox", "sent", "spam", "agent", "drafts", "archive", null];

function randomRow(r: () => number, i: number): Row {
  return {
    id: `m${i}`,
    domain_id: r() < 0.05 ? null : r() < 0.5 ? "d1" : "d2",
    folder: FOLDERS[Math.floor(r() * FOLDERS.length)],
    is_read: r() < 0.4,
    is_starred: r() < 0.3,
    is_archived: r() < 0.15,
    is_catch_all: r() < 0.3,
    is_spam: r() < 0.1,
    is_trash: r() < 0.1,
  };
}

const counting = (m: Row): CountMsg | null => (m.is_read ? null : m);

test("optimistic count transitions always match the server tally (fuzz)", () => {
  const r = rng(42);
  const domainIds = ["d1", "d2"];
  let rows = Array.from({ length: 80 }, (_, i) => randomRow(r, i));
  let client = serverCounts(rows, domainIds);
  for (let step = 0; step < 2000; step++) {
    const i = Math.floor(r() * rows.length);
    const before = rows[i];
    const after: Row = { ...before };
    const op = Math.floor(r() * 6);
    if (op === 0) after.is_read = !after.is_read;
    else if (op === 1) after.is_starred = !after.is_starred;
    else if (op === 2) after.is_trash = true;
    else if (op === 3) after.is_archived = true;
    else if (op === 4) { after.is_spam = !after.is_spam; after.folder = after.is_spam ? "spam" : "inbox"; }
    else after.is_read = true;
    rows = rows.map((m, j) => (j === i ? after : m));
    client = applyTransitions(client, [[counting(before), counting(after)]]);
    assert.deepEqual(norm(client), norm(serverCounts(rows, domainIds)), `diverged at step ${step} op ${op}`);
  }
});

test("marking an inbox message read decrements domain, inbox and starred once", () => {
  const msg: CountMsg = { domain_id: "d1", folder: "inbox", is_starred: true };
  const start = { domains: { d1: 3 }, folders: { d1: { inbox: 3, starred: 1 } }, totals: { inbox: 3, starred: 1 } };
  const next = applyTransitions(start, [[msg, null]]);
  assert.deepEqual(next, { domains: { d1: 2 }, folders: { d1: { inbox: 2, starred: 0 } }, totals: { inbox: 2, starred: 0 } });
  assert.equal(start.domains.d1, 3, "input not mutated");
});

test("agent-folder mail never touches the domain badge (server parity)", () => {
  const next = applyTransitions(emptyCounts(), [[null, { domain_id: "d1", folder: "agent" }]]);
  assert.equal(next.domains.d1 ?? 0, 0);
});

test("counts never go negative", () => {
  const next = applyTransitions(emptyCounts(), [[{ domain_id: "d1", folder: "inbox" }, null]]);
  assert.equal(next.domains.d1, 0);
  assert.equal(next.totals.inbox, 0);
});

// ---------------- Reconcile can't clobber optimistic state ----------------

test("a counts read that overlaps a write is discarded", () => {
  const t = new MutationTracker();
  const snap = t.snapshot();
  const done = t.begin(["a"]);
  assert.equal(t.isCleanSince(snap), false, "write started during the read");
  done();
  assert.equal(t.isCleanSince(snap), false, "still stale after it committed");
  assert.equal(t.isCleanSince(t.snapshot()), true, "a fresh read is clean");
});

test("a counts read started while a write is in flight is discarded", () => {
  const t = new MutationTracker();
  const done = t.begin(["a"]);
  const snap = t.snapshot();
  done();
  assert.equal(t.isCleanSince(snap), false);
});

test("reconcile fires only once every write has settled", () => {
  const t = new MutationTracker();
  let idle = 0;
  t.onIdle(() => idle++);
  const d1 = t.begin(["a"]);
  const d2 = t.begin(["b"]);
  d1();
  assert.equal(idle, 0);
  d2();
  d2(); // idempotent
  assert.equal(idle, 1);
  assert.equal(t.busy, false);
});

test("list poll keeps local read state for rows written during the poll", () => {
  const t = new MutationTracker();
  const snap = t.snapshot();
  const done = t.begin(["a"]);
  assert.equal(t.rowIsCleanSince("a", snap), false, "in flight");
  done();
  assert.equal(t.rowIsCleanSince("a", snap), false, "committed after poll started");
  assert.equal(t.rowIsCleanSince("b", snap), true, "untouched rows still refresh");
  assert.equal(t.rowIsCleanSince("a", t.snapshot()), true, "next poll is authoritative");
});

// ---------------- Arrow-key navigation ----------------

test("stepIndex clamps and starts at the first row", () => {
  assert.equal(stepIndex(-1, 1, 5), 0);
  assert.equal(stepIndex(-1, -1, 5), 0);
  assert.equal(stepIndex(4, 1, 5), 4);
  assert.equal(stepIndex(0, -1, 5), 0);
  assert.equal(stepIndex(2, 1, 0), -1);
});

test("rapid key repeat walks every row exactly once", () => {
  let idx = -1;
  const seen: number[] = [];
  for (let i = 0; i < 10; i++) {
    idx = stepIndex(idx, 1, 10);
    seen.push(idx);
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("focus follows the message (by id) when new mail is prepended", () => {
  const list = [{ id: "c" }, { id: "d" }, { id: "e" }];
  const anchor = { id: "d", threadKey: null };
  const grown = [{ id: "a" }, { id: "b" }, ...list];
  assert.equal(reanchorIndex(grown, 1, anchor), 3);
});

test("mark-read (no reorder) never moves the cursor", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(reanchorIndex(list, 1, { id: "b", threadKey: null }), 1);
});

test("focus falls back to the thread, then the same slot", () => {
  const list = [{ id: "x", thread_key: "t1" }, { id: "y", thread_key: "t2" }];
  assert.equal(reanchorIndex(list, 0, { id: "gone", threadKey: "t2" }), 1);
  assert.equal(reanchorIndex(list, 5, { id: "gone", threadKey: null }), 1);
  assert.equal(reanchorIndex([], 2, { id: "gone", threadKey: null }), -1);
});

test("a slow detail response for a row you already left can't re-select it", () => {
  const req = new LatestRequest();
  req.begin("row-1");
  req.begin("row-2");
  req.begin("row-3");
  assert.equal(req.isLatest("row-1"), false);
  assert.equal(req.isLatest("row-2"), false);
  assert.equal(req.isLatest("row-3"), true);
});

// ---------------- Notifications ----------------

const base = { supported: true, ready: true, permission: "default" as const, subscribed: false, dismissed: false };

test("banner shows only when the browser would actually prompt", () => {
  assert.equal(shouldShowPushBanner(base), true);
  assert.equal(shouldShowPushBanner({ ...base, permission: "granted" }), false, "already granted");
  assert.equal(shouldShowPushBanner({ ...base, permission: "denied" }), false, "blocked");
  assert.equal(shouldShowPushBanner({ ...base, subscribed: true }), false);
  assert.equal(shouldShowPushBanner({ ...base, dismissed: true }), false);
  assert.equal(shouldShowPushBanner({ ...base, ready: false }), false, "no flash before init");
  assert.equal(shouldShowPushBanner({ ...base, supported: false }), false);
});

test("granted permission re-subscribes silently instead of re-prompting", () => {
  const g = { supported: true, permission: "granted" as const, optedOut: false };
  assert.equal(pushInitAction({ ...g, hasSubscription: false, keyMatches: true }), "resubscribe");
  assert.equal(pushInitAction({ ...g, hasSubscription: true, keyMatches: false }), "resubscribe");
  assert.equal(pushInitAction({ ...g, hasSubscription: true, keyMatches: true }), "sync");
  assert.equal(pushInitAction({ ...g, hasSubscription: false, keyMatches: true, optedOut: true }), "none");
  assert.equal(pushInitAction({ ...g, permission: "default", hasSubscription: false, keyMatches: true }), "none");
  assert.equal(pushInitAction({ ...g, permission: "denied", hasSubscription: false, keyMatches: true }), "none");
});
