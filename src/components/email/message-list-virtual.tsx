"use client";

/**
 * MessageListVirtual — Apple Mail-style stacked preview rows (desktop).
 *
 *  - Sender / subject / two-line preview per row, date-group headers inline
 *  - Renders in parent (server) order — no client-side sorting, so keyboard
 *    order always matches visual order and rows never shuffle on mark-read
 *  - Virtualized (@tanstack/react-virtual) with per-index sizes
 *  - Multi-select: Cmd/Ctrl+Click toggles, Shift+Click ranges, Shift+↑/↓
 *    extends; ↑/↓/j/k navigate; Enter opens; Delete/Backspace trashes
 *  - Solid accent-blue active row (signature Mail look)
 *  - Infinite scroll: asks for more as the tail approaches
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Star, Paperclip, Loader2, ChevronDown, ChevronRight, MessagesSquare } from "lucide-react";
import type { EmailMessage } from "./email-layout";
import { formatDate, getDateGroup } from "./format";

const ROW_HEIGHT_2_LINES = 84;
const ROW_HEIGHT_1_LINE = 68;
const HEADER_HEIGHT = 28;

type Item =
  | { t: "header"; label: string }
  | { t: "msg"; msg: EmailMessage; index: number };

export interface MessageListVirtualProps {
  messages: EmailMessage[];
  selectedId: string | null;
  selectedThreadKey?: string | null;
  focusedIndex: number;
  onFocusedIndexChange?: (index: number) => void;
  onSelectMessage: (msg: EmailMessage) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onToggleRead?: (id: string, isRead: boolean) => void;
  onTrash?: (id: string) => void;
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onBulkTrash?: (ids: string[]) => void;
  scrollResetSignal?: number;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onAtTopChange?: (atTop: boolean) => void;
  /** Preview lines under the subject (1 or 2) — drives row height. */
  previewLines?: 1 | 2;
  onToggleThreadExpand?: (threadKey: string) => void;
}

export function MessageListVirtual({
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
  previewLines = 2,
  onToggleThreadExpand,
}: MessageListVirtualProps) {
  const rowHeight = previewLines === 1 ? ROW_HEIGHT_1_LINE : ROW_HEIGHT_2_LINES;
  // Interleave date-group headers with message rows; keep a message-index →
  // item-index map so keyboard focus can scroll the right virtual item.
  const { items, msgItemIndex } = useMemo(() => {
    const out: Item[] = [];
    const map: number[] = [];
    let lastGroup = "";
    messages.forEach((msg, index) => {
      const group = getDateGroup(msg.received_at);
      if (group !== lastGroup) {
        out.push({ t: "header", label: group });
        lastGroup = group;
      }
      map[index] = out.length;
      out.push({ t: "msg", msg, index });
    });
    return { items: out, msgItemIndex: map };
  }, [messages]);

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (items[i]?.t === "header" ? HEADER_HEIGHT : rowHeight),
    overscan: 8,
  });

  // Focused row into view
  useEffect(() => {
    if (focusedIndex >= 0 && focusedIndex < messages.length) {
      const itemIdx = msgItemIndex[focusedIndex];
      if (itemIdx !== undefined) {
        rowVirtualizer.scrollToIndex(itemIdx, { align: "auto" });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedIndex, messages.length]);

  // Re-measure cached row sizes when the preview-lines setting changes
  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight]);

  // Scroll to top on list reset
  useEffect(() => {
    if (scrollResetSignal === 0) return;
    if (parentRef.current) parentRef.current.scrollTop = 0;
    try {
      rowVirtualizer.scrollToIndex(0, { align: "start" });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollResetSignal]);

  // Ask for the next page when the rendered tail nears the end (covers
  // environments where scroll events are coalesced oddly; the scroll
  // handler below is the primary trigger).
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVirtualIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useEffect(() => {
    if (!hasMore || loadingMore || !onLoadMore) return;
    if (lastVirtualIndex >= 0 && lastVirtualIndex >= items.length - 6) {
      onLoadMore();
    }
  }, [lastVirtualIndex, items.length, hasMore, loadingMore, onLoadMore]);

  // --- Selection (anchor for shift ranges) ---
  const anchorIndex = useRef<number>(-1);

  const applyRangeSelection = useCallback(
    (fromIdx: number, toIdx: number, keepExisting: boolean) => {
      if (fromIdx < 0 || toIdx < 0) return;
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      const next = keepExisting ? new Set(selectedIds) : new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const m = messages[i];
        if (m) next.add(m.id);
      }
      onSelectionChange(next);
    },
    [selectedIds, messages, onSelectionChange]
  );

  const handleRowClick = useCallback(
    (idx: number, e: React.MouseEvent) => {
      const msg = messages[idx];
      if (!msg) return;
      if (containerRef.current) containerRef.current.focus();

      if (e.metaKey || e.ctrlKey) {
        const next = new Set(selectedIds);
        if (next.has(msg.id)) next.delete(msg.id);
        else next.add(msg.id);
        onSelectionChange(next);
        onFocusedIndexChange?.(idx);
        anchorIndex.current = idx;
        return;
      }

      if (e.shiftKey && anchorIndex.current >= 0) {
        applyRangeSelection(anchorIndex.current, idx, false);
        onFocusedIndexChange?.(idx);
        return;
      }

      onSelectionChange(new Set());
      onFocusedIndexChange?.(idx);
      anchorIndex.current = idx;
      onSelectMessage(msg);
    },
    [messages, selectedIds, onSelectionChange, onFocusedIndexChange, onSelectMessage, applyRangeSelection]
  );

  // --- Keyboard nav on the grid container ---
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (messages.length === 0) return;

      const curr = focusedIndex >= 0 ? focusedIndex : 0;
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      switch (e.key) {
        case "ArrowDown":
        case "j": {
          consume();
          const next = Math.min(curr + 1, messages.length - 1);
          if (e.shiftKey) {
            applyRangeSelection(anchorIndex.current >= 0 ? anchorIndex.current : curr, next, false);
          } else {
            onSelectionChange(new Set());
            anchorIndex.current = next;
            const msg = messages[next];
            if (msg) onSelectMessage(msg);
          }
          onFocusedIndexChange?.(next);
          break;
        }
        case "ArrowUp":
        case "k": {
          consume();
          const next = Math.max(curr - 1, 0);
          if (e.shiftKey) {
            applyRangeSelection(anchorIndex.current >= 0 ? anchorIndex.current : curr, next, false);
          } else {
            onSelectionChange(new Set());
            anchorIndex.current = next;
            const msg = messages[next];
            if (msg) onSelectMessage(msg);
          }
          onFocusedIndexChange?.(next);
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
  }, [messages, focusedIndex, onFocusedIndexChange, onSelectMessage, onSelectionChange, selectedIds, onBulkTrash, onTrash, applyRangeSelection]);

  // Auto-focus so keyboard works immediately (without stealing from inputs)
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const active = document.activeElement as HTMLElement | null;
    const isTextInput =
      active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    if (!isTextInput && containerRef.current) {
      containerRef.current.focus();
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full outline-none"
      tabIndex={0}
      role="grid"
      aria-rowcount={messages.length}
    >
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto"
        style={{ backgroundColor: "var(--mc-bg-secondary)" }}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLElement;
          onAtTopChange?.(el.scrollTop < 4);
          if (
            hasMore &&
            !loadingMore &&
            onLoadMore &&
            el.scrollHeight - el.scrollTop - el.clientHeight < 800
          ) {
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
            const item = items[vItem.index];
            if (!item) return null;

            if (item.t === "header") {
              return (
                <div
                  key={`h-${item.label}-${vItem.index}`}
                  className="flex items-end px-4 pb-1 text-[11px] font-semibold"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${HEADER_HEIGHT}px`,
                    transform: `translateY(${vItem.start}px)`,
                    color: "var(--mc-text-muted)",
                    backgroundColor: "var(--mc-bg-secondary)",
                  }}
                >
                  {item.label}
                </div>
              );
            }

            const { msg, index } = item;
            const isActive = selectedId === msg.id || (!!msg.thread_key && msg.thread_key === selectedThreadKey);
            const isInSelection = selectedIds.has(msg.id);
            const isFocused = index === focusedIndex;
            const isUnread = !msg.is_read;
            const hasAttachments = !!(msg.attachments && msg.attachments.length > 0);

            const rowBg = isActive
              ? "var(--mc-selected-bg)"
              : isInSelection
              ? "var(--mc-accent-bg)"
              : isFocused
              ? "var(--mc-bg-hover)"
              : "transparent";

            const primary = isActive ? "var(--mc-selected-fg)" : "var(--mc-text)";
            const secondary = isActive ? "rgba(255,255,255,0.85)" : "var(--mc-text-secondary)";
            const muted = isActive ? "rgba(255,255,255,0.75)" : "var(--mc-text-muted)";

            return (
              <div
                key={msg.id}
                role="row"
                aria-rowindex={index + 1}
                aria-selected={isActive || isInSelection}
                onClick={(e) => handleRowClick(index, e)}
                className="cursor-default select-none"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${rowHeight}px`,
                  transform: `translateY(${vItem.start}px)`,
                  backgroundColor: rowBg,
                }}
              >
                <div
                  className="flex h-full pl-1"
                  style={{
                    paddingLeft: msg.is_thread_child ? 20 : undefined,
                    borderLeft: msg.is_thread_child
                      ? isActive
                        ? "2px solid rgba(255,255,255,0.45)"
                        : "2px solid var(--mc-accent)"
                      : undefined,
                  }}
                >
                  <div className="w-[24px] flex-shrink-0 flex items-start justify-center pt-[11px]">
                    {(msg.thread_count ?? 0) > 1 && !msg.is_thread_child ? (
                      <button
                        type="button"
                        className="thread-disclosure flex items-center justify-center rounded-full transition-colors"
                        style={{
                          width: 18,
                          height: 18,
                          color: isActive ? "#fff" : "var(--mc-text-muted)",
                          border: isActive
                            ? "1.5px solid rgba(255,255,255,0.65)"
                            : "1.5px solid var(--mc-border)",
                          backgroundColor: isActive
                            ? "rgba(255,255,255,0.14)"
                            : "var(--mc-bg-elevated)",
                        }}
                        title={msg.thread_expanded ? "Collapse conversation" : "Expand conversation"}
                        aria-expanded={!!msg.thread_expanded}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (msg.thread_key) onToggleThreadExpand?.(msg.thread_key);
                        }}
                      >
                        {msg.thread_expanded ? (
                          <ChevronDown className="h-3 w-3" strokeWidth={2.5} />
                        ) : (
                          <ChevronRight className="h-3 w-3" strokeWidth={2.5} />
                        )}
                      </button>
                    ) : null}
                  </div>
                  {/* Unread: solid blue · Read: hollow outline */}
                  <div
                    className="w-[28px] flex-shrink-0 flex items-start justify-center pt-[15px] cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleRead?.(msg.id, msg.is_read);
                    }}
                    title={isUnread ? "Mark as read" : "Mark as unread"}
                  >
                    <span
                      className="h-[9px] w-[9px] rounded-full"
                      style={
                        isUnread
                          ? { backgroundColor: isActive ? "#fff" : "var(--mc-accent)" }
                          : {
                              backgroundColor: "transparent",
                              border: isActive
                                ? "1.5px solid rgba(255,255,255,0.55)"
                                : "1.5px solid var(--mc-border)",
                            }
                      }
                    />
                  </div>

                  {/* Content */}
                  <div
                    className="flex-1 min-w-0 pr-3 pt-[7px] pb-[6px] flex flex-col"
                    style={{
                      borderBottom: isActive ? "1px solid transparent" : "1px solid var(--mc-border-subtle)",
                    }}
                  >
                    {/* Line 1: sender · flag/clip/date */}
                    <div className="flex items-center gap-1.5">
                      <span
                        className="flex-1 min-w-0 truncate text-[13px]"
                        style={{ color: primary, fontWeight: isUnread ? 600 : 500 }}
                      >
                        {msg.from_name || msg.from_address}
                      </span>
                      {msg.is_starred && (
                        <Star
                          className="h-3 w-3 flex-shrink-0"
                          style={{
                            color: isActive ? "#fff" : "var(--mc-star)",
                            fill: isActive ? "#fff" : "var(--mc-star)",
                          }}
                        />
                      )}
                      {hasAttachments && (
                        <Paperclip className="h-3 w-3 flex-shrink-0" style={{ color: muted }} />
                      )}
                      <span className="text-[11px] flex-shrink-0 tabular-nums" style={{ color: muted }}>
                        {formatDate(msg.received_at)}
                      </span>
                    </div>

                    {/* Line 2: badges + subject */}
                    <div className="flex items-center gap-1.5 mt-[1px]">
                      {msg.is_catch_all && (
                        <span
                          className="text-[9px] font-bold px-1 py-px rounded flex-shrink-0"
                          style={{
                            backgroundColor: isActive ? "rgba(255,255,255,0.25)" : "rgba(255, 149, 0, 0.15)",
                            color: isActive ? "#fff" : "var(--mc-warning)",
                          }}
                        >
                          C-A
                        </span>
                      )}
                      {msg.direction === "outbound" && (
                        <span
                          className="text-[9px] font-bold px-1 py-px rounded flex-shrink-0"
                          style={{
                            backgroundColor: isActive ? "rgba(255,255,255,0.25)" : "var(--mc-accent-bg)",
                            color: isActive ? "#fff" : "var(--mc-accent)",
                          }}
                        >
                          SENT
                        </span>
                      )}
                      {(msg.thread_count ?? 0) > 1 && !msg.is_thread_child && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 py-px rounded flex-shrink-0 tabular-nums"
                          style={{
                            backgroundColor: isActive ? "rgba(255,255,255,0.25)" : "var(--mc-bg-elevated)",
                            color: isActive ? "#fff" : "var(--mc-text-muted)",
                            border: isActive ? "none" : "1px solid var(--mc-border-subtle)",
                          }}
                          title={`${msg.thread_count} messages in conversation`}
                        >
                          <MessagesSquare className="h-3 w-3" />
                          {msg.thread_count}
                        </span>
                      )}
                      <span
                        className="flex-1 min-w-0 truncate text-[13px]"
                        style={{ color: secondary, fontWeight: isUnread ? 500 : 400 }}
                      >
                        {msg.subject || "(no subject)"}
                      </span>
                    </div>

                    {/* Preview (1 or 2 lines per the Viewing setting) */}
                    <span
                      className="text-[12px] leading-4 mt-[2px] overflow-hidden"
                      style={{
                        color: muted,
                        display: "-webkit-box",
                        WebkitLineClamp: previewLines,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {msg.preview || " "}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {loadingMore && (
          <div className="flex items-center justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--mc-accent)" }} />
          </div>
        )}

        {messages.length === 0 && (
          <div className="flex items-center justify-center py-12 text-[13px]" style={{ color: "var(--mc-text-faint)" }}>
            No emails.
          </div>
        )}
      </div>
    </div>
  );
}
