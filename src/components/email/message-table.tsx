"use client";

/**
 * MessageTable — Apple Mail-style column view for the message list.
 *
 * Features:
 *  - Row-based table with sortable/resizable columns: ●, From, Subject, Date
 *  - Column widths persisted to localStorage ("mc.email.columnWidths")
 *  - Sort state persisted ("mc.email.sort")
 *  - Virtualized via @tanstack/react-virtual (handles 40k+ rows)
 *  - Multi-select: Cmd/Ctrl+Click toggles, Shift+Click ranges, Shift+Up/Down extends
 *  - Arrow keys / j / k to navigate; Enter opens; Delete/Backspace trashes
 *  - Aria grid roles for accessibility
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDate } from "./format";
import {
  Star,
  Paperclip,
  ChevronUp,
  ChevronDown,
  CheckSquare,
  Square,
  MinusSquare,
  Loader2,
  MessagesSquare,
} from "lucide-react";
import type { EmailMessage } from "./email-layout";

// -------------------- Types --------------------

type SortColumn = "unread" | "from" | "subject" | "date";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

interface ColumnWidths {
  select: number;
  unread: number;
  from: number;
  // subject is flex (takes remaining space)
  date: number;
}

const DEFAULT_WIDTHS: ColumnWidths = {
  select: 32,
  unread: 28,
  from: 200,
  date: 96,
};

const SELECT_COL_WIDTH = 32;

const DEFAULT_SORT: SortState = { column: "date", direction: "desc" };

const COLUMN_WIDTHS_KEY = "mc.email.columnWidths";
const SORT_KEY = "mc.email.sort";

const ROW_HEIGHT = 32; // compact, Apple-Mail-ish

// -------------------- localStorage helpers --------------------

function loadWidths(): ColumnWidths {
  if (typeof window === "undefined") return DEFAULT_WIDTHS;
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_KEY);
    if (!raw) return DEFAULT_WIDTHS;
    const parsed = JSON.parse(raw) as Partial<ColumnWidths>;
    return {
      select: SELECT_COL_WIDTH,
      unread: clampNum(parsed.unread ?? DEFAULT_WIDTHS.unread, 20, 60),
      from: clampNum(parsed.from ?? DEFAULT_WIDTHS.from, 80, 500),
      date: clampNum(parsed.date ?? DEFAULT_WIDTHS.date, 60, 200),
    };
  } catch {
    return DEFAULT_WIDTHS;
  }
}

function saveWidths(w: ColumnWidths) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(w));
  } catch {
    /* ignore */
  }
}

function loadSort(): SortState {
  if (typeof window === "undefined") return DEFAULT_SORT;
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw) as Partial<SortState>;
    const col: SortColumn = (
      ["unread", "from", "subject", "date"] as const
    ).includes(parsed.column as SortColumn)
      ? (parsed.column as SortColumn)
      : "date";
    const dir: SortDirection = parsed.direction === "asc" ? "asc" : "desc";
    return { column: col, direction: dir };
  } catch {
    return DEFAULT_SORT;
  }
}

function saveSort(s: SortState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function clampNum(n: number, min: number, max: number): number {
  if (typeof n !== "number" || isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// -------------------- Props --------------------

export interface MessageTableProps {
  messages: EmailMessage[];
  selectedId: string | null;
  selectedThreadKey?: string | null;
  focusedIndex: number;
  onFocusedIndexChange?: (index: number) => void;
  onSelectMessage: (msg: EmailMessage) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onToggleRead?: (id: string, isRead: boolean) => void;
  onTrash?: (id: string) => void;
  // Multi-select (checkbox-like semantics)
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  // Bulk ops triggered via keyboard
  onBulkTrash?: (ids: string[]) => void;
  // Monotonically-incrementing signal from the parent to scroll the virtualized
  // list back to top (e.g. on list reset).
  scrollResetSignal?: number;
  // Infinite scroll
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onAtTopChange?: (atTop: boolean) => void;
  /** Publishes the display order (parent indices, sorted) so the layout's
   *  global keyboard nav can walk what's visually on screen. */
  onDisplayOrderChange?: (order: number[] | null) => void;
}

// -------------------- Component --------------------

export function MessageTable({
  messages,
  selectedId,
  selectedThreadKey = null,
  focusedIndex,
  onFocusedIndexChange,
  onSelectMessage,
  onToggleStar,
  onToggleRead,
  onTrash,
  selectedIds,
  onSelectionChange,
  onBulkTrash,
  scrollResetSignal = 0,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onAtTopChange,
  onDisplayOrderChange,
}: MessageTableProps) {
  // --- Sort state ---
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [sortLoaded, setSortLoaded] = useState(false);

  useEffect(() => {
    setSort(loadSort());
    setSortLoaded(true);
  }, []);

  useEffect(() => {
    if (sortLoaded) saveSort(sort);
  }, [sort, sortLoaded]);

  // --- Column widths ---
  const [widths, setWidths] = useState<ColumnWidths>(DEFAULT_WIDTHS);
  useEffect(() => {
    setWidths(loadWidths());
  }, []);

  const updateWidth = useCallback((key: keyof ColumnWidths, value: number) => {
    setWidths((prev) => {
      const next = { ...prev, [key]: value };
      saveWidths(next);
      return next;
    });
  }, []);

  // --- Sort order — recomputed only when the SET of message IDs changes or
  // sort settings change. Intentionally NOT recomputed on per-message field
  // updates like is_read/is_starred — that would shuffle rows underneath
  // the user while they're navigating (Apple Mail keeps rows in place when
  // marking read).
  const messageIdsKey = useMemo(
    () => messages.map((m) => m.id).join(""),
    [messages]
  );

  const sortedIds = useMemo(() => {
    // Sort conversation roots only; keep expanded children glued under their parent
    // (Apple Mail never interleaves threads when a conversation is open).
    const roots = messages.filter((m) => !m.is_thread_child);
    const childrenByKey = new Map<string, EmailMessage[]>();
    for (const m of messages) {
      if (!m.is_thread_child || !m.thread_key) continue;
      const list = childrenByKey.get(m.thread_key) || [];
      list.push(m);
      childrenByKey.set(m.thread_key, list);
    }

    const dir = sort.direction === "asc" ? 1 : -1;
    const cmpRoot = (a: EmailMessage, b: EmailMessage) => {
      let cmp = 0;
      switch (sort.column) {
        case "unread": {
          cmp = (a.is_read ? 1 : 0) - (b.is_read ? 1 : 0);
          break;
        }
        case "from": {
          const an = (a.from_name || a.from_address || "").toLowerCase();
          const bn = (b.from_name || b.from_address || "").toLowerCase();
          cmp = an.localeCompare(bn);
          break;
        }
        case "subject": {
          cmp = (a.subject || "").toLowerCase().localeCompare((b.subject || "").toLowerCase());
          break;
        }
        case "date":
        default: {
          cmp =
            (new Date(a.received_at).getTime() || 0) - (new Date(b.received_at).getTime() || 0);
          break;
        }
      }
      return cmp * dir;
    };

    const sortedRoots = [...roots].sort(cmpRoot);
    const out: string[] = [];
    for (const root of sortedRoots) {
      out.push(root.id);
      const key = root.thread_key;
      if (key && root.thread_expanded) {
        const kids = childrenByKey.get(key) || [];
        // children already oldest→newest from list builder
        for (const k of kids) out.push(k.id);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageIdsKey, sort, messages]);

  // Map the stable ID order back to fresh message objects on every render —
  // so the rows reflect up-to-date is_read / is_starred state without
  // changing position. Prefer non-child (root) metadata when an id collides.
  const sortedMessages = useMemo(() => {
    const byId = new Map<string, EmailMessage>();
    for (const m of messages) {
      const prev = byId.get(m.id);
      if (!prev || (prev.is_thread_child && !m.is_thread_child)) {
        byId.set(m.id, m);
      }
    }
    const out: EmailMessage[] = [];
    for (const id of sortedIds) {
      const m = byId.get(id);
      if (m) out.push(m);
    }
    return out;
  }, [sortedIds, messages]);

  // --- Display ↔ parent index mapping ---
  // The table shows a sorted permutation, but focusedIndex (and everything
  // emitted upward) stays in PARENT space — the index into `messages` — so
  // the layout's keyboard nav and auto-read always act on the row the user
  // sees. sortedIndices[display] = parent; displayIndexByParent inverts it.
  const parentIndexById = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((m, i) => map.set(m.id, i));
    return map;
  }, [messages]);

  const sortedIndices = useMemo(
    () => sortedIds.map((id) => parentIndexById.get(id) ?? -1),
    [sortedIds, parentIndexById]
  );

  const displayIndexByParent = useMemo(() => {
    const map = new Map<number, number>();
    sortedIndices.forEach((parentIdx, displayIdx) => {
      if (parentIdx >= 0) map.set(parentIdx, displayIdx);
    });
    return map;
  }, [sortedIndices]);

  // Publish the display order so the layout's global j/k can walk what's on
  // screen even when the table container isn't focused.
  useEffect(() => {
    onDisplayOrderChange?.(sortedIndices);
    return () => onDisplayOrderChange?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedIndices]);

  // --- Sort handler ---
  const toggleSort = useCallback((col: SortColumn) => {
    setSort((prev) => {
      if (prev.column === col) {
        return { column: col, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      // New column: default to desc for date, asc for text
      return {
        column: col,
        direction: col === "date" || col === "unread" ? "desc" : "asc",
      };
    });
  }, []);

  // --- Scroll container for virtualization ---
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: sortedMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // --- Ensure focused row is in view ---
  useEffect(() => {
    const displayIdx = displayIndexByParent.get(focusedIndex);
    if (displayIdx !== undefined && displayIdx >= 0 && displayIdx < sortedMessages.length) {
      rowVirtualizer.scrollToIndex(displayIdx, { align: "auto" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedIndex, sortedMessages.length, displayIndexByParent]);

  // --- Scroll to top on page change (scrollResetSignal increments) ---
  useEffect(() => {
    if (scrollResetSignal === 0) return; // skip initial mount
    if (parentRef.current) {
      parentRef.current.scrollTop = 0;
    }
    try {
      rowVirtualizer.scrollToIndex(0, { align: "start" });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollResetSignal]);

  // --- Anchor for shift-range selection (DISPLAY space — visual contiguity).
  // Reset whenever the sort or the id-set changes so a stale anchor can't
  // span a re-sorted permutation.
  const anchorIndex = useRef<number>(-1);
  useEffect(() => {
    anchorIndex.current = -1;
  }, [sort, messageIdsKey]);

  const applyRangeSelection = useCallback(
    (fromIdx: number, toIdx: number, keepExisting: boolean) => {
      if (fromIdx < 0 || toIdx < 0) return;
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      const next = keepExisting ? new Set(selectedIds) : new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const m = sortedMessages[i];
        if (m) next.add(m.id);
      }
      onSelectionChange(next);
    },
    [selectedIds, sortedMessages, onSelectionChange]
  );

  // --- Checkbox toggle (does NOT open the message) ---
  // idx is DISPLAY space (vItem.index); everything emitted upward is PARENT.
  const handleToggleSelect = useCallback(
    (idx: number, e: React.MouseEvent) => {
      const msg = sortedMessages[idx];
      if (!msg) return;
      if (containerRef.current) containerRef.current.focus();

      // Shift+click on checkbox → range from anchor
      if (e.shiftKey && anchorIndex.current >= 0) {
        applyRangeSelection(anchorIndex.current, idx, true);
        onFocusedIndexChange?.(sortedIndices[idx] ?? -1);
        return;
      }

      const next = new Set(selectedIds);
      if (next.has(msg.id)) next.delete(msg.id);
      else next.add(msg.id);
      onSelectionChange(next);
      onFocusedIndexChange?.(sortedIndices[idx] ?? -1);
      anchorIndex.current = idx;
    },
    [sortedMessages, sortedIndices, selectedIds, onSelectionChange, onFocusedIndexChange, applyRangeSelection]
  );

  // --- Row click ---
  const handleRowClick = useCallback(
    (idx: number, e: React.MouseEvent) => {
      const msg = sortedMessages[idx];
      if (!msg) return;

      // Keep focus on the grid container so keyboard nav keeps working
      if (containerRef.current) containerRef.current.focus();

      const cmdCtrl = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      if (cmdCtrl) {
        // Toggle individual in selection
        const next = new Set(selectedIds);
        if (next.has(msg.id)) next.delete(msg.id);
        else next.add(msg.id);
        onSelectionChange(next);
        onFocusedIndexChange?.(sortedIndices[idx] ?? -1);
        anchorIndex.current = idx;
        return;
      }

      if (shift && anchorIndex.current >= 0) {
        // Range select
        applyRangeSelection(anchorIndex.current, idx, false);
        onFocusedIndexChange?.(sortedIndices[idx] ?? -1);
        return;
      }

      // Plain click → focus, clear multi-select, open
      onSelectionChange(new Set());
      onFocusedIndexChange?.(sortedIndices[idx] ?? -1);
      anchorIndex.current = idx;
      onSelectMessage(msg);
    },
    [
      sortedMessages,
      sortedIndices,
      selectedIds,
      onSelectionChange,
      onFocusedIndexChange,
      onSelectMessage,
      applyRangeSelection,
    ]
  );

  // --- Keyboard navigation attached to the table container ---
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in an input / textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      if (sortedMessages.length === 0) return;

      // Walk in DISPLAY space so arrows follow what's on screen; emit parent.
      const currDisplay = displayIndexByParent.get(focusedIndex) ?? -1;
      const curr = currDisplay >= 0 ? currDisplay : 0;

      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      switch (e.key) {
        case "ArrowDown":
        case "j": {
          consume();
          const next = Math.min(curr + 1, sortedMessages.length - 1);
          if (e.shiftKey) {
            // extend selection
            applyRangeSelection(
              anchorIndex.current >= 0 ? anchorIndex.current : curr,
              next,
              false
            );
          } else {
            onSelectionChange(new Set());
            anchorIndex.current = next;
            const msg = sortedMessages[next];
            if (msg) onSelectMessage(msg);
          }
          onFocusedIndexChange?.(sortedIndices[next] ?? -1);
          break;
        }
        case "ArrowUp":
        case "k": {
          consume();
          const next = Math.max(curr - 1, 0);
          if (e.shiftKey) {
            applyRangeSelection(
              anchorIndex.current >= 0 ? anchorIndex.current : curr,
              next,
              false
            );
          } else {
            onSelectionChange(new Set());
            anchorIndex.current = next;
            const msg = sortedMessages[next];
            if (msg) onSelectMessage(msg);
          }
          onFocusedIndexChange?.(sortedIndices[next] ?? -1);
          break;
        }
        case "Enter": {
          if (focusedIndex >= 0 && focusedIndex < messages.length) {
            consume();
            const msg = messages[focusedIndex];
            if (msg) onSelectMessage(msg);
          }
          break;
        }
        case "Delete":
        case "Backspace": {
          consume();
          if (selectedIds.size > 0 && onBulkTrash) {
            onBulkTrash(Array.from(selectedIds));
            onSelectionChange(new Set());
          } else if (focusedIndex >= 0 && onTrash) {
            const msg = messages[focusedIndex];
            if (msg) {
              onTrash(msg.id);
              const nextIdx = Math.min(focusedIndex, messages.length - 2);
              onFocusedIndexChange?.(Math.max(0, nextIdx));
            }
          }
          break;
        }
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [
    sortedMessages,
    messages,
    sortedIndices,
    displayIndexByParent,
    focusedIndex,
    onFocusedIndexChange,
    onSelectMessage,
    onSelectionChange,
    selectedIds,
    onBulkTrash,
    onTrash,
    applyRangeSelection,
  ]);

  // --- Column resizing ---
  const resizingCol = useRef<keyof ColumnWidths | null>(null);
  const resizeStartX = useRef<number>(0);
  const resizeStartWidth = useRef<number>(0);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingCol.current) return;
      const dx = e.clientX - resizeStartX.current;
      const key = resizingCol.current;
      const min = key === "unread" ? 20 : key === "date" ? 60 : 80;
      const max = key === "unread" ? 60 : key === "date" ? 200 : 500;
      const next = clampNum(resizeStartWidth.current + dx, min, max);
      updateWidth(key, next);
    };
    const onUp = () => {
      resizingCol.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [updateWidth]);

  const startResize = useCallback(
    (key: keyof ColumnWidths, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizingCol.current = key;
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = widths[key];
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [widths]
  );

  // --- Auto-focus container when messages first load so keyboard works ---
  useLayoutEffect(() => {
    // Don't steal focus if user is typing elsewhere
    if (typeof document === "undefined") return;
    const active = document.activeElement as HTMLElement | null;
    const isTextInput =
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable);
    if (!isTextInput && containerRef.current) {
      containerRef.current.focus();
    }
  }, []);

  const virtualItems = rowVirtualizer.getVirtualItems();

  // Render-driven tail trigger (parity with the stacked list) — covers
  // environments where scroll events coalesce oddly.
  const lastVirtualIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useEffect(() => {
    if (!hasMore || loadingMore || !onLoadMore) return;
    if (lastVirtualIndex >= 0 && lastVirtualIndex >= sortedMessages.length - 6) {
      onLoadMore();
    }
  }, [lastVirtualIndex, sortedMessages.length, hasMore, loadingMore, onLoadMore]);

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full outline-none"
      tabIndex={0}
      role="grid"
      aria-rowcount={sortedMessages.length}
    >
      {/* Column header row */}
      <div
        className="flex items-center text-[10px] font-semibold uppercase tracking-wider select-none"
        style={{
          borderBottom: "1px solid var(--mc-border)",
          backgroundColor: "var(--mc-bg-secondary)",
          color: "var(--mc-text-faint)",
          height: "28px",
          flexShrink: 0,
        }}
        role="row"
      >
        {/* Select-all checkbox column */}
        <div
          className="flex items-center justify-center h-full"
          style={{ width: `${widths.select}px`, flex: "0 0 auto" }}
          role="columnheader"
        >
          {(() => {
            const total = sortedMessages.length;
            const selCount = selectedIds.size;
            const allSelected = total > 0 && selCount === total;
            const someSelected = selCount > 0 && selCount < total;
            const Icon = allSelected ? CheckSquare : someSelected ? MinusSquare : Square;
            return (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (selCount > 0) {
                    onSelectionChange(new Set());
                  } else {
                    onSelectionChange(new Set(sortedMessages.map((m) => m.id)));
                  }
                }}
                className="p-1 rounded transition-colors"
                style={{ color: selCount > 0 ? "var(--mc-accent)" : "var(--mc-text-faint)" }}
                title={allSelected ? "Deselect all" : someSelected ? "Clear selection" : "Select all"}
                aria-label={allSelected ? "Deselect all" : "Select all"}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })()}
        </div>
        <HeaderCell
          label=""
          icon="●"
          width={widths.unread}
          active={sort.column === "unread"}
          direction={sort.direction}
          onSort={() => toggleSort("unread")}
          onResize={(e) => startResize("unread", e)}
          center
        />
        <HeaderCell
          label="From"
          width={widths.from}
          active={sort.column === "from"}
          direction={sort.direction}
          onSort={() => toggleSort("from")}
          onResize={(e) => startResize("from", e)}
        />
        <HeaderCell
          label="Subject"
          flex
          active={sort.column === "subject"}
          direction={sort.direction}
          onSort={() => toggleSort("subject")}
          // Subject has a resize handle on its right too — resizes the Date column from its left
          // But we keep it simpler: only Date has no resize handle (it's the last column)
          onResize={undefined}
        />
        <HeaderCell
          label="Date"
          width={widths.date}
          active={sort.column === "date"}
          direction={sort.direction}
          onSort={() => toggleSort("date")}
          onResize={(e) => startResize("date", e)}
          align="right"
        />
      </div>

      {/* Virtualized rows */}
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto"
        style={{ backgroundColor: "var(--mc-bg-secondary)" }}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLElement;
          onAtTopChange?.(el.scrollTop < 4);
          if (hasMore && !loadingMore && onLoadMore &&
              el.scrollHeight - el.scrollTop - el.clientHeight < 800) {
            onLoadMore();
          }
        }}
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualItems.map((vItem) => {
            const msg = sortedMessages[vItem.index];
            if (!msg) return null;
            const isFocused = displayIndexByParent.get(focusedIndex) === vItem.index;
            const isInSelection = selectedIds.has(msg.id);
            const isActive = selectedId === msg.id || (!!msg.thread_key && msg.thread_key === selectedThreadKey);
            return (
              <TableRow
                key={msg.id}
                msg={msg}
                rowIndex={vItem.index}
                top={vItem.start}
                height={ROW_HEIGHT}
                widths={widths}
                isFocused={isFocused}
                isInSelection={isInSelection}
                isActive={isActive}
                onClick={handleRowClick}
                onToggleSelect={handleToggleSelect}
                onToggleStar={onToggleStar}
                onToggleRead={onToggleRead}
              />
            );
          })}
        </div>

        {loadingMore && (
          <div className="flex items-center justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--mc-accent)" }} />
          </div>
        )}

        {sortedMessages.length === 0 && (
          <div className="flex items-center justify-center py-12 text-[13px]" style={{ color: "var(--mc-text-faint)" }}>
            No emails.
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------- Header cell --------------------

interface HeaderCellProps {
  label: string;
  icon?: string;
  width?: number;
  flex?: boolean;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  onResize?: (e: React.MouseEvent) => void;
  align?: "left" | "right";
  center?: boolean;
}

function HeaderCell({
  label,
  icon,
  width,
  flex,
  active,
  direction,
  onSort,
  onResize,
  align = "left",
  center,
}: HeaderCellProps) {
  return (
    <div
      className="relative flex items-center h-full"
      style={{
        width: flex ? undefined : `${width}px`,
        flex: flex ? "1 1 auto" : "0 0 auto",
        minWidth: flex ? 0 : undefined,
      }}
      role="columnheader"
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={onSort}
        className="flex items-center gap-1 h-full w-full px-2 transition-colors"
        style={{
          color: active ? "var(--mc-text-muted)" : "var(--mc-text-faint)",
          justifyContent: center ? "center" : align === "right" ? "flex-end" : "flex-start",
        }}
        title={`Sort by ${label || "unread"}`}
      >
        {icon ? (
          <span style={{ fontSize: "10px", lineHeight: 1 }}>{icon}</span>
        ) : (
          <span className="truncate">{label}</span>
        )}
        {active && (
          direction === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        )}
      </button>
      {onResize && (
        <div
          onMouseDown={onResize}
          className="absolute top-0 right-0 h-full cursor-col-resize"
          style={{
            width: "5px",
            // Show a subtle divider line
            borderRight: "1px solid var(--mc-border)",
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}

// -------------------- Table row --------------------

interface TableRowProps {
  msg: EmailMessage;
  rowIndex: number;
  top: number;
  height: number;
  widths: ColumnWidths;
  isFocused: boolean;
  isInSelection: boolean;
  isActive: boolean;
  onClick: (idx: number, e: React.MouseEvent) => void;
  onToggleSelect: (idx: number, e: React.MouseEvent) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onToggleRead?: (id: string, isRead: boolean) => void;
}

const TableRow = memo(function TableRow({
  msg,
  rowIndex,
  top,
  height,
  widths,
  isFocused,
  isInSelection,
  isActive,
  onClick,
  onToggleSelect,
  onToggleStar,
  onToggleRead,
}: TableRowProps) {
  const isUnread = !msg.is_read;
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  const isThreadRoot = (msg.thread_count ?? 0) > 1;

  // Row background:
  //  - Active (in reader): accent background
  //  - In multi-selection: accent-lite
  //  - Focused (keyboard): subtle hover
  //  - default: transparent (alternating row striping would be nice but keep minimal)
  const bg = isActive
    ? "var(--mc-selected-bg)"
    : isInSelection
    ? "var(--mc-accent-bg)"
    : isFocused
    ? "var(--mc-bg-hover)"
    : "transparent";

  // Active row goes solid accent blue: re-point the row-local token vars so
  // every child cell (which reads var(--mc-text-*) etc.) inverts to white.
  const activeVars = isActive
    ? ({
        "--mc-text": "var(--mc-selected-fg)",
        "--mc-text-secondary": "rgba(255,255,255,0.9)",
        "--mc-text-muted": "rgba(255,255,255,0.78)",
        "--mc-text-faint": "rgba(255,255,255,0.65)",
        "--mc-accent": "#ffffff",
        "--mc-accent-bg": "rgba(255,255,255,0.25)",
        "--mc-accent-bg-hover": "rgba(255,255,255,0.25)",
        "--mc-warning": "#ffffff",
        "--mc-star": "#ffffff",
        "--mc-border": "transparent",
      } as React.CSSProperties)
    : {};

  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 1}
      aria-selected={isActive || isInSelection}
      onClick={(e) => onClick(rowIndex, e)}
      className="absolute left-0 right-0 flex items-center cursor-pointer"
      style={{
        top: `${top}px`,
        height: `${height}px`,
        backgroundColor: bg,
        borderBottom: "1px solid var(--mc-border)",
        ...activeVars,
      }}
    >
      {/* Select checkbox */}
      <div
        className="flex items-center justify-center h-full"
        style={{ width: `${widths.select}px`, flex: "0 0 auto" }}
        role="gridcell"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(rowIndex, e);
          }}
          className="p-1 rounded transition-colors"
          style={{ color: isInSelection ? "var(--mc-accent)" : "var(--mc-text-faint)" }}
          title={isInSelection ? "Deselect" : "Select"}
          aria-label={isInSelection ? "Deselect" : "Select"}
        >
          {isInSelection ? (
            <CheckSquare className="h-3.5 w-3.5" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Unread: solid blue dot · Read: hollow outline circle */}
      <div
        className="flex items-center justify-center h-full"
        style={{ width: `${widths.unread}px`, flex: "0 0 auto" }}
        role="gridcell"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleRead?.(msg.id, msg.is_read);
          }}
          className="p-0.5 rounded-full flex items-center justify-center"
          title={isUnread ? "Mark as read" : "Mark as unread"}
          aria-label={isUnread ? "Unread" : "Read"}
        >
          <div
            className="h-2.5 w-2.5 rounded-full"
            style={
              isUnread
                ? { backgroundColor: "var(--mc-accent)" }
                : {
                    backgroundColor: "transparent",
                    border: isActive
                      ? "1.5px solid rgba(255,255,255,0.55)"
                      : "1.5px solid var(--mc-border)",
                  }
            }
          />
        </button>
      </div>

      {/* From */}
      <div
        className="flex items-center h-full min-w-0 px-1 text-[12px] gap-0.5"
        style={{
          width: `${widths.from}px`,
          flex: "0 0 auto",
          paddingLeft: 4,
        }}
        role="gridcell"
      >
        <span
          className="truncate min-w-0"
          style={{
            color: isUnread ? "var(--mc-text)" : "var(--mc-text-secondary)",
            fontWeight: isUnread ? 600 : 400,
          }}
          title={msg.from_name || msg.from_address}
        >
          {msg.from_name || msg.from_address || "(unknown)"}
        </span>
      </div>

      {/* Subject (flex) */}
      <div
        className="flex items-center h-full min-w-0 px-2 text-[12px] gap-1.5"
        style={{ flex: "1 1 auto" }}
        role="gridcell"
      >
        {isThreadRoot && (
          <span
            className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 py-0.5 rounded flex-shrink-0 tabular-nums"
            style={{
              backgroundColor: isActive ? "rgba(255,255,255,0.22)" : "var(--mc-bg-elevated)",
              color: isActive ? "#fff" : "var(--mc-text-muted)",
              border: isActive ? "none" : "1px solid var(--mc-border-subtle)",
            }}
            title={`${msg.thread_count} messages in conversation`}
          >
            <MessagesSquare className="h-3 w-3" />
            {msg.thread_count}
          </span>
        )}
        {msg.is_catch_all && (
          <span
            className="text-[9px] font-bold px-1 py-0.5 rounded flex-shrink-0"
            style={{
              backgroundColor: "var(--mc-accent-bg-hover)",
              color: "var(--mc-warning)",
            }}
          >
            C-A
          </span>
        )}
        {msg.direction === "outbound" && (
          <span
            className="text-[9px] font-bold px-1 py-0.5 rounded flex-shrink-0"
            style={{
              backgroundColor: "var(--mc-accent-bg)",
              color: "var(--mc-accent)",
            }}
          >
            SENT
          </span>
        )}
        <span
          className="truncate"
          style={{
            color: isUnread ? "var(--mc-text)" : "var(--mc-text-muted)",
            fontWeight: isUnread ? 500 : 400,
          }}
          title={msg.subject || "(no subject)"}
        >
          {msg.subject || "(no subject)"}
        </span>
        {msg.preview && (
          <span
            className="truncate"
            style={{
              color: "var(--mc-text-faint)",
              fontWeight: 400,
            }}
          >
            — {msg.preview}
          </span>
        )}
        {hasAttachments && (
          <Paperclip
            className="h-3 w-3 flex-shrink-0"
            style={{ color: "var(--mc-text-faint)" }}
          />
        )}
        {msg.is_starred && (
          <Star
            className="h-3 w-3 flex-shrink-0"
            style={{ fill: "var(--mc-star)", color: "var(--mc-star)" }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar(msg.id, msg.is_starred);
            }}
          />
        )}
      </div>

      {/* Date */}
      <div
        className="flex items-center justify-end h-full px-2 text-[11px]"
        style={{
          width: `${widths.date}px`,
          flex: "0 0 auto",
          color: "var(--mc-text-faint)",
        }}
        role="gridcell"
      >
        <span className="truncate">{formatDate(msg.received_at)}</span>
      </div>
    </div>
  );
});
