"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { HelpCircle, X, Bell } from "lucide-react";
import { FolderList } from "./folder-list";
import { usePush } from "@/lib/push-notifications";
import { Toaster } from "@/lib/toast";
import { MessageList } from "./message-list";
import { MessageReader } from "./message-reader";
import { ComposeModal } from "./compose-modal";
import { SettingsModal } from "./settings/settings-modal";
import { apiFetch } from "@/lib/auth";
import { useSettings, type SettingsTab } from "@/lib/settings";
import { playNotificationSound } from "@/lib/notification-sound";
import { collapseThreads, threadKey } from "@/lib/email-threads";
import { AGENT_FOLDER, isAgentAddress } from "@/lib/agent-mail";

const API_BASE = "/api/email";

export interface EmailDomain {
  id: string;
  domain: string;
  resend_domain_id: string;
  status: string;
  catch_all_enabled: boolean;
  catch_all_subject_prefix: string;
  catchall_destination_address_id?: string | null;
  addresses: EmailAddress[];
  created_at: string;
}

export interface EmailAddress {
  id: string;
  address: string;
  display_name: string | null;
  is_active: boolean;
  mc_user_id?: string | null;
}

export interface EmailMessage {
  id: string;
  domain_id: string;
  address_id: string | null;
  direction: string;
  resend_email_id?: string;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  preview?: string;
  body_text?: string;
  body_html?: string;
  is_read: boolean;
  is_starred: boolean;
  is_archived: boolean;
  is_trash: boolean;
  is_draft: boolean;
  is_catch_all: boolean;
  is_spam?: boolean;
  spam_score?: number | null;
  folder: string;
  received_at: string;
  thread_id?: string | null;
  in_reply_to?: string | null;
  /** Client-only: conversation size when threading is on */
  thread_count?: number;
  /** Client-only: collapse key */
  thread_key?: string;
  /** Client-only: indented child row under an expanded conversation */
  is_thread_child?: boolean;
  /** Client-only: conversation is expanded in the list */
  thread_expanded?: boolean;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    storage_path: string;
  }>;
}

// Persistence keys for resizable panes
const FOLDER_W_KEY = "mc.email.folderColumnWidth";
const LIST_W_KEY = "mc.email.listColumnWidth";
const FOLDER_W_DEFAULT = 240;
const FOLDER_W_MIN = 180;
const FOLDER_W_MAX = 380;
const LIST_W_DEFAULT = 380;
const LIST_W_MIN = 320;
const READER_MIN = 400;

// Display names for the mobile reader's "‹ back" button (the mailbox the
// message was opened from). Falls back to "Mailboxes".
const FOLDER_LABELS: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  spam: "Junk",
  trash: "Trash",
  archive: "Archive",
  starred: "Starred",
  all: "All Mail",
  agent: "Agents",
};

// Unread counts shape returned by /api/email/unread-counts
interface UnreadCounts {
  domains: Record<string, number>;
  folders: Record<string, Record<string, number>>;
  totals: Record<string, number>;
}

// Envelope shape from /api/email/messages when cursor/with_total is sent
interface ListResponse {
  messages: EmailMessage[];
  total: number | null;
  next_cursor: string | null;
  has_more: boolean;
}

const PAGE_SIZE = 50;

// Flags that decide which unread-count buckets a message contributes to.
type CountMsg = Pick<EmailMessage, "domain_id" | "folder"> & {
  is_starred?: boolean;
  is_archived?: boolean;
  is_trash?: boolean;
  is_catch_all?: boolean;
  is_spam?: boolean;
};

// EXACT mirror of the bucket priority in functions/api/email/unread-counts.ts:
// archive → spam → sent → inbox (catch-all split) → catchall. Starred is
// additive on top, trash is its own world — both handled by the applier.
function primaryBucket(m: CountMsg): "archive" | "spam" | "sent" | "catchall" | "inbox" | null {
  if (m.folder === AGENT_FOLDER) return null;
  if (m.is_archived) return "archive";
  if (m.folder === "spam" || m.is_spam) return "spam";
  if (m.folder === "sent") return "sent";
  if (m.folder === "inbox") return m.is_catch_all ? "catchall" : "inbox";
  if (m.is_catch_all) return "catchall";
  return null;
}

export function EmailLayout() {
  const [domains, setDomains] = useState<EmailDomain[]>([]);
  const [selectedDomain, setSelectedDomain] = useState<EmailDomain | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  // When true, the message list filters to is_catch_all=true. Selected
  // alongside (or instead of) a specific address, depending on what the
  // user clicked in the sidebar.
  const [catchAllOnly, setCatchAllOnly] = useState(false);
  // Roaming preferences (server-synced): catch-alls-in-inbox, mark-read
  // delay, desktop list style, preview lines.
  const { settings, updateSetting } = useSettings();
  const showCatchAllInInbox = settings.viewing.showCatchAllInInbox;
  const markReadDelay = settings.viewing.markReadDelaySeconds;
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<EmailMessage | null>(null);

  const threadingOn = useMemo(() => {
    const globalOn = settings.viewing.threadConversations !== false;
    const id = selectedDomain?.id;
    if (id && settings.viewing.threadDomainOverrides && id in settings.viewing.threadDomainOverrides) {
      return !!settings.viewing.threadDomainOverrides[id];
    }
    return globalOn;
  }, [settings.viewing.threadConversations, settings.viewing.threadDomainOverrides, selectedDomain?.id]);

  const threadCollapse = useMemo(() => {
    if (!threadingOn) return null;
    return collapseThreads(messages);
  }, [threadingOn, messages]);
  const threadCollapseRef = useRef(threadCollapse);
  useEffect(() => { threadCollapseRef.current = threadCollapse; }, [threadCollapse]);
  const navListRef = useRef<EmailMessage[]>([]);
  const handleDisplayListChange = useCallback((list: EmailMessage[]) => {
    navListRef.current = list;
  }, []);

  const selectedThreadKey = selectedMessage
    ? (selectedMessage.thread_key || threadKey(selectedMessage))
    : null;

  const selectedThreadMessages = useMemo(() => {
    if (!selectedMessage || !threadCollapse) return undefined;
    const key = selectedThreadKey || threadKey(selectedMessage);
    const members = threadCollapse.members[key];
    if (!members || members.length <= 1) return undefined;
    return [...members].sort((a, b) => +new Date(a.received_at) - +new Date(b.received_at));
  }, [selectedMessage, threadCollapse, selectedThreadKey]);
  const [activeFolder, setActiveFolder] = useState("inbox");
  const [loading, setLoading] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<{ tab: SettingsTab; domainId: string | null } | null>(null);
  // searchInput = what the box shows (instant); searchQuery = committed value
  // that actually drives fetches, debounced 300ms.
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  // Mobile navigation stack (iOS Mail): mailboxes → list → reader. Each view
  // slides in from the right over the previous one; back buttons pop it off.
  const [mobileView, setMobileView] = useState<"folders" | "list" | "reader">("folders");
  const folderBackLabel = FOLDER_LABELS[activeFolder] || "Mailboxes";
  const [unreadCounts, setUnreadCounts] = useState<UnreadCounts>({ domains: {}, folders: {}, totals: {} });

  // Resizable column widths — start with defaults, hydrate from localStorage post-mount to avoid SSR mismatch
  const [folderColWidth, setFolderColWidth] = useState<number>(FOLDER_W_DEFAULT);
  const [listColWidth, setListColWidth] = useState<number>(LIST_W_DEFAULT);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const f = parseInt(localStorage.getItem(FOLDER_W_KEY) || "");
      if (!Number.isNaN(f) && f >= FOLDER_W_MIN && f <= FOLDER_W_MAX) setFolderColWidth(f);
      const l = parseInt(localStorage.getItem(LIST_W_KEY) || "");
      if (!Number.isNaN(l) && l >= LIST_W_MIN) setListColWidth(l);
    } catch {}
  }, []);

  // Drag resize handlers
  const startFolderDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = folderColWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      let next = startW + dx;
      if (next < FOLDER_W_MIN) next = FOLDER_W_MIN;
      if (next > FOLDER_W_MAX) next = FOLDER_W_MAX;
      setFolderColWidth(next);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // persist
      try { localStorage.setItem(FOLDER_W_KEY, String(Math.round(parseFloat(String((document.getElementById("mc-email-folder-col") as HTMLDivElement | null)?.style.width || "")) || folderColWidth))); } catch {}
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [folderColWidth]);

  const startListDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listColWidth;
    const maxW = window.innerWidth - READER_MIN - folderColWidth - 40; // rough margin
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      let next = startW + dx;
      if (next < LIST_W_MIN) next = LIST_W_MIN;
      if (next > maxW) next = maxW;
      setListColWidth(next);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [listColWidth, folderColWidth]);

  // Persist list width when it stabilises
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = setTimeout(() => {
      try { localStorage.setItem(LIST_W_KEY, String(listColWidth)); } catch {}
    }, 120);
    return () => clearTimeout(t);
  }, [listColWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = setTimeout(() => {
      try { localStorage.setItem(FOLDER_W_KEY, String(folderColWidth)); } catch {}
    }, 120);
    return () => clearTimeout(t);
  }, [folderColWidth]);
  // Infinite-scroll list state: `messages` accumulates pages; totalCount is
  // display-only (null while searching — counting an ilike scan is too slow
  // server-side, so search views live off has_more alone).
  const [totalCount, setTotalCount] = useState<number | null>(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // New arrivals found by a poll while the user is scrolled down — buffered so
  // the list doesn't shift under them; surfaced via an "N new" chip.
  const [pendingNew, setPendingNew] = useState<EmailMessage[]>([]);
  // Monotonically-incrementing signal so child components can
  // respond to list resets (e.g. scroll the virtualized list back to top).
  const [scrollResetSignal, setScrollResetSignal] = useState(0);

  // Request bookkeeping (refs — no stale closures)
  const listGen = useRef(0);
  const listAbort = useRef<AbortController | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const atTopRef = useRef(true);
  const messagesRef = useRef<EmailMessage[]>([]);
  const pendingNewRef = useRef<EmailMessage[]>([]);

  const fetchDomains = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/domains`);
      if (res.ok) {
        const data = await res.json();
        setDomains(data);
        if (data.length === 1 && !selectedDomain) {
          setSelectedDomain(data[0]);
        }
      }
    } catch (e) {
      console.error("Failed to fetch domains:", e);
    }
  }, [selectedDomain]);

  // Active quick filter — drives server-side filtering
  const [activeFilter, setActiveFilter] = useState<string>("all");

  // Track whether this is the first fetch (show spinner) vs background poll (silent)
  const isFirstFetch = useRef(true);

  // Build the common filter params (shared by count + list fetch).
  // Behavior:
  //   - Inbox by default hides catch-alls (server-side default) and hides
  //     spam (folder='spam' is a separate bucket).
  //   - `showCatchAllInInbox=true` sends show_catchall=true so server returns
  //     addressed + catch-all together.
  //   - `catchAllOnly=true` (sidebar "Catch-All" entry) sends is_catch_all=true
  //     and resets folder to "inbox" so we look in the right bucket.
  //   - "Spam" folder simply queries folder=spam.
  const buildFilterParams = useCallback(() => {
    const folderForApi = catchAllOnly ? "inbox" : activeFolder;
    const params = new URLSearchParams({ folder: folderForApi });
    if (selectedDomain) params.set("domain_id", selectedDomain.id);
    if (selectedAddress) params.set("address_id", selectedAddress);
    if (catchAllOnly) {
      params.set("is_catch_all", "true");
    } else if (activeFolder === "inbox" && showCatchAllInInbox) {
      params.set("show_catchall", "true");
    }
    if (searchQuery) params.set("search", searchQuery);
    if (activeFilter === "unread") params.set("is_read", "false");
    if (activeFilter === "starred") params.set("is_starred", "true");
    return params;
  }, [activeFolder, selectedDomain, selectedAddress, catchAllOnly, showCatchAllInInbox, searchQuery, activeFilter]);

  // Keep ref mirrors in sync for code that must read list state outside render
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { pendingNewRef.current = pendingNew; }, [pendingNew]);

  // One fetch pipeline for the message list.
  //   reset — filter/folder/domain/address/search changed (or manual refresh):
  //           replaces the list and re-requests the total.
  //   more  — infinite-scroll tail load via keyset cursor: appends.
  //   poll  — background freshness: merges page 1 into the accumulated list
  //           without ever touching the scrollback tail.
  const loadPage = useCallback(async (kind: "reset" | "more" | "poll") => {
    if (domains.length === 0) return;
    if (kind === "more" && (!hasMoreRef.current || loadingMoreRef.current || !nextCursorRef.current)) return;

    const gen = kind === "reset" ? ++listGen.current : listGen.current;
    if (kind === "reset") {
      listAbort.current?.abort();
      listAbort.current = new AbortController();
      if (isFirstFetch.current) setLoading(true);
    } else if (kind === "more") {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    }

    try {
      const params = buildFilterParams();
      params.set("limit", String(PAGE_SIZE));
      if (kind === "more") {
        params.set("cursor", nextCursorRef.current!);
      } else {
        params.set("with_total", "true");
      }

      const res = await apiFetch(`${API_BASE}/messages?${params}`, {
        signal: kind === "reset" ? listAbort.current?.signal : undefined,
      });
      if (gen !== listGen.current) return; // a newer reset superseded this request
      if (res.ok) {
        const body: ListResponse = await res.json();
        if (gen !== listGen.current) return;
        const rows = Array.isArray(body.messages) ? body.messages : [];

        if (kind === "reset") {
          setMessages(rows);
          messagesRef.current = rows;
          setPendingNew([]);
          nextCursorRef.current = body.next_cursor;
          hasMoreRef.current = body.has_more;
          setHasMore(body.has_more);
          setTotalCount(body.total);
        } else if (kind === "more") {
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            return [...prev, ...rows.filter((m) => !seen.has(m.id))];
          });
          nextCursorRef.current = body.next_cursor;
          hasMoreRef.current = body.has_more;
          setHasMore(body.has_more);
        } else {
          // poll: refresh flag fields in place, surface new arrivals. Rows
          // missing from page 1 are NOT removed — absence is ambiguous
          // between "moved elsewhere" and "pushed past row 50 by arrivals".
          const known = new Set([
            ...messagesRef.current.map((m) => m.id),
            ...pendingNewRef.current.map((m) => m.id),
          ]);
          const fresh = rows.filter((m) => !known.has(m.id));
          // New-mail chime — only for genuinely new inbound, non-spam mail
          // (never our own sent copies or junk). Fires whether the arrivals
          // land in place or buffer behind the "N new" chip.
          if (
            fresh.length > 0 &&
            notifSoundRef.current.soundOnNewEmail &&
            fresh.some((m) => m.direction === "inbound" && !m.is_spam && m.folder !== AGENT_FOLDER)
          ) {
            playNotificationSound(notifSoundRef.current.sound);
          }
          const byId = new Map(rows.map((m) => [m.id, m]));
          setMessages((prev) => {
            let changed = false;
            const next = prev.map((m) => {
              const inc = byId.get(m.id);
              if (!inc) return m;
              if (
                inc.is_read !== m.is_read ||
                inc.is_starred !== m.is_starred ||
                inc.is_archived !== m.is_archived ||
                inc.is_trash !== m.is_trash ||
                inc.is_spam !== m.is_spam ||
                inc.folder !== m.folder
              ) {
                changed = true;
                return inc;
              }
              return m;
            });
            if (fresh.length > 0 && atTopRef.current) {
              return [...fresh, ...next];
            }
            return changed ? next : prev;
          });
          if (fresh.length > 0 && !atTopRef.current) {
            setPendingNew((prev) => [...fresh, ...prev]);
          }
          if (typeof body.total === "number") setTotalCount(body.total);
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        console.error("Failed to fetch messages:", e);
      }
    } finally {
      if (kind === "more") {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      } else if (kind === "reset" && gen === listGen.current) {
        isFirstFetch.current = false;
        setLoading(false);
      }
    }
  }, [domains.length, buildFilterParams]);

  // Always-current handle for callbacks wired up once (service worker, etc.)
  const loadPageRef = useRef(loadPage);
  useEffect(() => { loadPageRef.current = loadPage; }, [loadPage]);

  const handleLoadMore = useCallback(() => { loadPage("more"); }, [loadPage]);

  const handleRevealPending = useCallback(() => {
    const pending = pendingNewRef.current;
    if (pending.length === 0) return;
    setMessages((prev) => {
      const ids = new Set(prev.map((m) => m.id));
      return [...pending.filter((m) => !ids.has(m.id)), ...prev];
    });
    setPendingNew([]);
    setScrollResetSignal((n) => n + 1);
  }, []);

  const handleAtTopChange = useCallback((atTop: boolean) => {
    atTopRef.current = atTop;
    // Scrolled back to top with buffered arrivals → flush them in place
    if (atTop && pendingNewRef.current.length > 0) {
      const pending = pendingNewRef.current;
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        return [...pending.filter((m) => !ids.has(m.id)), ...prev];
      });
      setPendingNew([]);
    }
  }, []);

  // --- Unread counts (domain + per-folder) ---
  // Seq guard: only the newest in-flight fetch may write, so a slow 60s-poll
  // response can't overwrite a fresher post-mutation reconcile.
  const countsSeq = useRef(0);
  const fetchUnreadCounts = useCallback(async () => {
    const seq = ++countsSeq.current;
    try {
      const res = await apiFetch(`${API_BASE}/unread-counts`);
      if (res.ok) {
        const data: UnreadCounts = await res.json();
        if (seq !== countsSeq.current) return;
        setUnreadCounts({
          domains: data.domains || {},
          folders: data.folders || {},
          totals: data.totals || {},
        });
      }
    } catch (e) {
      console.error("Failed to fetch unread counts:", e);
    }
  }, []);

  // Trailing-edge debounce: reconcile optimistic counts against the server
  // shortly after a burst of mutations settles (PATCHes commit in ~100-300ms).
  const countsReconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCountsReconcile = useCallback(() => {
    if (countsReconcileTimer.current) clearTimeout(countsReconcileTimer.current);
    countsReconcileTimer.current = setTimeout(() => fetchUnreadCounts(), 600);
  }, [fetchUnreadCounts]);

  // Optimistic count engine. Every mutation reports each affected message as
  // a (before, after) pair of its flags *while counting as unread* — null on
  // a side where it doesn't count (e.g. read → after: null). The applier
  // subtracts before's contribution and adds after's, batching a whole bulk
  // operation into one state update, then schedules the reconcile.
  const applyUnreadTransitions = useCallback((pairs: Array<[CountMsg | null, CountMsg | null]>) => {
    const real = pairs.filter(([b, a]) => b || a);
    if (real.length === 0) return;
    setUnreadCounts((prev) => {
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
          // Unread trash counts only toward the trash badge (server parity)
          bump(f, "trash", delta);
          bump(next.totals, "trash", delta);
          return;
        }
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
      for (const [before, after] of real) {
        if (before) apply(before, -1);
        if (after) apply(after, 1);
      }
      return next;
    });
    scheduleCountsReconcile();
  }, [scheduleCountsReconcile]);

  // New-mail alert sound (in-app; independent of push). Held in a ref so the
  // poll callback reads the latest setting without being torn down/rebuilt.
  const notifSoundRef = useRef(settings.notifications);
  useEffect(() => { notifSoundRef.current = settings.notifications; }, [settings.notifications]);

  const mergeFullMessage = useCallback((id: string, data: EmailMessage) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              body_html: data.body_html,
              body_text: data.body_text,
              attachments: data.attachments,
              preview: data.preview || m.preview,
            }
          : m
      )
    );
  }, []);

  const fetchFullMessage = useCallback(async (id: string, opts?: { select?: boolean }) => {
    const select = opts?.select !== false;
    try {
      const res = await apiFetch(`${API_BASE}/messages?id=${id}`);
      if (res.ok) {
        const data = await res.json();
        mergeFullMessage(id, data);
        if (select) {
          setSelectedMessage((prev) => ({
            ...data,
            thread_key: prev?.id === id ? prev.thread_key : data.thread_key,
            thread_count: prev?.id === id ? prev.thread_count : data.thread_count,
            is_read: prev?.id === id ? prev.is_read : data.is_read,
          }));
        }
      }
    } catch (e) {
      console.error("Failed to fetch message:", e);
    }
  }, [mergeFullMessage]);

  const handleToggleStar = useCallback(async (id: string, starred: boolean) => {
    const msg = messages.find((m) => m.id === id) || (selectedMessage?.id === id ? selectedMessage : null);
    if (msg && !msg.is_read) {
      // Unread star flip nets ±1 on the starred badge only
      applyUnreadTransitions([[msg, { ...msg, is_starred: !starred }]]);
    }
    // Optimistic update
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, is_starred: !starred } : m))
    );
    if (selectedMessage?.id === id) {
      setSelectedMessage((prev) => prev ? { ...prev, is_starred: !starred } : null);
    }
    await apiFetch(`${API_BASE}/messages`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_starred: !starred }),
    });
  }, [selectedMessage, messages, applyUnreadTransitions]);

  const handleTrash = useCallback(async (id: string) => {
    // Optimistic: an unread trashed message leaves its buckets, joins trash
    const msg = messages.find((m) => m.id === id) || (selectedMessage?.id === id ? selectedMessage : null);
    if (msg && !msg.is_read) {
      applyUnreadTransitions([[msg, { ...msg, is_trash: true }]]);
    }
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setTotalCount((c) => (c === null ? c : Math.max(0, c - 1)));
    if (selectedMessage?.id === id) setSelectedMessage(null);
    await apiFetch(`${API_BASE}/messages`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_trash: true }),
    });
  }, [selectedMessage, messages, applyUnreadTransitions]);

  const handleToggleSpam = useCallback(async (id: string, isSpamNow: boolean) => {
    const next = !isSpamNow;
    const msg = messages.find((m) => m.id === id) || (selectedMessage?.id === id ? selectedMessage : null);
    if (msg && !msg.is_read) {
      // Server moves folder spam <-> inbox alongside the flag
      applyUnreadTransitions([[msg, { ...msg, is_spam: next, folder: next ? "spam" : "inbox" }]]);
    }
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setTotalCount((c) => (c === null ? c : Math.max(0, c - 1)));
    if (selectedMessage?.id === id) setSelectedMessage(null);
    await apiFetch(`${API_BASE}/messages`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_spam: next }),
    });
  }, [selectedMessage, messages, applyUnreadTransitions]);

  const handleArchive = useCallback(async (id: string) => {
    // Archive moves the unread contribution inbox→archive; domain total nets 0
    const msg = messages.find((m) => m.id === id) || (selectedMessage?.id === id ? selectedMessage : null);
    if (msg && !msg.is_read) {
      applyUnreadTransitions([[msg, { ...msg, is_archived: true }]]);
    }
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setTotalCount((c) => (c === null ? c : Math.max(0, c - 1)));
    if (selectedMessage?.id === id) setSelectedMessage(null);
    await apiFetch(`${API_BASE}/messages`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_archived: true }),
    });
  }, [selectedMessage, messages, applyUnreadTransitions]);

  // Bulk actions — one ids[] PATCH per operation, one batched count update
  const bulkPatch = useCallback((ids: string[], updates: Record<string, unknown>) =>
    apiFetch(`${API_BASE}/messages`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, ...updates }),
    }), []);

  const membersOf = useCallback((id: string): EmailMessage[] => {
    const collapse = threadCollapseRef.current;
    const all = messagesRef.current;
    const seed = all.find((m) => m.id === id);
    if (!seed) return [];
    if (!collapse) return [seed];
    const key = seed.thread_key || collapse.keyById[id] || threadKey(seed);
    return collapse.members[key] || [seed];
  }, []);

  const expandToThreadIds = useCallback((ids: string[]): string[] => {
    const collapse = threadCollapseRef.current;
    if (!collapse) return ids;
    const out = new Set<string>();
    for (const id of ids) {
      const key = collapse.keyById[id];
      const members = key ? collapse.members[key] : null;
      if (members) members.forEach((m) => out.add(m.id));
      else out.add(id);
    }
    return [...out];
  }, []);

  const applyReadState = useCallback((ids: string[], nextRead: boolean) => {
    const idSet = new Set(ids);
    const toChange = messagesRef.current.filter((m) => idSet.has(m.id) && m.is_read !== nextRead);
    if (toChange.length === 0) return;
    applyUnreadTransitions(toChange.map((m) => (nextRead ? [m, null] : [null, m])));
    const changeIds = new Set(toChange.map((m) => m.id));
    setMessages((prev) =>
      prev.map((m) => (changeIds.has(m.id) ? { ...m, is_read: nextRead } : m))
    );
    setSelectedMessage((prev) =>
      prev && changeIds.has(prev.id) ? { ...prev, is_read: nextRead } : prev
    );
    void bulkPatch([...changeIds], { is_read: nextRead });
  }, [applyUnreadTransitions, bulkPatch]);

  const handleBulkMarkRead = useCallback(async (ids: string[]) => {
    applyReadState(expandToThreadIds(ids), true);
  }, [applyReadState, expandToThreadIds]);

  const handleBulkMarkUnread = useCallback(async (ids: string[]) => {
    applyReadState(expandToThreadIds(ids), false);
  }, [applyReadState, expandToThreadIds]);

  const handleBulkTrash = useCallback(async (ids: string[]) => {
    const toAdjust = messages.filter((m) => ids.includes(m.id) && !m.is_read);
    applyUnreadTransitions(toAdjust.map((m) => [m, { ...m, is_trash: true }]));
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
    setTotalCount((c) => (c === null ? c : Math.max(0, c - ids.length)));
    if (selectedMessage && ids.includes(selectedMessage.id)) setSelectedMessage(null);
    await bulkPatch(ids, { is_trash: true });
  }, [selectedMessage, messages, applyUnreadTransitions, bulkPatch]);

  const handleBulkArchive = useCallback(async (ids: string[]) => {
    const toAdjust = messages.filter((m) => ids.includes(m.id) && !m.is_read);
    applyUnreadTransitions(toAdjust.map((m) => [m, { ...m, is_archived: true }]));
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
    setTotalCount((c) => (c === null ? c : Math.max(0, c - ids.length)));
    if (selectedMessage && ids.includes(selectedMessage.id)) setSelectedMessage(null);
    await bulkPatch(ids, { is_archived: true });
  }, [selectedMessage, messages, applyUnreadTransitions, bulkPatch]);

  const handleBulkStar = useCallback(async (ids: string[]) => {
    const toAdjust = messages.filter((m) => ids.includes(m.id) && !m.is_read && !m.is_starred);
    applyUnreadTransitions(toAdjust.map((m) => [m, { ...m, is_starred: true }]));
    setMessages((prev) => prev.map((m) => ids.includes(m.id) ? { ...m, is_starred: true } : m));
    if (selectedMessage && ids.includes(selectedMessage.id)) {
      setSelectedMessage((prev) => prev ? { ...prev, is_starred: true } : null);
    }
    await bulkPatch(ids, { is_starred: true });
  }, [selectedMessage, messages, applyUnreadTransitions, bulkPatch]);

  const handleBulkUnstar = useCallback(async (ids: string[]) => {
    const toAdjust = messages.filter((m) => ids.includes(m.id) && !m.is_read && m.is_starred);
    applyUnreadTransitions(toAdjust.map((m) => [m, { ...m, is_starred: false }]));
    setMessages((prev) => prev.map((m) => ids.includes(m.id) ? { ...m, is_starred: false } : m));
    if (selectedMessage && ids.includes(selectedMessage.id)) {
      setSelectedMessage((prev) => prev ? { ...prev, is_starred: false } : null);
    }
    await bulkPatch(ids, { is_starred: false });
  }, [selectedMessage, messages, applyUnreadTransitions, bulkPatch]);

  // Spam: marking moves to spam folder server-side; unmarking restores to inbox.
  // Either way, the message leaves the current list view (current view is never
  // both inbox and spam simultaneously).
  const handleBulkMarkSpam = useCallback(async (ids: string[]) => {
    const toAdjust = messages.filter((m) => ids.includes(m.id) && !m.is_read);
    applyUnreadTransitions(toAdjust.map((m) => [m, { ...m, is_spam: true, folder: "spam" }]));
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
    setTotalCount((c) => (c === null ? c : Math.max(0, c - ids.length)));
    if (selectedMessage && ids.includes(selectedMessage.id)) setSelectedMessage(null);
    await bulkPatch(ids, { is_spam: true });
  }, [selectedMessage, messages, applyUnreadTransitions, bulkPatch]);

  const handleBulkMarkNotSpam = useCallback(async (ids: string[]) => {
    const toAdjust = messages.filter((m) => ids.includes(m.id) && !m.is_read);
    applyUnreadTransitions(toAdjust.map((m) => [m, { ...m, is_spam: false, folder: "inbox" }]));
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
    setTotalCount((c) => (c === null ? c : Math.max(0, c - ids.length)));
    if (selectedMessage && ids.includes(selectedMessage.id)) setSelectedMessage(null);
    await bulkPatch(ids, { is_spam: false });
  }, [selectedMessage, messages, applyUnreadTransitions, bulkPatch]);

  const handleToggleRead = useCallback(async (id: string, _isRead?: boolean) => {
    // Flip the whole conversation: any unread → all read; else all unread.
    const members = membersOf(id);
    const pool = members.length > 0 ? members : messagesRef.current.filter((m) => m.id === id);
    const ids = pool.map((m) => m.id);
    if (ids.length === 0) return;
    const anyUnread = pool.some((m) => !m.is_read);
    applyReadState(ids, anyUnread);
  }, [membersOf, applyReadState]);

  // Compose modes
  const [composeMode, setComposeMode] = useState<"new" | "reply" | "reply-all" | "forward">("new");
  const [composeReplyTo, setComposeReplyTo] = useState<EmailMessage | null>(null);
  const [composeDraft, setComposeDraft] = useState<any>(null);

  const openCompose = useCallback((mode: "new" | "reply" | "reply-all" | "forward", msg?: EmailMessage | null) => {
    setComposeMode(mode);
    setComposeReplyTo(msg || null);
    setComposeDraft(null);
    setShowCompose(true);
  }, []);

  // Always clear mode + reply target on close so Compose never resurrects a Reply.
  const closeCompose = useCallback(() => {
    setShowCompose(false);
    setComposeDraft(null);
    setComposeReplyTo(null);
    setComposeMode("new");
  }, []);

  // Drafts
  const [drafts, setDrafts] = useState<any[]>([]);

  const fetchDrafts = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/drafts`);
      if (res.ok) {
        const data = await res.json();
        setDrafts(Array.isArray(data) ? data : []);
      }
    } catch (e) {
      console.error("Failed to fetch drafts:", e);
    }
  }, []);

  const openDraft = useCallback((draft: any) => {
    setComposeDraft(draft);
    setComposeMode(draft.compose_mode || "new");
    setComposeReplyTo(null);
    setShowCompose(true);
  }, []);

  useEffect(() => {
    fetchDomains();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "notification-click" && event.data?.data?.type === "email") {
          loadPageRef.current("poll");
          if (event.data.data.messageId) {
            fetchFullMessage(event.data.data.messageId);
          }
        }
      });
    }
  }, []);

  // Commit the search box to the fetch-driving query, debounced
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // A committed search change is a list reset: spinner + scroll to top
  const prevSearchRef = useRef("");
  useEffect(() => {
    if (prevSearchRef.current !== searchQuery) {
      prevSearchRef.current = searchQuery;
      isFirstFetch.current = true;
      setScrollResetSignal((n) => n + 1);
    }
  }, [searchQuery]);

  // The single list-reset effect: loadPage identity changes with every filter
  // primitive (via buildFilterParams) and with domains arriving.
  useEffect(() => {
    loadPage("reset");
    if (activeFolder === "drafts") fetchDrafts();
  }, [loadPage, activeFolder, fetchDrafts]);

  // Fetch unread counts on mount + whenever domains change
  useEffect(() => {
    if (domains.length > 0) fetchUnreadCounts();
  }, [domains.length, fetchUnreadCounts]);

  // Poll for new messages every 30 seconds — skip if mobile reader is open
  const isMobileReaderOpen = useRef(false);
  useEffect(() => {
    isMobileReaderOpen.current = mobileView === "reader";
  }, [mobileView]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden && !isMobileReaderOpen.current) {
        loadPage("poll");
      }
    }, 30000);

    // Refresh unread counts every 60 seconds (background reconciliation)
    const unreadInterval = setInterval(() => {
      if (!document.hidden && !isMobileReaderOpen.current) {
        fetchUnreadCounts();
      }
    }, 60000);

    const handleVisibility = () => {
      if (!document.hidden && !isMobileReaderOpen.current) {
        loadPage("poll");
        fetchUnreadCounts();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(interval);
      clearInterval(unreadInterval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loadPage, fetchUnreadCounts]);

  const unreadCount = messages.filter((m) => !m.is_read).length;

  // Keyboard shortcuts
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const readerRef = useRef<HTMLDivElement>(null);

  // Mark the focused conversation read the instant the row is selected
  // (click or arrows). null = never. 0 = immediately.
  const autoReadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const applyReadStateRef = useRef(applyReadState);
  const membersOfRef = useRef(membersOf);
  useEffect(() => { selectedIdRef.current = selectedMessage?.id ?? null; }, [selectedMessage?.id]);
  useEffect(() => { applyReadStateRef.current = applyReadState; }, [applyReadState]);
  useEffect(() => { membersOfRef.current = membersOf; }, [membersOf]);

  useEffect(() => {
    if (autoReadTimer.current) {
      clearTimeout(autoReadTimer.current);
      autoReadTimer.current = null;
    }
    if (markReadDelay === null) return;
    if (!selectedMessage || activeFolder === "drafts") return;
    const members = membersOfRef.current(selectedMessage.id);
    const unreadIds = (members.length > 0 ? members : [selectedMessage])
      .filter((m) => !m.is_read)
      .map((m) => m.id);
    if (unreadIds.length === 0) return;
    const delayMs = Math.max(0, markReadDelay) * 1000;
    const run = () => {
      autoReadTimer.current = null;
      applyReadStateRef.current(unreadIds, true);
    };
    if (delayMs <= 0) run();
    else autoReadTimer.current = setTimeout(run, delayMs);
    return () => {
      if (autoReadTimer.current) {
        clearTimeout(autoReadTimer.current);
        autoReadTimer.current = null;
      }
    };
    // selectedMessage object is read only when its id changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMessage?.id, markReadDelay, activeFolder]);

  // Arrow-key focus (window handler) opens the row in the reader — same as click.
  useEffect(() => {
    if (focusedIndex < 0 || activeFolder === "drafts") return;
    const list = navListRef.current.length
      ? navListRef.current
      : (threadCollapseRef.current?.display ?? messagesRef.current);
    const msg = list[focusedIndex];
    if (!msg || selectedIdRef.current === msg.id) return;
    if (msg.thread_key && selectedThreadKey && msg.thread_key === selectedThreadKey) return;
    setSelectedMessage(msg);
    setMobileView("reader");
    fetchFullMessage(msg.id);
  }, [focusedIndex, activeFolder, selectedThreadKey, fetchFullMessage]);

  // Reset focused index when messages change
  useEffect(() => {
    setFocusedIndex(-1);
  }, [activeFolder, selectedDomain, selectedAddress, searchQuery]);

  // When the column view sorts, it publishes its display order (parent
  // indices) so global j/k walks what's visually on screen. Stacked/mobile
  // views never publish — legacy ±1 stepping stays bit-identical.
  const displayOrderRef = useRef<number[] | null>(null);
  const handleDisplayOrderChange = useCallback((order: number[] | null) => {
    displayOrderRef.current = order;
  }, []);
  const stepFocus = useCallback((prev: number, delta: 1 | -1, max: number) => {
    const order = displayOrderRef.current;
    if (order && order.length > 0) {
      const pos = prev >= 0 ? order.indexOf(prev) : -1;
      const nextPos = Math.max(0, Math.min(order.length - 1, pos + delta));
      return order[nextPos] ?? prev;
    }
    return Math.max(0, Math.min(max, prev + delta));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      // Let browser chords through (⌘R refresh, ⌘⇧R hard refresh).
      if (e.metaKey || e.ctrlKey) return;
      if (showCompose) {
        if (e.key === "Escape") closeCompose();
        return;
      }
      if (settingsTarget) return; // settings modal owns its own keys

      const currentMessages = activeFolder === "drafts"
        ? drafts
        : (navListRef.current.length ? navListRef.current : (threadCollapseRef.current?.display ?? messages));

      switch (e.key) {
        case "ArrowDown":
        case "j": {
          e.preventDefault();
          setFocusedIndex((prev) => stepFocus(prev, 1, currentMessages.length - 1));
          break;
        }
        case "ArrowUp":
        case "k": {
          e.preventDefault();
          setFocusedIndex((prev) => stepFocus(prev, -1, currentMessages.length - 1));
          break;
        }
        case "Enter": {
          if (focusedIndex >= 0 && focusedIndex < currentMessages.length) {
            e.preventDefault();
            const msg = currentMessages[focusedIndex];
            if (activeFolder === "drafts") {
              openDraft(msg);
            } else {
              fetchFullMessage(msg.id);
              setMobileView("reader");
            }
          }
          break;
        }
        case "u": {
          // Toggle read/unread on focused or selected message
          e.preventDefault();
          const targetMsg = selectedMessage || (focusedIndex >= 0 ? currentMessages[focusedIndex] : null);
          if (targetMsg) {
            handleToggleRead(targetMsg.id, targetMsg.is_read);
          }
          break;
        }
        case "s": {
          // Toggle star
          e.preventDefault();
          const targetMsg = selectedMessage || (focusedIndex >= 0 ? currentMessages[focusedIndex] : null);
          if (targetMsg) {
            handleToggleStar(targetMsg.id, targetMsg.is_starred);
          }
          break;
        }
        case "c": {
          e.preventDefault();
          openCompose("new");
          break;
        }
        case "r": {
          // Plain `r` only — ⌘R / ⌘⇧R stay with the browser.
          if (!e.shiftKey && selectedMessage) {
            e.preventDefault();
            openCompose("reply", selectedMessage);
          }
          break;
        }
        case "R": {
          // Shift+R reply-all. Skip if any other modifier (⌘⇧R = hard refresh).
          if (e.shiftKey && !e.altKey && selectedMessage) {
            e.preventDefault();
            openCompose("reply-all", selectedMessage);
          }
          break;
        }
        case "f": {
          if (selectedMessage) {
            e.preventDefault();
            openCompose("forward", selectedMessage);
          }
          break;
        }
        case "a": {
          if (selectedMessage) {
            e.preventDefault();
            handleArchive(selectedMessage.id);
          }
          break;
        }
        case "Delete":
        case "Backspace": {
          e.preventDefault();
          const targetMsg = selectedMessage || (focusedIndex >= 0 ? currentMessages[focusedIndex] : null);
          if (targetMsg) {
            handleTrash(targetMsg.id);
            if (focusedIndex >= 0 && focusedIndex >= currentMessages.length - 1) {
              setFocusedIndex(Math.max(0, focusedIndex - 1));
            }
          }
          break;
        }
        case " ": {
          // Space: scroll reader down, Shift+Space: scroll up
          if (selectedMessage && readerRef.current) {
            e.preventDefault();
            readerRef.current.scrollBy({ top: e.shiftKey ? -300 : 300, behavior: "smooth" });
          }
          break;
        }
        case "Escape": {
          if (selectedMessage) {
            setSelectedMessage(null);
            setMobileView("list");
          }
          break;
        }
        case "?": {
          e.preventDefault();
          setShowShortcuts((prev) => !prev);
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showCompose, settingsTarget, activeFolder, drafts, messages, focusedIndex, selectedMessage, openCompose, openDraft, fetchFullMessage, handleArchive, handleTrash, handleToggleStar, handleToggleRead, stepFocus]);

  // Push prompt banner — same shared store as the footer bell and Settings,
  // so enabling anywhere updates everywhere instantly.
  const push = usePush();
  const [bannerDismissed, setBannerDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const dismissed = localStorage.getItem("mc-push-banner-dismissed");
      if (dismissed && Date.now() - parseInt(dismissed, 10) < 7 * 24 * 60 * 60 * 1000) return;
    } catch {}
    setBannerDismissed(false);
  }, []);

  const showPushBanner = push.supported && !push.enabled && !bannerDismissed;

  const handleDismissPushBanner = () => {
    setBannerDismissed(true);
    localStorage.setItem("mc-push-banner-dismissed", String(Date.now()));
  };

  return (
    <div className="flex flex-col h-dvh overflow-hidden">
      <Toaster />
      {/* Dynamic width override — only applies at md+; mobile remains w-full */}
      <style>{`
        @media (min-width: 768px) {
          .mc-email-list-col { width: ${listColWidth}px !important; }
        }
        /* --- Mobile (< md) iOS Mail navigation stack --- */
        @media (max-width: 767px) {
          /* Mailboxes is the full-width root screen */
          #mc-email-folder-col { width: 100% !important; }
          /* List + reader are overlays that slide in from the right */
          .mc-mobile-pane {
            position: absolute;
            inset: 0;
            transition: transform 0.34s cubic-bezier(0.32, 0.72, 0, 1);
            will-change: transform;
          }
          .mc-mobile-pane.mc-pane-off { transform: translateX(100%); }
        }
        @media (min-width: 768px) {
          /* Desktop keeps the flat three-column layout — no transforms */
          .mc-mobile-pane { position: static; transform: none !important; }
        }
      `}</style>
      {/* Push notification prompt banner */}
      {showPushBanner && (
        <div
          className="flex items-center gap-3 px-4 py-2.5 text-sm"
          style={{
            backgroundColor: "var(--mc-accent-bg)",
            borderBottom: "1px solid var(--mc-accent-bg)",
            color: "var(--mc-text)",
          }}
        >
          <Bell className="h-4 w-4 flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
          <span className="flex-1">
            <strong>Get email notifications</strong> — receive push alerts when new emails arrive, even when MC is closed.
          </span>
          <button
            onClick={() => push.toggle()}
            disabled={push.loading}
            className="px-3 py-1 rounded-md text-xs font-semibold transition-all"
            style={{
              backgroundColor: "var(--mc-accent)",
              color: "#fff",
              opacity: push.loading ? 0.6 : 1,
            }}
          >
            {push.loading ? "Enabling..." : "Enable"}
          </button>
          <button
            onClick={handleDismissPushBanner}
            className="p-1 rounded hover:opacity-70 transition-opacity"
            style={{ color: "var(--mc-text-faint)" }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="relative flex flex-1 overflow-hidden">
      {/* Left: Folders + Domains — the mobile root screen (always mounted;
          the list + reader slide in over it). */}
      <div
        id="mc-email-folder-col"
        className="block flex-shrink-0 overflow-hidden md:block md:border-r"
        style={{
          width: `${folderColWidth}px`,
          borderColor: "var(--mc-border)",
          backgroundColor: "var(--mc-sidebar-solid)",
        }}
      >
        <FolderList
          activeFolder={activeFolder}
          onFolderChange={(f) => {
            setActiveFolder(f);
            setActiveFilter("all");
            setCatchAllOnly(false);
            setSelectedMessage(null);
            setMobileView("list");
            isFirstFetch.current = true;
            setScrollResetSignal((n) => n + 1);
            if (f !== AGENT_FOLDER) {
              setSelectedAddress((prev) => {
                const addr = selectedDomain?.addresses?.find((a) => a.id === prev);
                return addr && isAgentAddress(addr) ? null : prev;
              });
            }
            if (f === "drafts") fetchDrafts();
          }}
          onAgentOpen={(domain, addressId) => {
            setSelectedDomain(domain);
            setSelectedAddress(addressId);
            setActiveFolder(AGENT_FOLDER);
            setCatchAllOnly(false);
            setActiveFilter("all");
            setSelectedMessage(null);
            setMobileView("list");
            isFirstFetch.current = true;
            setScrollResetSignal((n) => n + 1);
          }}
          domains={domains}
          selectedDomain={selectedDomain}
          onDomainChange={(d) => {
            setSelectedDomain(d);
            // Restore the recipient filter that was last used on this
            // domain (if any) — so cycling between domains keeps each
            // one's chosen address sticky.
            let restored: string | null = null;
            if (d) {
              try {
                if (typeof window !== "undefined") {
                  const saved = localStorage.getItem(`mc.email.address.${d.id}`);
                  if (saved && (d.addresses || []).some((a) => a.id === saved && a.is_active && !isAgentAddress(a))) {
                    restored = saved;
                  }
                }
              } catch {}
            }
            setSelectedAddress(restored);
            setCatchAllOnly(false);
            setSelectedMessage(null);
            isFirstFetch.current = true;
            setScrollResetSignal((n) => n + 1);
          }}
          selectedAddress={selectedAddress}
          onAddressChange={(a) => {
            setSelectedAddress(a);
            setCatchAllOnly(false);
            setSelectedMessage(null);
            setScrollResetSignal((n) => n + 1);
            if (selectedDomain) {
              try {
                if (typeof window !== "undefined") {
                  if (a) localStorage.setItem(`mc.email.address.${selectedDomain.id}`, a);
                  else localStorage.removeItem(`mc.email.address.${selectedDomain.id}`);
                }
              } catch {}
            }
          }}
          catchAllOnly={catchAllOnly}
          onCatchAllToggle={(domain) => {
            // Clicking the Catch-All sub-item selects the domain (if not
            // already) + clears any address filter + toggles catch-all-only on.
            if (selectedDomain?.id !== domain.id) setSelectedDomain(domain);
            setSelectedAddress(null);
            setCatchAllOnly(true);
            setSelectedMessage(null);
            setScrollResetSignal((n) => n + 1);
          }}
          unreadCount={unreadCount}
          draftsCount={drafts.length}
          onCompose={() => openCompose("new")}
          onRefreshDomains={() => {
            fetchDomains();
            fetchUnreadCounts();
          }}
          onOpenSettings={(target) =>
            setSettingsTarget({ tab: target?.tab ?? "general", domainId: target?.domainId ?? null })
          }
          onClose={() => setMobileView("list")}
          unreadCounts={unreadCounts}
        />
      </div>

      {/* Folder ↔ List resizer (desktop only) */}
      <div
        onMouseDown={startFolderDrag}
        className="hidden md:block flex-shrink-0 group"
        style={{
          width: "5px",
          cursor: "col-resize",
          backgroundColor: "transparent",
          position: "relative",
          zIndex: 10,
        }}
        title="Drag to resize folders"
        aria-label="Resize folders column"
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: "2px",
            width: "1px",
            backgroundColor: "var(--mc-border)",
            transition: "background-color 0.15s, width 0.15s",
          }}
          className="group-hover:bg-mc-teal group-hover:w-[2px]"
        />
      </div>

      {/* Center: Message List — slides in over the mailboxes on mobile */}
      <div
        className={`mc-email-list-col mc-mobile-pane z-20 w-full flex-shrink-0 overflow-hidden md:block ${
          mobileView === "folders" ? "mc-pane-off" : ""
        }`}
        style={{
          borderRight: "1px solid var(--mc-border)",
          backgroundColor: "var(--mc-bg-secondary)",
        }}
      >
        <MessageList
          messages={activeFolder === "drafts" ? drafts.map((d: any) => ({
            id: d.id,
            domain_id: d.domain_id || "",
            address_id: null,
            direction: "outbound" as const,
            from_address: d.from_address || "",
            from_name: null,
            to_addresses: d.to_addresses || [],
            cc_addresses: d.cc_addresses || [],
            bcc_addresses: d.bcc_addresses || [],
            subject: d.subject || "(no subject)",
            body_text: d.body_text,
            body_html: d.body_html,
            preview: d.body_text?.substring(0, 100) || "",
            folder: "drafts",
            is_read: true,
            is_starred: false,
            is_catch_all: false,
            is_archived: false,
            is_trash: false,
            is_draft: true,
            received_at: d.updated_at,
            attachments: [],
          }) as EmailMessage) : messages}
          selectedId={selectedMessage?.id || null}
          loading={loading}
          searchQuery={searchInput}
          onSearchChange={setSearchInput}
          onSelectMessage={(m) => {
            if (activeFolder === "drafts") {
              const draft = drafts.find((d: any) => d.id === m.id);
              if (draft) openDraft(draft);
            } else {
              // Optimistically show the list row's data so the reader header
              // is populated the instant the pane slides in; fetchFullMessage
              // then swaps in the full body and handles mark-as-read.
              setSelectedMessage(m);
              setMobileView("reader");
              fetchFullMessage(m.id);
            }
          }}
          onToggleStar={handleToggleStar}
          onToggleRead={handleToggleRead}
          selectedThreadKey={selectedThreadKey}
          onDisplayListChange={handleDisplayListChange}
          onTrash={handleTrash}
          onArchive={handleArchive}
          onMobileMenuClick={() => setMobileView("folders")}
          onRefresh={() => { loadPage("reset"); fetchUnreadCounts(); if (activeFolder === "drafts") fetchDrafts(); }}
          focusedIndex={focusedIndex}
          onFocusedIndexChange={setFocusedIndex}
          activeFilter={activeFilter}
          onFilterChange={(f) => {
            if (f === activeFilter) return; // re-click of the active pill: nothing to do
            setActiveFilter(f);
            setMessages([]);
            isFirstFetch.current = true;
            setScrollResetSignal((n) => n + 1);
          }}
          totalCount={totalCount}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
          pendingNewCount={pendingNew.length}
          onRevealPending={handleRevealPending}
          onAtTopChange={handleAtTopChange}
          onDisplayOrderChange={handleDisplayOrderChange}
          scrollResetSignal={scrollResetSignal}
          onBulkMarkRead={handleBulkMarkRead}
          onBulkMarkUnread={handleBulkMarkUnread}
          onBulkTrash={handleBulkTrash}
          onBulkArchive={handleBulkArchive}
          onBulkStar={handleBulkStar}
          onBulkUnstar={handleBulkUnstar}
          onBulkMarkSpam={handleBulkMarkSpam}
          onBulkMarkNotSpam={handleBulkMarkNotSpam}
          activeFolder={activeFolder}
          catchAllOnly={catchAllOnly}
          showCatchAllInInbox={showCatchAllInInbox}
          onToggleShowCatchAllInInbox={(next) => {
            updateSetting("viewing", { showCatchAllInInbox: next });
            setScrollResetSignal((n) => n + 1);
          }}
          domain={selectedDomain}
          selectedAddress={selectedAddress}
          onAddressChange={(a) => {
            setSelectedAddress(a);
            setCatchAllOnly(false);
            setSelectedMessage(null);
            setScrollResetSignal((n) => n + 1);
            if (selectedDomain) {
              try {
                if (typeof window !== "undefined") {
                  if (a) localStorage.setItem(`mc.email.address.${selectedDomain.id}`, a);
                  else localStorage.removeItem(`mc.email.address.${selectedDomain.id}`);
                }
              } catch {}
            }
          }}
        />
      </div>

      {/* List ↔ Reader resizer (desktop only) */}
      <div
        onMouseDown={startListDrag}
        className="hidden md:block flex-shrink-0 group"
        style={{
          width: "5px",
          cursor: "col-resize",
          backgroundColor: "transparent",
          position: "relative",
          zIndex: 10,
        }}
        title="Drag to resize"
        aria-label="Resize message list column"
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: "2px",
            width: "1px",
            backgroundColor: "var(--mc-border)",
            transition: "background-color 0.15s, width 0.15s",
          }}
          className="group-hover:bg-mc-teal group-hover:w-[2px]"
        />
      </div>

      {/* Right: Message Reader — desktop inline column; on mobile a full-screen
          pane that slides in from the right over the list (iOS Mail push). */}
      <div
        ref={readerRef}
        className={`mc-mobile-pane z-30 flex-1 min-w-0 overflow-y-auto md:block ${
          mobileView === "reader" ? "" : "mc-pane-off"
        }`}
        style={{ backgroundColor: "var(--mc-bg)" }}
      >
        <MessageReader
          message={selectedMessage}
          threadMessages={selectedThreadMessages}
          onSelectThreadMessage={(msg) => {
            setSelectedMessage(msg);
            setMobileView("reader");
            fetchFullMessage(msg.id);
          }}
          onHydrateMessage={(id) => { void fetchFullMessage(id, { select: false }); }}
          onTrash={handleTrash}
          onArchive={handleArchive}
          onToggleStar={handleToggleStar}
          onToggleSpam={handleToggleSpam}
          onReply={(msg) => openCompose("reply", msg)}
          onReplyAll={(msg) => openCompose("reply-all", msg)}
          onForward={(msg) => openCompose("forward", msg)}
          onToggleRead={handleToggleRead}
          backLabel={folderBackLabel}
          onBack={() => {
            // Mobile: pop back to the list, keeping the message loaded so the
            // pane slides out smoothly. Desktop: just clear the selection.
            if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
              setMobileView("list");
            } else {
              setSelectedMessage(null);
            }
          }}
        />
      </div>

      {/* Compose Modal */}
      {showCompose && (
        <ComposeModal
          key={
            composeDraft?.id
              ? `draft-${composeDraft.id}`
              : composeReplyTo
                ? `${composeMode}-${composeReplyTo.id}`
                : `new-${composeMode}`
          }
          domains={domains}
          selectedDomain={selectedDomain}
          replyTo={composeReplyTo}
          composeMode={composeMode}
          draft={composeDraft}
          onClose={closeCompose}
          onSent={() => {
            closeCompose();
            loadPage("reset");
            if (activeFolder === "drafts") fetchDrafts();
          }}
        />
      )}

      {/* Global settings */}
      {settingsTarget && (
        <SettingsModal
          initialTab={settingsTarget.tab}
          initialDomainId={settingsTarget.domainId}
          domains={domains}
          onClose={() => setSettingsTarget(null)}
          onRefreshDomains={() => {
            fetchDomains();
            fetchUnreadCounts();
          }}
        />
      )}

      {/* Keyboard shortcuts help — desktop only (mobile uses compose FAB) */}
      <button
        onClick={() => setShowShortcuts(true)}
        className="hidden md:flex fixed bottom-4 right-4 z-30 h-8 w-8 rounded-full items-center justify-center transition-all"
        style={{
          backgroundColor: "var(--mc-bg-hover)",
          border: "1px solid var(--mc-border)",
          color: "var(--mc-text-faint)",
        }}
        title="Keyboard shortcuts (?)"
      >
        <HelpCircle className="h-4 w-4" />
      </button>

      {/* Keyboard shortcuts modal */}
      {showShortcuts && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setShowShortcuts(false)}>
          <div
            className="w-full max-w-[380px] rounded-2xl shadow-2xl p-5"
            style={{
              backgroundColor: "var(--mc-bg)",
              border: "1px solid var(--mc-border)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>Keyboard Shortcuts</h3>
              <button onClick={() => setShowShortcuts(false)} className="p-1 rounded" style={{ color: "var(--mc-text-faint)" }}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-1.5 text-[13px]">
              {[
                ["↑ / ↓ / j / k", "Navigate messages"],
                ["Enter", "Open message"],
                ["u", "Toggle read / unread"],
                ["s", "Toggle star"],
                ["c", "Compose new"],
                ["r", "Reply"],
                ["Shift + R", "Reply all"],
                ["f", "Forward"],
                ["a", "Archive"],
                ["Delete", "Trash"],
                ["Space", "Scroll reader down"],
                ["Shift + Space", "Scroll reader up"],
                ["Esc", "Close / go back"],
                ["?", "Show this help"],
              ].map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between py-0.5">
                  <span style={{ color: "var(--mc-text-muted)" }}>{desc}</span>
                  <kbd
                    className="px-2 py-0.5 rounded text-[11px] font-mono"
                    style={{
                      backgroundColor: "var(--mc-bg-hover)",
                      border: "1px solid var(--mc-border)",
                      color: "var(--mc-text-secondary)",
                    }}
                  >
                    {key}
                  </kbd>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-3 text-[11px]" style={{ borderTop: "1px solid var(--mc-border)", color: "var(--mc-text-faint)" }}>
              <strong>Swipe gestures:</strong> Swipe right → read/unread · Swipe left → trash / archive / star
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
