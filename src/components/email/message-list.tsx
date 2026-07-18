"use client";

import {
  Search,
  Star,
  Menu,
  Loader2,
  RefreshCw,
  Paperclip,
  Mail,
  MailOpen,
  Filter,
  Trash2,
  Archive,
  CheckSquare,
  Square,
  MinusSquare,
  ChevronDown,
  AlertOctagon,
  Eye,
  EyeOff,
  Shield,
} from "lucide-react";
import { useState, useRef, useCallback, useEffect, memo } from "react";
import type { EmailMessage, EmailDomain } from "./email-layout";
import { MessageListVirtual } from "./message-list-virtual";
import { MessageTable } from "./message-table";
import { formatDate, getDateGroup } from "./format";
import { useSettings } from "@/lib/settings";

// Hook: matches md: breakpoint (768px)
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 768px)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isDesktop;
}

type QuickFilter = "all" | "unread" | "starred" | "attachments";

interface MessageListProps {
  messages: EmailMessage[];
  selectedId: string | null;
  loading: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSelectMessage: (msg: EmailMessage) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onToggleRead?: (id: string, isRead: boolean) => void;
  onTrash?: (id: string) => void;
  onArchive?: (id: string) => void;
  onMobileMenuClick: () => void;
  onRefresh: () => void;
  focusedIndex?: number;
  onFocusedIndexChange?: (index: number) => void;
  activeFilter?: string;
  onFilterChange?: (filter: string) => void;
  // Infinite scroll: total is null while searching (server skips the count)
  totalCount?: number | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  // Poll-buffered new arrivals ("N new" chip) + scroll-position tracking
  pendingNewCount?: number;
  onRevealPending?: () => void;
  onAtTopChange?: (atTop: boolean) => void;
  onDisplayOrderChange?: (order: number[] | null) => void;
  scrollResetSignal?: number;
  onBulkMarkRead?: (ids: string[]) => void;
  onBulkMarkUnread?: (ids: string[]) => void;
  onBulkTrash?: (ids: string[]) => void;
  onBulkArchive?: (ids: string[]) => void;
  onBulkStar?: (ids: string[]) => void;
  onBulkUnstar?: (ids: string[]) => void;
  onBulkMarkSpam?: (ids: string[]) => void;
  onBulkMarkNotSpam?: (ids: string[]) => void;
  activeFolder?: string;
  catchAllOnly?: boolean;
  showCatchAllInInbox?: boolean;
  onToggleShowCatchAllInInbox?: (next: boolean) => void;
  // Currently-selected domain object — used to populate the recipient
  // dropdown with that domain's registered addresses.
  domain?: EmailDomain | null;
  selectedAddress?: string | null;
  onAddressChange?: (id: string | null) => void;
}

const quickFilters: { id: QuickFilter; label: string; icon: typeof Mail }[] = [
  { id: "all", label: "All", icon: Mail },
  { id: "unread", label: "Unread", icon: MailOpen },
  { id: "starred", label: "Starred", icon: Star },
  { id: "attachments", label: "Files", icon: Paperclip },
];

// --- Swipeable Message Row ---
interface MessageRowProps {
  msg: EmailMessage;
  isSelected: boolean;
  isFocused: boolean;
  isChecked: boolean;
  selectMode: boolean;
  onSelect: () => void;
  onToggleCheck: () => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onToggleRead?: (id: string, isRead: boolean) => void;
  onTrash?: (id: string) => void;
  onArchive?: (id: string) => void;
  rowRef?: (el: HTMLDivElement | null) => void;
  resetSwipeSignal: number;
}

const SWIPE_THRESHOLD = 80;
const SWIPE_SHOW = 40;

const MessageRow = memo(function MessageRow({
  msg,
  isSelected,
  isFocused,
  isChecked,
  selectMode,
  onSelect,
  onToggleCheck,
  onToggleStar,
  onToggleRead,
  onTrash,
  onArchive,
  rowRef,
  resetSwipeSignal,
}: MessageRowProps) {
  const isUnread = !msg.is_read;
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Swipe state
  const [swipeX, setSwipeX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [swipeComplete, setSwipeComplete] = useState(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const isTracking = useRef(false);
  const directionLocked = useRef<"horizontal" | "vertical" | null>(null);
  const rowElRef = useRef<HTMLDivElement | null>(null);

  // Reset swipe when signal changes (another row started swiping)
  useEffect(() => {
    if (swipeX !== 0) {
      setSwipeX(0);
      setIsSwiping(false);
      setSwipeComplete(false);
    }
  }, [resetSwipeSignal]);

  const handlePointerDown = useCallback((clientX: number, clientY: number) => {
    startX.current = clientX;
    startY.current = clientY;
    isTracking.current = true;
    directionLocked.current = null;
    setSwipeComplete(false);
  }, []);

  const handlePointerMove = useCallback((clientX: number, clientY: number, event?: TouchEvent) => {
    if (!isTracking.current) return;
    const dx = clientX - startX.current;
    const dy = clientY - startY.current;

    // Lock direction after 15px movement (higher threshold to avoid accidental swipes)
    if (!directionLocked.current) {
      if (Math.abs(dx) > 15 || Math.abs(dy) > 15) {
        directionLocked.current = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
      }
      return;
    }

    if (directionLocked.current === "vertical") return;

    // Prevent browser back/forward gesture
    if (event) event.preventDefault();

    setIsSwiping(true);
    // Clamp swipe: right max 120px, left max -200px
    const clamped = Math.max(-200, Math.min(120, dx));
    setSwipeX(clamped);
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!isTracking.current) return;
    isTracking.current = false;

    if (swipeX > SWIPE_THRESHOLD && onToggleRead) {
      // Swipe right → toggle read/unread
      setSwipeComplete(true);
      onToggleRead(msg.id, msg.is_read);
      setTimeout(() => {
        setSwipeX(0);
        setIsSwiping(false);
        setSwipeComplete(false);
      }, 300);
    } else if (swipeX < -SWIPE_THRESHOLD) {
      // Swipe left → keep open to show action buttons
      setSwipeX(-160);
      setIsSwiping(false);
    } else {
      // Snap back
      setSwipeX(0);
      setIsSwiping(false);
    }
    directionLocked.current = null;
  }, [swipeX, msg.id, msg.is_read, onToggleRead]);

  // Touch handlers — use native event listener for touchmove so we can preventDefault
  // (React synthetic events are passive by default)
  useEffect(() => {
    const el = rowElRef.current;
    if (!el) return;
    const onNativeTouchMove = (e: TouchEvent) => {
      handlePointerMove(e.touches[0].clientX, e.touches[0].clientY, e);
    };
    el.addEventListener("touchmove", onNativeTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onNativeTouchMove);
  }, [handlePointerMove]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    handlePointerDown(e.touches[0].clientX, e.touches[0].clientY);
  }, [handlePointerDown]);

  const onTouchEnd = useCallback(() => {
    handlePointerUp();
  }, [handlePointerUp]);

  // Mouse handlers for desktop drag
  useEffect(() => {
    const el = rowElRef.current;
    if (!el) return;

    const onMouseMove = (e: MouseEvent) => {
      handlePointerMove(e.clientX, e.clientY);
    };
    const onMouseUp = () => {
      handlePointerUp();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    const onMouseDown = (e: MouseEvent) => {
      // Only left click
      if (e.button !== 0) return;
      handlePointerDown(e.clientX, e.clientY);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    };

    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [handlePointerDown, handlePointerMove, handlePointerUp]);

  const swipingLeft = swipeX < -SWIPE_SHOW;
  const swipingRight = swipeX > SWIPE_SHOW;

  return (
    <div
      ref={(el) => {
        rowElRef.current = el;
        rowRef?.(el);
      }}
      className="relative overflow-hidden"
      style={{ borderBottom: "1px solid var(--mc-border, rgba(255,255,255,0.06))" }}
    >
      {/* Right action panel (revealed on swipe left) */}
      {swipingLeft && (
        <div
          className="absolute inset-y-0 right-0 flex items-stretch"
          style={{ width: "160px", zIndex: 1 }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchive?.(msg.id);
              setSwipeX(0);
              setIsSwiping(false);
            }}
            className="flex-1 flex items-center justify-center transition-colors"
            style={{ backgroundColor: "var(--mc-accent-bg-hover)" }}
          >
            <Archive className="h-5 w-5 text-white" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar(msg.id, msg.is_starred);
              setSwipeX(0);
              setIsSwiping(false);
            }}
            className="flex-1 flex items-center justify-center transition-colors"
            style={{ backgroundColor: "var(--mc-accent-bg-hover)" }}
          >
            <Star className="h-5 w-5 text-white" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onTrash?.(msg.id);
              setSwipeX(0);
              setIsSwiping(false);
            }}
            className="flex-1 flex items-center justify-center transition-colors"
            style={{ backgroundColor: "rgba(239,68,68,0.9)" }}
          >
            <Trash2 className="h-5 w-5 text-white" />
          </button>
        </div>
      )}

      {/* Left action panel (revealed on swipe right) — read/unread */}
      {swipingRight && (
        <div
          className="absolute inset-y-0 left-0 flex items-center justify-center"
          style={{
            width: `${Math.min(swipeX, 120)}px`,
            backgroundColor: isUnread ? "var(--mc-accent-bg)" : "rgba(107,114,128,0.9)",
            zIndex: 1,
          }}
        >
          {isUnread ? (
            <MailOpen className="h-5 w-5 text-white" />
          ) : (
            <Mail className="h-5 w-5 text-white" />
          )}
        </div>
      )}

      {/* Message content — slides with swipe */}
      <div
        onClick={() => {
          if (!isSwiping && Math.abs(swipeX) < 5) onSelect();
          else if (swipeX < -SWIPE_SHOW) {
            // If left-swiped open, tap to close
            setSwipeX(0);
            setIsSwiping(false);
          }
        }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        className="relative"
        style={{
          transform: `translateX(${swipeX}px)`,
          transition: isSwiping ? "none" : "transform 0.25s cubic-bezier(0.2, 0, 0, 1)",
          backgroundColor: isSelected
            ? "var(--mc-accent-bg)"
            : isFocused
            ? "var(--mc-bg-active, rgba(255,255,255,0.04))"
            : "var(--mc-bg-secondary, #111)",
          borderLeft: isUnread ? "3px solid var(--mc-accent)" : "3px solid transparent",
          cursor: "pointer",
          userSelect: "none",
          WebkitUserSelect: "none",
          touchAction: "pan-y",
        }}
      >
        <div className="px-4 py-3.5">
          <div className="flex items-start gap-2">
            {/* Checkbox (select mode) or Unread indicator */}
            {selectMode ? (
              <div
                className="mt-1 flex-shrink-0 cursor-pointer p-0.5"
                onClick={(e) => { e.stopPropagation(); onToggleCheck(); }}
              >
                {isChecked ? (
                  <CheckSquare className="h-4 w-4" style={{ color: "var(--mc-accent)" }} />
                ) : (
                  <Square className="h-4 w-4" style={{ color: "var(--mc-text-faint)" }} />
                )}
              </div>
            ) : (
              <div
                className="mt-1.5 flex-shrink-0 cursor-pointer p-1 -m-1 rounded-full hover:bg-muted/30 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleRead?.(msg.id, msg.is_read);
                }}
                title={isUnread ? "Mark as read" : "Mark as unread"}
              >
                {isUnread ? (
                  <div className="h-2.5 w-2.5 rounded-full bg-mc-teal" />
                ) : (
                  <div className="h-2.5 w-2.5 rounded-full border border-[rgba(255,255,255,0.15)]" />
                )}
              </div>
            )}

            <div className="flex-1 min-w-0">
              {/* Row 1: From + Date */}
              <div className="flex items-center gap-2 mb-0.5">
                <span
                  className={`text-[13px] truncate flex-1 ${
                    isUnread ? "font-semibold text-foreground" : "text-secondary-foreground"
                  }`}
                >
                  {msg.from_name || msg.from_address}
                </span>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {hasAttachments && (
                    <Paperclip className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {formatDate(msg.received_at)}
                  </span>
                </div>
              </div>

              {/* Row 2: Subject */}
              <div className="flex items-center gap-1.5">
                {msg.is_catch_all && (
                  <span className="text-[9px] font-bold bg-[var(--mc-accent-bg-hover)] text-mc-amber px-1 py-0.5 rounded flex-shrink-0">
                    C-A
                  </span>
                )}
                {msg.direction === "outbound" && (
                  <span className="text-[9px] font-bold bg-mc-teal-dim text-mc-teal px-1 py-0.5 rounded flex-shrink-0">
                    SENT
                  </span>
                )}
                <p
                  className={`text-[12px] truncate ${
                    isUnread ? "font-medium text-secondary-foreground" : "text-muted-foreground"
                  }`}
                >
                  {msg.subject || "(no subject)"}
                </p>
              </div>

              {/* Row 3: Preview */}
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                {msg.preview || ""}
              </p>
            </div>

            {/* Star */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleStar(msg.id, msg.is_starred);
              }}
              className="mt-0.5 flex-shrink-0 p-1"
            >
              <Star
                className={`h-3.5 w-3.5 transition-colors ${
                  msg.is_starred
                    ? "fill-[color:var(--mc-star)] text-[color:var(--mc-star)]"
                    : "text-[rgba(255,255,255,0.1)] hover:text-muted-foreground"
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

// --- Date Group Header ---
function DateGroupHeader({ label }: { label: string }) {
  return (
    <div
      className="sticky top-0 z-10 px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest"
      style={{
        backgroundColor: "var(--mc-bg-secondary, #111)",
        color: "var(--mc-text-faint, #6B7280)",
        borderBottom: "1px solid var(--mc-border, rgba(255,255,255,0.06))",
        backdropFilter: "blur(8px)",
      }}
    >
      {label}
    </div>
  );
}

export function MessageList({
  messages,
  selectedId,
  loading,
  searchQuery,
  onSearchChange,
  onSelectMessage,
  onToggleStar,
  onToggleRead,
  onTrash,
  onArchive,
  onMobileMenuClick,
  onRefresh,
  focusedIndex = -1,
  onFocusedIndexChange,
  activeFilter: externalFilter = "all",
  onFilterChange,
  totalCount = 0,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  pendingNewCount = 0,
  onRevealPending,
  onAtTopChange,
  onDisplayOrderChange,
  scrollResetSignal = 0,
  onBulkMarkRead,
  onBulkMarkUnread,
  onBulkTrash,
  onBulkArchive,
  onBulkStar,
  onBulkUnstar,
  onBulkMarkSpam,
  onBulkMarkNotSpam,
  activeFolder = "inbox",
  catchAllOnly = false,
  showCatchAllInInbox = false,
  onToggleShowCatchAllInInbox,
  domain = null,
  selectedAddress = null,
  onAddressChange,
}: MessageListProps) {
  const activeFilter = externalFilter as QuickFilter;
  const isDesktop = useIsDesktop();
  const { settings } = useSettings();
  const [refreshing, setRefreshing] = useState(false);
  const [resetSwipeSignal, setResetSwipeSignal] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [showAddressDropdown, setShowAddressDropdown] = useState(false);

  // Close address dropdown on outside click or Escape
  useEffect(() => {
    if (!showAddressDropdown) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest?.("[data-mc-email-address-dropdown]")) {
        setShowAddressDropdown(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowAddressDropdown(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [showAddressDropdown]);

  // Active recipient label for the dropdown trigger
  const activeAddress = domain && selectedAddress
    ? (domain.addresses || []).find((a) => a.id === selectedAddress)
    : null;
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());

  // Clear selection only on genuine list resets (folder/filter/search change),
  // NOT on every messages identity change — load-more appends and poll merges
  // must not nuke an in-progress selection.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [scrollResetSignal]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(messages.map((m) => m.id)));
  }, [messages]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
    setSelectMode(false);
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    onRefresh();
    setTimeout(() => setRefreshing(false), 800);
  }, [onRefresh]);

  // All quick filters (incl. attachments) are server-side now.
  const filtered = messages;

  const unreadInView = messages.filter((m) => !m.is_read).length;

  // Group messages by date
  const groupedMessages: { group: string; messages: { msg: EmailMessage; originalIndex: number }[] }[] = [];
  let lastGroup = "";
  filtered.forEach((msg, idx) => {
    const group = getDateGroup(msg.received_at);
    if (group !== lastGroup) {
      groupedMessages.push({ group, messages: [] });
      lastGroup = group;
    }
    groupedMessages[groupedMessages.length - 1].messages.push({ msg, originalIndex: idx });
  });

  // Scroll focused row into view
  useEffect(() => {
    if (focusedIndex >= 0) {
      const el = rowRefs.current.get(focusedIndex);
      if (el) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }, [focusedIndex]);

  // On page change, scroll the outer list container to top (covers mobile
  // card view). The desktop MessageTable handles its own virtualized scroll
  // via its scrollResetSignal prop.
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [scrollResetSignal]);

  // Reset all swipes when starting a new swipe
  const resetAllSwipes = useCallback(() => {
    setResetSwipeSignal((s) => s + 1);
  }, []);

  // Mobile infinite scroll: sentinel near the bottom of the card list asks
  // for the next page. Re-created whenever the list grows so a sentinel that
  // stayed inside rootMargin after an append still re-fires.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = loadMoreRef.current;
    const root = listRef.current;
    if (!el || !root || isDesktop || !onLoadMore || !hasMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { root, rootMargin: "400px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [isDesktop, onLoadMore, hasMore, messages.length]);

  return (
    <div className="flex flex-col h-full">
      {/* Top bar: search + refresh */}
      <div className="p-3" style={{ borderBottom: "1px solid var(--mc-border)" }}>
        <div className="flex items-center gap-2">
          <button
            onClick={onMobileMenuClick}
            className="md:hidden p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted/40"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div
            className="flex-1 flex items-center gap-1.5 rounded-md px-2 h-7"
            style={{ backgroundColor: "var(--mc-bg-tertiary)" }}
          >
            <Search className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--mc-text-muted)" }} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search"
              className="flex-1 min-w-0 bg-transparent text-[13px] focus:outline-none"
              style={{ color: "var(--mc-text)" }}
            />
          </div>
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded-md transition-colors"
            style={{ color: "var(--mc-text-muted)" }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Recipient (address) filter — only when a domain is selected and
            has at least one registered address. Stays active as the user
            switches folders within the same domain. */}
        {domain && (domain.addresses || []).some((a) => a.is_active) && onAddressChange && (
          <div className="mt-2 relative" data-mc-email-address-dropdown>
            <button
              onClick={() => setShowAddressDropdown((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[11px] transition-colors"
              style={{
                color: activeAddress ? "var(--mc-accent)" : "var(--mc-text-muted)",
                backgroundColor: activeAddress ? "var(--mc-accent-bg)" : "var(--mc-bg-hover, rgba(255,255,255,0.04))",
                border: "1px solid var(--mc-border)",
              }}
              title="Filter by recipient on this domain"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--mc-text-faint)" }}>
                  Recipient:
                </span>
                <span className="truncate">
                  {activeAddress ? `${activeAddress.address}@${domain.domain}` : "All recipients"}
                </span>
              </span>
              <ChevronDown className="h-3 w-3 flex-shrink-0" style={{ color: "var(--mc-text-faint)" }} />
            </button>

            {showAddressDropdown && (
              <div
                className="absolute left-0 right-0 top-full mt-1 rounded-lg shadow-xl z-30 py-1 max-h-[240px] overflow-y-auto"
                style={{ backgroundColor: "var(--mc-bg)", border: "1px solid var(--mc-border)" }}
              >
                <button
                  onClick={() => { onAddressChange(null); setShowAddressDropdown(false); }}
                  className="w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2"
                  style={{
                    color: !selectedAddress ? "var(--mc-accent)" : "var(--mc-text-muted)",
                    backgroundColor: !selectedAddress ? "var(--mc-accent-bg)" : "transparent",
                  }}
                  onMouseEnter={(e) => { if (selectedAddress) (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-bg-hover)"; }}
                  onMouseLeave={(e) => { if (selectedAddress) (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
                >
                  <span className="text-[10px] font-bold" style={{ color: "var(--mc-text-faint)" }}>★</span>
                  All recipients
                </button>
                {(domain.addresses || [])
                  .filter((a) => a.is_active)
                  .map((a) => {
                    const isActive = a.id === selectedAddress;
                    return (
                      <button
                        key={a.id}
                        onClick={() => { onAddressChange(a.id); setShowAddressDropdown(false); }}
                        className="w-full text-left px-3 py-1.5 text-[11px] transition-colors flex items-center gap-2"
                        style={{
                          color: isActive ? "var(--mc-accent)" : "var(--mc-text-muted)",
                          backgroundColor: isActive ? "var(--mc-accent-bg)" : "transparent",
                        }}
                        onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-bg-hover)"; }}
                        onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
                      >
                        <span className="truncate flex-1">
                          {a.address}<span style={{ color: "var(--mc-text-faint)" }}>@{domain.domain}</span>
                        </span>
                        {a.display_name && (
                          <span className="text-[10px] truncate" style={{ color: "var(--mc-text-faint)" }}>
                            {a.display_name}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick filter pills */}
      <div
        className="flex items-center gap-1.5 px-3 py-2"
        style={{ borderBottom: "1px solid var(--mc-border, rgba(255,255,255,0.06))" }}
      >
        {quickFilters.map((f) => {
          const isActive = activeFilter === f.id;
          let count = 0;
          if (f.id === "unread") count = messages.filter((m) => !m.is_read).length;
          else if (f.id === "starred") count = messages.filter((m) => m.is_starred).length;
          else if (f.id === "attachments")
            count = messages.filter((m) => m.attachments && m.attachments.length > 0).length;

          return (
            <button
              key={f.id}
              onClick={() => onFilterChange ? onFilterChange(f.id) : undefined}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                isActive
                  ? "bg-mc-teal-dim text-mc-teal"
                  : "text-muted-foreground hover:bg-muted/40"
              }`}
            >
              <f.icon className={`h-3 w-3 ${isActive && f.id === "starred" ? "fill-current" : ""}`} />
              {f.label}
              {count > 0 && f.id !== "all" && (
                <span className="text-[10px] font-semibold tabular-nums opacity-70">{count}</span>
              )}
            </button>
          );
        })}

        {/* Include / hide catch-alls toggle — only meaningful when viewing
            the regular inbox view (not the Catch-All folder itself). */}
        {activeFolder === "inbox" && !catchAllOnly && onToggleShowCatchAllInInbox && (
          <button
            onClick={() => onToggleShowCatchAllInInbox(!showCatchAllInInbox)}
            className={`ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all flex-shrink-0 ${
              showCatchAllInInbox
                ? "text-mc-amber bg-[rgba(255,149,0,0.12)]"
                : "text-muted-foreground hover:bg-muted/40"
            }`}
            title={showCatchAllInInbox ? "Catch-alls shown in inbox — click to hide" : "Catch-alls hidden from inbox — click to show"}
          >
            <Shield className="h-3 w-3" />
            {showCatchAllInInbox ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          </button>
        )}
      </div>

      {/* Message count + select mode + page size */}
      <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: selectedIds.size > 0 ? "1px solid var(--mc-border)" : "none" }}>
        <div className="flex items-center gap-2">
          {/* Select mode toggle */}
          <button
            onClick={() => {
              if (selectMode) { deselectAll(); } else { setSelectMode(true); }
            }}
            className="p-1 rounded transition-colors"
            style={{ color: selectMode ? "var(--mc-accent)" : "var(--mc-text-faint)" }}
            title={selectMode ? "Exit select mode" : "Select emails"}
          >
            {selectMode ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
          </button>
          <span className="text-[10px]" style={{ color: "var(--mc-text-faint)" }}>
            {selectedIds.size > 0
              ? `${selectedIds.size} selected`
              : totalCount === null
                ? `${filtered.length}${hasMore ? "+" : ""} result${filtered.length !== 1 ? "s" : ""}`
                : `${totalCount > filtered.length ? `${filtered.length} of ${totalCount}` : filtered.length} email${(totalCount || filtered.length) !== 1 ? "s" : ""}${unreadInView > 0 && activeFilter !== "unread" ? ` · ${unreadInView} unread` : ""}`
            }
          </span>
        </div>
      </div>

      {/* Bulk action bar — visible when items selected */}
      {selectMode && selectedIds.size > 0 && (
        <div
          className="flex items-center gap-1 px-3 py-1.5"
          style={{ borderBottom: "1px solid var(--mc-border)", backgroundColor: "var(--mc-bg-hover)" }}
        >
          {/* Select all / deselect all */}
          <button
            onClick={() => selectedIds.size === filtered.length ? deselectAll() : selectAll()}
            className="p-1.5 rounded transition-colors"
            style={{ color: "var(--mc-text-faint)" }}
            title={selectedIds.size === filtered.length ? "Deselect all" : "Select all"}
          >
            {selectedIds.size === filtered.length
              ? <MinusSquare className="h-3.5 w-3.5" />
              : <CheckSquare className="h-3.5 w-3.5" />}
          </button>
          <span className="text-[10px] mr-2" style={{ color: "var(--mc-text-faint)" }}>
            {selectedIds.size === filtered.length ? "All" : "All"}
          </span>

          <div className="w-px h-4" style={{ backgroundColor: "var(--mc-border)" }} />

          {/* Mark read */}
          <button
            onClick={() => { onBulkMarkRead?.(Array.from(selectedIds)); deselectAll(); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
            style={{ color: "var(--mc-text-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-accent)"; (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-accent-bg)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-text-muted)"; (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
            title="Mark as read"
          >
            <MailOpen className="h-3 w-3" /> Read
          </button>

          {/* Mark unread */}
          <button
            onClick={() => { onBulkMarkUnread?.(Array.from(selectedIds)); deselectAll(); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
            style={{ color: "var(--mc-text-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-accent)"; (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-accent-bg)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-text-muted)"; (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
            title="Mark as unread"
          >
            <Mail className="h-3 w-3" /> Unread
          </button>

          {/* Star / Unstar (flag) — flags if any selected is unstarred, else unflags all */}
          {(() => {
            const anyUnstarred = Array.from(selectedIds).some((id) => {
              const m = messages.find((mm) => mm.id === id);
              return m && !m.is_starred;
            });
            return (
              <button
                onClick={() => {
                  const ids = Array.from(selectedIds);
                  if (anyUnstarred) onBulkStar?.(ids);
                  else onBulkUnstar?.(ids);
                  deselectAll();
                }}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
                style={{ color: "var(--mc-text-muted)" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-star)"; (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-accent-bg-hover)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-text-muted)"; (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
                title={anyUnstarred ? "Flag (star)" : "Unflag"}
              >
                <Star className={`h-3 w-3 ${anyUnstarred ? "" : "fill-current"}`} /> {anyUnstarred ? "Flag" : "Unflag"}
              </button>
            );
          })()}

          {/* Archive */}
          <button
            onClick={() => { onBulkArchive?.(Array.from(selectedIds)); deselectAll(); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
            style={{ color: "var(--mc-text-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-warning)"; (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-accent-bg-hover)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-text-muted)"; (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
            title="Archive"
          >
            <Archive className="h-3 w-3" />
          </button>

          {/* Spam / Not Spam — flips meaning based on current folder.
              In Spam folder, the bulk action restores selected to Inbox; everywhere
              else it moves them to Spam. */}
          {activeFolder === "spam" ? (
            <button
              onClick={() => { onBulkMarkNotSpam?.(Array.from(selectedIds)); deselectAll(); }}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
              style={{ color: "var(--mc-text-muted)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-success)"; (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(52, 199, 89, 0.12)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-text-muted)"; (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
              title="Not spam — restore to inbox and trust the sender"
            >
              <Mail className="h-3 w-3" /> Not Spam
            </button>
          ) : (
            <button
              onClick={() => { onBulkMarkSpam?.(Array.from(selectedIds)); deselectAll(); }}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
              style={{ color: "var(--mc-text-muted)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-danger)"; (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(255, 59, 48, 0.1)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-text-muted)"; (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
              title="Mark as spam"
            >
              <AlertOctagon className="h-3 w-3" /> Spam
            </button>
          )}

          {/* Trash */}
          <button
            onClick={() => { onBulkTrash?.(Array.from(selectedIds)); deselectAll(); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors"
            style={{ color: "var(--mc-text-muted)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-danger)"; (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(255, 59, 48, 0.1)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-text-muted)"; (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
            title="Trash"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Message list with date groups */}
      <div className="relative flex-1 overflow-hidden flex flex-col">
        {/* Poll-buffered arrivals chip */}
        {pendingNewCount > 0 && onRevealPending && (
          <button
            onClick={onRevealPending}
            className="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full text-[11px] font-semibold shadow-lg transition-transform hover:scale-105"
            style={{ backgroundColor: "var(--mc-accent)", color: "#fff" }}
          >
            {pendingNewCount} new message{pendingNewCount !== 1 ? "s" : ""}
          </button>
        )}
      <div
        className="flex-1 overflow-y-auto"
        ref={listRef}
        data-mc-email-list-scroll=""
        onScroll={(e) => onAtTopChange?.((e.currentTarget as HTMLElement).scrollTop < 4)}
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 text-mc-teal animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Filter className="h-6 w-6 mb-2 opacity-40" />
            <p className="text-[13px]">
              {activeFilter !== "all" ? `No ${activeFilter} emails` : "No emails yet"}
            </p>
            {activeFilter !== "all" && (
              <button
                onClick={() => onFilterChange?.("all")}
                className="text-[11px] text-mc-teal hover:underline mt-1"
              >
                Show all
              </button>
            )}
          </div>
        ) : isDesktop && settings.viewing.desktopView === "columns" ? (
          <MessageTable
            messages={filtered}
            selectedId={selectedId}
            focusedIndex={focusedIndex}
            onFocusedIndexChange={onFocusedIndexChange}
            onSelectMessage={onSelectMessage}
            onToggleStar={onToggleStar}
            onToggleRead={onToggleRead}
            onTrash={onTrash}
            selectedIds={selectedIds}
            onSelectionChange={(ids) => {
              setSelectedIds(ids);
              if (ids.size > 0) setSelectMode(true);
              else setSelectMode(false);
            }}
            onBulkTrash={onBulkTrash}
            scrollResetSignal={scrollResetSignal}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={onLoadMore}
            onAtTopChange={onAtTopChange}
            onDisplayOrderChange={onDisplayOrderChange}
          />
        ) : isDesktop ? (
          <MessageListVirtual
            previewLines={settings.viewing.previewLines}
            messages={filtered}
            selectedId={selectedId}
            focusedIndex={focusedIndex}
            onFocusedIndexChange={onFocusedIndexChange}
            onSelectMessage={onSelectMessage}
            onToggleStar={onToggleStar}
            onToggleRead={onToggleRead}
            onTrash={onTrash}
            selectedIds={selectedIds}
            onSelectionChange={(ids) => {
              setSelectedIds(ids);
              // Auto-enable select-mode toolbar visibility when user starts multi-selecting
              if (ids.size > 0) setSelectMode(true);
              else setSelectMode(false);
            }}
            onBulkTrash={onBulkTrash}
            scrollResetSignal={scrollResetSignal}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={onLoadMore}
            onAtTopChange={onAtTopChange}
          />
        ) : (
          <>
            {groupedMessages.map((group) => (
              <div key={group.group}>
                <DateGroupHeader label={group.group} />
                {group.messages.map(({ msg, originalIndex }) => (
                  <MessageRow
                    key={msg.id}
                    msg={msg}
                    isSelected={selectedId === msg.id}
                    isFocused={focusedIndex === originalIndex}
                    isChecked={selectedIds.has(msg.id)}
                    selectMode={selectMode}
                    onSelect={() => selectMode ? toggleSelect(msg.id) : onSelectMessage(msg)}
                    onToggleCheck={() => toggleSelect(msg.id)}
                    onToggleStar={onToggleStar}
                    onToggleRead={onToggleRead}
                    onTrash={onTrash}
                    onArchive={onArchive}
                    rowRef={(el) => { rowRefs.current.set(originalIndex, el); }}
                    resetSwipeSignal={resetSwipeSignal}
                  />
                ))}
              </div>
            ))}
            {/* Infinite-scroll sentinel + tail state */}
            <div ref={loadMoreRef} />
            {loadingMore && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--mc-accent)" }} />
              </div>
            )}
          </>
        )}
      </div>
      </div>
    </div>
  );
}
