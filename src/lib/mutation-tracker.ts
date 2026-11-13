// Tracks in-flight optimistic writes (PATCHes) so server reads can't clobber
// fresher local state.
//
// Two races this closes:
//   1. Counts: a /unread-counts fetch that starts (or is still in flight)
//      while a mark-read PATCH hasn't committed returns the OLD numbers and
//      overwrites the optimistic badge → counts jump back up.
//   2. Rows: a 30s list poll racing the PATCH returns is_read=false and
//      flips a just-read row back to unread.
//
// Rule: a server read taken at snapshot `s` may overwrite local state only
// if no write was in flight when it started and none began since.

export class MutationTracker {
  private seq = 0;
  private inflight = 0;
  private idInflight = new Map<string, number>();
  private idLastSeq = new Map<string, number>();
  private idleListeners = new Set<() => void>();

  /** Register a write touching `ids`. Call the returned fn when it settles. */
  begin(ids: string[] = []): () => void {
    const mySeq = ++this.seq;
    this.inflight++;
    for (const id of ids) {
      this.idInflight.set(id, (this.idInflight.get(id) || 0) + 1);
      this.idLastSeq.set(id, mySeq);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inflight--;
      for (const id of ids) {
        const n = (this.idInflight.get(id) || 1) - 1;
        if (n <= 0) this.idInflight.delete(id);
        else this.idInflight.set(id, n);
      }
      if (this.inflight === 0) for (const l of this.idleListeners) l();
    };
  }

  /** Take before issuing a server read. */
  snapshot(): { seq: number; busy: boolean } {
    return { seq: this.seq, busy: this.inflight > 0 };
  }

  get busy(): boolean {
    return this.inflight > 0;
  }

  /** Whole-state reads (counts): safe only if nothing overlapped the read. */
  isCleanSince(snap: { seq: number; busy: boolean }): boolean {
    return !snap.busy && this.inflight === 0 && this.seq === snap.seq;
  }

  /** Per-row reads (list poll): safe if this row had no overlapping write. */
  rowIsCleanSince(id: string, snap: { seq: number }): boolean {
    if ((this.idInflight.get(id) || 0) > 0) return false;
    const last = this.idLastSeq.get(id);
    return last === undefined || last <= snap.seq;
  }

  onIdle(fn: () => void): () => void {
    this.idleListeners.add(fn);
    return () => this.idleListeners.delete(fn);
  }
}
