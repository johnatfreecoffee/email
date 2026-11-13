// Keyboard list-navigation helpers (pure — unit tested).

export interface NavRow {
  id: string;
  thread_key?: string | null;
}

/** Clamp-step an index within [0, len-1]. -1 (no focus) steps to 0. */
export function stepIndex(curr: number, delta: number, len: number): number {
  if (len <= 0) return -1;
  if (curr < 0) return 0;
  return Math.max(0, Math.min(len - 1, curr + delta));
}

/**
 * Selection is tracked by message id, not index. When the visible list
 * changes under the cursor (new mail prepended, "N new" revealed, rows
 * removed, thread head replaced) find where the focused message went.
 * Falls back to the same thread, then to the old index (clamped).
 */
export function reanchorIndex(
  list: NavRow[],
  focusedIndex: number,
  anchor: { id: string; threadKey: string | null } | null
): number {
  if (focusedIndex < 0 || !anchor) return focusedIndex;
  if (list[focusedIndex]?.id === anchor.id) return focusedIndex;
  const byId = list.findIndex((m) => m.id === anchor.id);
  if (byId >= 0) return byId;
  if (anchor.threadKey) {
    const byThread = list.findIndex((m) => m.thread_key === anchor.threadKey);
    if (byThread >= 0) return byThread;
  }
  if (list.length === 0) return -1;
  return Math.min(focusedIndex, list.length - 1);
}

/**
 * Latest-wins guard for async "open this message" requests. Rapid arrowing
 * fires many detail fetches; only the newest may update the selection, so
 * a slow response for a row you already left can't yank you back to it.
 */
export class LatestRequest {
  private current: string | null = null;
  begin(key: string): void {
    this.current = key;
  }
  cancel(): void {
    this.current = null;
  }
  isLatest(key: string): boolean {
    return this.current === key;
  }
}
