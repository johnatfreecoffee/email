"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, Columns3, Loader2, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/auth";

type Stage = "received" | "working" | "waiting" | "done" | "stuck";

const STAGES: { id: Stage; label: string }[] = [
  { id: "received", label: "Received" },
  { id: "working", label: "Working" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
  { id: "stuck", label: "Stuck" },
];

export interface AgentJob {
  id: string;
  session_id: number;
  agent_local: string;
  mailbox: string | null;
  base_subject: string;
  stage: Stage;
  used_k: number;
  used_tokens: number;
  received_at: string | null;
  started_at: string | null;
  last_reply_at: string | null;
  done_at: string | null;
  stuck_at: string | null;
  updated_at: string;
  notes: string | null;
  remind_requested_at: string | null;
}

interface JobEvent {
  id: string;
  kind: string;
  at: string;
  detail: string | null;
}

interface JobMessage {
  id: string;
  from: string;
  from_name?: string;
  subject: string;
  received_at: string;
  direction: string;
  preview: string;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 45) return "Just now";
  if (sec < 3600) {
    const m = Math.max(1, Math.round(sec / 60));
    return m === 1 ? "1 min ago" : `${m} min ago`;
  }
  if (sec < 86400) {
    const h = Math.max(1, Math.round(sec / 3600));
    return h === 1 ? "1 hour ago" : `${h} hours ago`;
  }
  const d = Math.max(1, Math.round(sec / 86400));
  return d === 1 ? "Yesterday" : `${d} days ago`;
}

function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function agentLabel(local: string): string {
  const s = (local || "").replace(/^[ae]\./i, "");
  return s || local;
}

export function AgentKanban({
  onMobileMenuClick,
}: {
  onMobileMenuClick?: () => void;
}) {
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [stage, setStage] = useState<"" | Stage>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    job: AgentJob;
    events: JobEvent[];
    messages: JobMessage[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [remindBusy, setRemindBusy] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (agent) params.set("agent", agent);
    if (stage) params.set("stage", stage);
    const qs = params.toString();
    const res = await apiFetch(`/api/email/agent-jobs${qs ? `?${qs}` : ""}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(typeof data.error === "string" ? data.error : "Couldn't load the board");
      setJobs([]);
      return;
    }
    setJobs(Array.isArray(data.jobs) ? data.jobs : []);
  }, [agent, stage]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch(() => {
        if (!cancelled) setError("Couldn't load the board");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    apiFetch(`/api/email/agent-jobs?id=${encodeURIComponent(selectedId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !data.job) {
          setDetail(null);
          return;
        }
        setDetail({
          job: data.job,
          events: Array.isArray(data.events) ? data.events : [],
          messages: Array.isArray(data.messages) ? data.messages : [],
        });
        setNotesDraft(typeof data.job.notes === "string" ? data.job.notes : "");
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const j of jobs) if (j.agent_local) set.add(j.agent_local);
    return [...set].sort();
  }, [jobs]);

  const byStage = useMemo(() => {
    const map: Record<Stage, AgentJob[]> = {
      received: [],
      working: [],
      waiting: [],
      done: [],
      stuck: [],
    };
    for (const j of jobs) {
      const s = STAGES.some((x) => x.id === j.stage) ? j.stage : "received";
      map[s].push(j);
    }
    return map;
  }, [jobs]);

  async function remind() {
    if (!selectedId) return;
    setRemindBusy(true);
    try {
      await apiFetch(`/api/email/agent-jobs?id=${encodeURIComponent(selectedId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedId }),
      });
      await load();
    } finally {
      setRemindBusy(false);
    }
  }

  async function saveNotes() {
    if (!selectedId) return;
    setNotesBusy(true);
    try {
      await apiFetch(`/api/email/agent-jobs?id=${encodeURIComponent(selectedId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notesDraft }),
      });
      await load();
    } finally {
      setNotesBusy(false);
    }
  }

  const selected = detail?.job;
  const canRemind = selected && (selected.stage === "stuck" || selected.stage === "waiting");

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ backgroundColor: "var(--mc-bg-secondary)" }}>
      <div
        className="flex-shrink-0 flex items-center gap-2 px-3 h-12 border-b"
        style={{ borderColor: "var(--mc-border)", backgroundColor: "var(--mc-header-bg)" }}
      >
        <button
          type="button"
          className="md:hidden h-8 w-8 flex items-center justify-center rounded-md"
          onClick={() => (selectedId ? setSelectedId(null) : onMobileMenuClick?.())}
          style={{ color: "var(--mc-accent)" }}
          aria-label={selectedId ? "Board" : "Mailboxes"}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <Columns3 className="hidden md:block h-[15px] w-[15px]" style={{ color: "var(--mc-accent)" }} />
        <span className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>
          Kanban
        </span>
        <div className="flex-1" />
        <select
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          className="h-7 rounded-md text-[12px] px-2 border bg-transparent"
          style={{ borderColor: "var(--mc-border)", color: "var(--mc-text-secondary)" }}
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {agentLabel(a)}
            </option>
          ))}
        </select>
        <select
          value={stage}
          onChange={(e) => setStage((e.target.value || "") as "" | Stage)}
          className="h-7 rounded-md text-[12px] px-2 border bg-transparent"
          style={{ borderColor: "var(--mc-border)", color: "var(--mc-text-secondary)" }}
        >
          <option value="">All stages</option>
          {STAGES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => load()}
          className="h-7 w-7 flex items-center justify-center rounded-md"
          style={{ color: "var(--mc-text-muted)" }}
          aria-label="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-[13px]" style={{ color: "var(--mc-danger)" }}>
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className={`flex-1 min-w-0 overflow-x-auto ${selectedId ? "hidden md:block" : ""}`}>
          {loading ? (
            <div className="h-full flex items-center justify-center" style={{ color: "var(--mc-text-muted)" }}>
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-1 px-6 text-center">
              <Columns3 className="h-8 w-8 mb-2" style={{ color: "var(--mc-text-ghost)" }} />
              <div className="text-[15px] font-medium" style={{ color: "var(--mc-text)" }}>
                No agent jobs yet
              </div>
              <div className="text-[13px]" style={{ color: "var(--mc-text-muted)" }}>
                Mail an agent and the card shows up here.
              </div>
            </div>
          ) : (
            <div className="h-full min-h-0 grid grid-cols-5 gap-2 p-2 min-w-[720px]">
              {STAGES.map((col) => (
                <div
                  key={col.id}
                  className="min-h-0 flex flex-col rounded-[10px] overflow-hidden"
                  style={{ backgroundColor: "var(--mc-bg-tertiary)" }}
                >
                  <div
                    className="flex-shrink-0 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide"
                    style={{ color: "var(--mc-text-muted)" }}
                  >
                    {col.label}
                    <span className="ml-1 tabular-nums">{byStage[col.id].length}</span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2 space-y-1.5">
                    {byStage[col.id].map((job) => {
                      const active = selectedId === job.id;
                      return (
                        <button
                          key={job.id}
                          type="button"
                          onClick={() => setSelectedId(job.id)}
                          className="w-full text-left rounded-[8px] px-2.5 py-2"
                          style={{
                            backgroundColor: active ? "var(--mc-accent-bg)" : "var(--mc-card)",
                            boxShadow: "0 0.5px 0 var(--mc-card-border)",
                          }}
                        >
                          <div className="text-[13px] font-medium truncate" style={{ color: "var(--mc-text)" }}>
                            {job.base_subject || "(no subject)"}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-[11px]" style={{ color: "var(--mc-text-muted)" }}>
                            <span className="truncate">{agentLabel(job.agent_local)}</span>
                            <span className="tabular-nums flex-shrink-0">
                              {Math.max(1, Number(job.used_k) || 1)}/500K
                            </span>
                          </div>
                          <div className="text-[11px]" style={{ color: "var(--mc-text-faint)" }}>
                            {relTime(job.last_reply_at || job.updated_at)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          className={`${selectedId ? "flex" : "hidden md:flex"} w-full md:w-[340px] flex-shrink-0 flex-col md:border-l overflow-hidden`}
          style={{ borderColor: "var(--mc-border)", backgroundColor: "var(--mc-bg)" }}
        >
          {!selectedId ? (
            <div className="h-full flex items-center justify-center text-[13px] px-6 text-center" style={{ color: "var(--mc-text-muted)" }}>
              Select a card
            </div>
          ) : detailLoading || !selected ? (
            <div className="h-full flex items-center justify-center" style={{ color: "var(--mc-text-muted)" }}>
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <div>
                <div className="text-[16px] font-semibold" style={{ color: "var(--mc-text)" }}>
                  {selected.base_subject}
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
                  {agentLabel(selected.agent_local)} · {selected.stage} · {Math.max(1, Number(selected.used_k) || 1)}/500K
                </div>
              </div>
              <div className="text-[12px] space-y-1" style={{ color: "var(--mc-text-secondary)" }}>
                <div>Received {clock(selected.received_at)}</div>
                <div>Started {clock(selected.started_at)}</div>
                <div>Last reply {clock(selected.last_reply_at)}</div>
                {selected.done_at && <div>Done {clock(selected.done_at)}</div>}
                {selected.stuck_at && <div>Stuck {clock(selected.stuck_at)}</div>}
              </div>
              {canRemind && (
                <button
                  type="button"
                  onClick={remind}
                  disabled={remindBusy || !!selected.remind_requested_at}
                  className="h-8 px-3 rounded-md text-[13px] font-medium"
                  style={{
                    backgroundColor: "var(--mc-accent)",
                    color: "#fff",
                    opacity: remindBusy || selected.remind_requested_at ? 0.6 : 1,
                  }}
                >
                  {selected.remind_requested_at ? "Remind queued" : remindBusy ? "Reminding…" : "Remind"}
                </button>
              )}
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--mc-text-muted)" }}>
                  Notes
                </div>
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  rows={3}
                  className="w-full rounded-md text-[13px] p-2 border resize-y"
                  style={{
                    borderColor: "var(--mc-border)",
                    backgroundColor: "var(--mc-bg-secondary)",
                    color: "var(--mc-text)",
                  }}
                />
                <button
                  type="button"
                  onClick={saveNotes}
                  disabled={notesBusy}
                  className="mt-1.5 h-7 px-2 rounded-md text-[12px]"
                  style={{ backgroundColor: "var(--mc-bg-tertiary)", color: "var(--mc-text-secondary)" }}
                >
                  {notesBusy ? "Saving…" : "Save note"}
                </button>
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--mc-text-muted)" }}>
                  Timeline
                </div>
                {(detail.events || []).length === 0 ? (
                  <div className="text-[12px]" style={{ color: "var(--mc-text-faint)" }}>
                    No events yet
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {detail.events.map((ev) => (
                      <li key={ev.id} className="text-[12px]" style={{ color: "var(--mc-text-secondary)" }}>
                        <span className="font-medium">{ev.kind}</span>
                        <span className="ml-1" style={{ color: "var(--mc-text-faint)" }}>
                          {clock(ev.at)}
                        </span>
                        {ev.detail && <div style={{ color: "var(--mc-text-muted)" }}>{ev.detail}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--mc-text-muted)" }}>
                  Thread
                </div>
                {(detail.messages || []).length === 0 ? (
                  <div className="text-[12px]" style={{ color: "var(--mc-text-faint)" }}>
                    No messages on this card
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {detail.messages.map((m) => (
                      <li
                        key={m.id}
                        className="rounded-md px-2 py-1.5"
                        style={{ backgroundColor: "var(--mc-bg-tertiary)" }}
                      >
                        <div className="text-[12px] font-medium" style={{ color: "var(--mc-text)" }}>
                          {m.from_name || m.from} · {clock(m.received_at)}
                        </div>
                        <div className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
                          {m.preview || m.subject}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
