"use client";

import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import { HelpCircle, X, Bell } from "lucide-react";
import { FolderList } from "./folder-list";
import { isPushSupported, getCurrentSubscription, subscribeToPush, registerServiceWorker } from "@/lib/push-notifications";
import { MessageList } from "./message-list";
import { MessageReader } from "./message-reader";
import { ComposeModal } from "./compose-modal";
import { DomainSetup } from "./domain-setup";
import { SettingsModal } from "./settings/settings-modal";
import { apiFetch } from "@/lib/auth";
import { type SettingsTab } from "@/lib/settings";

const API_BASE = "/api/email";

// --- Mobile Bottom Sheet Reader ---
interface MobileReaderSheetProps {
  readerRef: RefObject<HTMLDivElement | null>;
  message: EmailMessage;
  onClose: () => void;
  onTrash: (id: string) => void;
  onArchive: (id: string) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onToggleSpam: (id: string, isSpamNow: boolean) => void;
  onReply: (msg: EmailMessage) => void;
  onReplyAll: (msg: EmailMessage) => void;
  onForward: (msg: EmailMessage) => void;
  onToggleRead: (id: string, isRead: boolean) => void;
}

function MobileReaderSheet({
  readerRef,
  message,
  onClose,
  onTrash,
  onArchive,
  onToggleStar,
  onToggleSpam,
  onReply,
  onReplyAll,
  onForward,
  onToggleRead,
}: MobileReaderSheetProps) {
  const [sheetY, setSheetY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const startY = useRef(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Swipe down to dismiss
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // Only allow drag from the handle area (top 48px)
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    const touchY = e.touches[0].clientY;
    if (touchY - rect.top > 48) return; // only drag from handle
    startY.current = e.touches[0].clientY;
    setIsDragging(true);
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0) setSheetY(dy); // only allow downward drag
  }, [isDragging]);

  const onTouchEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    if (sheetY > 120) {
      // Dismiss
      setIsClosing(true);
      setTimeout(onClose, 250);
    } else {
      setSheetY(0);
    }
  }, [isDragging, sheetY, onClose]);

  // Prevent body scroll when sheet is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      {/* Backdrop — semi-transparent so list is visible behind */}
      <div
        className="absolute inset-0 transition-opacity duration-250"
        style={{ backgroundColor: "rgba(0,0,0,0.3)", opacity: isClosing ? 0 : 1 }}
        onClick={onClose}
      />
      {/* Sheet */}
      <div
        ref={sheetRef}
        className="absolute left-0 right-0 bottom-0 flex flex-col overflow-hidden"
        style={{
          top: "60px",
          backgroundColor: "var(--mc-bg)",
          borderTopLeftRadius: "16px",
          borderTopRightRadius: "16px",
          boxShadow: "0 -4px 30px rgba(0,0,0,0.4)",
          transform: isClosing ? "translateY(100%)" : `translateY(${sheetY}px)`,
          transition: isDragging ? "none" : "transform 0.3s cubic-bezier(0.2, 0, 0, 1)",
          animation: isClosing ? "none" : "sheetSlideUp 0.3s cubic-bezier(0.2, 0, 0, 1)",
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Drag handle + close button */}
        <div className="flex items-center justify-between px-4 pt-2 pb-1">
          <div style={{ width: "32px" }} />
          <div
            className="w-10 h-1 rounded-full cursor-grab"
            style={{ backgroundColor: "var(--mc-border)" }}
          />
          <button
            onClick={onClose}
            className="p-1.5 rounded-full transition-colors"
            style={{ color: "var(--mc-text-faint)" }}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Reader content */}
        <div ref={readerRef} className="flex-1 overflow-y-auto">
          <MessageReader
            message={message}
            onTrash={onTrash}
            onArchive={onArchive}
            onToggleStar={onToggleStar}
            onToggleSpam={onToggleSpam}
            onReply={onReply}
            onReplyAll={onReplyAll}
            onForward={onForward}
            onToggleRead={onToggleRead}
            onBack={onClose}
          />
        </div>
      </div>

      <style>{`
        @keyframes sheetSlideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

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
  // Inbox shows addressed mail only by default — toggle to fold catch-alls
  // into the inbox view. Persisted to localStorage so the user's choice
  // survives reloads.
  const [showCatchAllInInbox, setShowCatchAllInInbox] = useState(false);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<EmailMessage | null>(null);
  const [activeFolder, setActiveFolder] = useState("inbox");
  const [loading, setLoading] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [showDomainSetup, setShowDomainSetup] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<{ tab: SettingsTab; domainId: string | null } | null>(null);
  // searchInput = what the box shows (instant); searchQuery = committed value
  // that actually drives fetches, debounced 300ms.
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileView, setMobileView] = useState<"folders" | "list" | "reader">("list");
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
      const sc = localStorage.getItem("mc.email.showCatchAll");
      if (sc === "true") setShowCatchAllInInbox(true);
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
    countsReconcileTimer.current = setTimeout(() => fetchUnreadCounts(), 1500);
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

  const fetchFullMessage = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`${API_BASE}/messages?id=${id}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedMessage(data);
        if (!data.is_read) {
          await apiFetch(`${API_BASE}/messages`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, is_read: true }),
          });
          setMessages((prev) =>
            prev.map((m) => (m.id === id ? { ...m, is_read: true } : m))
          );
          // Optimistic unread count update: message went unread -> read
          applyUnreadTransitions([[data, null]]);
        }
      }
    } catch (e) {
      console.error("Failed to fetch message:", e);
    }
  }, [applyUnreadTransitions]);

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

  const handleBulkMarkRead = useCallback(async (ids: string[]) => {
    const toAdjust = messages.filter((m) => ids.includes(m.id) && !m.is_read);
    applyUnreadTransitions(toAdjust.map((m) => [m, null]));
    setMessages((prev) => prev.map((m) => ids.includes(m.id) ? { ...m, is_read: true } : m));
    await bulkPatch(ids, { is_read: true });
  }, [messages, applyUnreadTransitions, bulkPatch]);

  const handleBulkMarkUnread = useCallback(async (ids: string[]) => {
    const toAdjust = messages.filter((m) => ids.includes(m.id) && m.is_read);
    applyUnreadTransitions(toAdjust.map((m) => [null, m]));
    setMessages((prev) => prev.map((m) => ids.includes(m.id) ? { ...m, is_read: false } : m));
    await bulkPatch(ids, { is_read: false });
  }, [messages, applyUnreadTransitions, bulkPatch]);

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

  const handleToggleRead = useCallback(async (id: string, isRead: boolean) => {
    // isRead is the CURRENT state; we flip it.
    const msg = messages.find((m) => m.id === id) || (selectedMessage?.id === id ? selectedMessage : null);
    if (msg) {
      // unread -> read: leaves the pool. read -> unread: joins it.
      applyUnreadTransitions([isRead ? [null, msg] : [msg, null]]);
    }
    // Optimistic update
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, is_read: !isRead } : m))
    );
    if (selectedMessage?.id === id) {
      setSelectedMessage((prev) => prev ? { ...prev, is_read: !isRead } : null);
    }
    await apiFetch(`${API_BASE}/messages`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_read: !isRead }),
    });
  }, [selectedMessage, messages, applyUnreadTransitions]);

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

  // Auto-mark as read after 1.5s of keyboard focus (like Apple Mail preview)
  const autoReadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (autoReadTimer.current) clearTimeout(autoReadTimer.current);
    
    const currentMessages = activeFolder === "drafts" ? drafts : messages;
    if (focusedIndex >= 0 && focusedIndex < currentMessages.length) {
      const msg = currentMessages[focusedIndex];
      if (msg && !msg.is_read) {
        autoReadTimer.current = setTimeout(() => {
          handleToggleRead(msg.id, false); // false = currently unread, will mark read
        }, 1500);
      }
    }
    return () => {
      if (autoReadTimer.current) clearTimeout(autoReadTimer.current);
    };
  }, [focusedIndex, activeFolder, drafts, messages]);

  // Reset focused index when messages change
  useEffect(() => {
    setFocusedIndex(-1);
  }, [activeFolder, selectedDomain, selectedAddress, searchQuery]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (showCompose) {
        if (e.key === "Escape") setShowCompose(false);
        return;
      }
      if (settingsTarget) return; // settings modal owns its own keys

      const currentMessages = activeFolder === "drafts" ? drafts : messages;

      switch (e.key) {
        case "ArrowDown":
        case "j": {
          e.preventDefault();
          setFocusedIndex((prev) => Math.min(prev + 1, currentMessages.length - 1));
          break;
        }
        case "ArrowUp":
        case "k": {
          e.preventDefault();
          setFocusedIndex((prev) => Math.max(prev - 1, 0));
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
          if (selectedMessage) {
            e.preventDefault();
            openCompose("reply", selectedMessage);
          }
          break;
        }
        case "R": {
          if (selectedMessage) {
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
  }, [showCompose, settingsTarget, activeFolder, drafts, messages, focusedIndex, selectedMessage, openCompose, openDraft, fetchFullMessage, handleArchive, handleTrash, handleToggleStar, handleToggleRead]);

  // Push notification prompt state
  const [showPushBanner, setShowPushBanner] = useState(false);
  const [pushSubscribing, setPushSubscribing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isPushSupported()) return;
    const dismissed = localStorage.getItem("mc-push-banner-dismissed");
    if (dismissed) {
      const dismissedAt = parseInt(dismissed, 10);
      if (Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return;
    }
    registerServiceWorker().then(() => {
      getCurrentSubscription().then((sub) => {
        if (!sub) setShowPushBanner(true);
      });
    });
  }, []);

  const handleEnablePush = async () => {
    setPushSubscribing(true);
    const sub = await subscribeToPush();
    setPushSubscribing(false);
    if (sub) {
      setShowPushBanner(false);
    } else {
      alert("Could not enable notifications. Please allow notifications in your browser settings and try again.");
    }
  };

  const handleDismissPushBanner = () => {
    setShowPushBanner(false);
    localStorage.setItem("mc-push-banner-dismissed", String(Date.now()));
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Dynamic width override — only applies at md+; mobile remains w-full */}
      <style>{`
        @media (min-width: 768px) {
          .mc-email-list-col { width: ${listColWidth}px !important; }
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
            onClick={handleEnablePush}
            disabled={pushSubscribing}
            className="px-3 py-1 rounded-md text-xs font-semibold transition-all"
            style={{
              backgroundColor: "var(--mc-accent)",
              color: "#fff",
              opacity: pushSubscribing ? 0.6 : 1,
            }}
          >
            {pushSubscribing ? "Enabling..." : "Enable"}
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

      <div className="flex flex-1 overflow-hidden">
      {/* Left: Folders + Domains */}
      <div
        id="mc-email-folder-col"
        className={`flex-shrink-0 overflow-y-auto ${
          mobileView === "folders" ? "block" : "hidden"
        } md:block`}
        style={{
          width: `${folderColWidth}px`,
          borderRight: "1px solid var(--mc-border)",
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
            if (f === "drafts") fetchDrafts();
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
                  if (saved && (d.addresses || []).some((a) => a.id === saved && a.is_active)) {
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
          onAddDomain={() => setShowDomainSetup(true)}
          onCompose={() => { setComposeDraft(null); setShowCompose(true); }}
          onRefreshDomains={() => {
            fetchDomains();
            fetchUnreadCounts();
          }}
          onOpenSettings={(target) =>
            setSettingsTarget({ tab: target?.tab ?? "general", domainId: target?.domainId ?? null })
          }
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

      {/* Center: Message List */}
      <div
        className={`mc-email-list-col w-full flex-shrink-0 overflow-hidden ${
          mobileView === "list" || mobileView === "reader" ? "block" : "hidden"
        } md:block`}
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
              fetchFullMessage(m.id);
              setMobileView("reader");
            }
          }}
          onToggleStar={handleToggleStar}
          onToggleRead={handleToggleRead}
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
            setShowCatchAllInInbox(next);
            try { if (typeof window !== "undefined") localStorage.setItem("mc.email.showCatchAll", String(next)); } catch {}
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

      {/* Right: Message Reader — desktop inline, mobile bottom sheet */}
      {/* Desktop reader */}
      <div
        ref={readerRef}
        className="flex-1 min-w-0 overflow-y-auto hidden md:block"
        style={{ backgroundColor: "var(--mc-bg)" }}
      >
        <MessageReader
          message={selectedMessage}
          onTrash={handleTrash}
          onArchive={handleArchive}
          onToggleStar={handleToggleStar}
          onToggleSpam={handleToggleSpam}
          onReply={(msg) => openCompose("reply", msg)}
          onReplyAll={(msg) => openCompose("reply-all", msg)}
          onForward={(msg) => openCompose("forward", msg)}
          onToggleRead={handleToggleRead}
          onBack={() => { setSelectedMessage(null); }}
        />
      </div>

      {/* Mobile bottom sheet reader */}
      {mobileView === "reader" && selectedMessage && (
        <MobileReaderSheet
          readerRef={readerRef}
          message={selectedMessage}
          onClose={() => { setMobileView("list"); setSelectedMessage(null); }}
          onTrash={handleTrash}
          onArchive={handleArchive}
          onToggleStar={handleToggleStar}
          onToggleSpam={handleToggleSpam}
          onReply={(msg) => openCompose("reply", msg)}
          onReplyAll={(msg) => openCompose("reply-all", msg)}
          onForward={(msg) => openCompose("forward", msg)}
          onToggleRead={handleToggleRead}
        />
      )}

      {/* Compose Modal */}
      {showCompose && (
        <ComposeModal
          domains={domains}
          selectedDomain={selectedDomain}
          replyTo={composeReplyTo}
          composeMode={composeMode}
          draft={composeDraft}
          onClose={() => { setShowCompose(false); setComposeDraft(null); }}
          onSent={() => {
            setShowCompose(false);
            setComposeDraft(null);
            loadPage("reset");
            if (activeFolder === "drafts") fetchDrafts();
          }}
        />
      )}

      {/* Domain Setup */}
      {showDomainSetup && (
        <DomainSetup
          onClose={() => setShowDomainSetup(false)}
          onDomainAdded={() => {
            setShowDomainSetup(false);
            fetchDomains();
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

      {/* Keyboard shortcuts help button */}
      <button
        onClick={() => setShowShortcuts(true)}
        className="fixed bottom-4 right-4 z-30 h-8 w-8 rounded-full flex items-center justify-center transition-all"
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
