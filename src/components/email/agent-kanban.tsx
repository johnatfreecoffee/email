"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Columns3, Loader2, Paperclip, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { AttachmentChips, type MailAttachment } from "./attachment-chips";

type Stage = "received" | "working" | "waiting" | "done" | "stuck";

const STAGES: { id: Stage; label: string }[] = [
  { id: "received", label: "Received" },
  { id: "working", label: "Working" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
  { id: "stuck", label: "Stuck" },
];

const STAGE_TONE: Record<Stage, { fg: string; bg: string; bar: string }> = {
  received: { fg: "var(--mc-accent)", bg: "var(--mc-accent-bg)", bar: "var(--mc-accent)" },
  working: { fg: "var(--mc-warning)", bg: "var(--mc-warning-bg)", bar: "var(--mc-warning)" },
  waiting: { fg: "var(--mc-info)", bg: "var(--mc-info-bg)", bar: "var(--mc-info)" },
  done: { fg: "var(--mc-success)", bg: "var(--mc-success-bg)", bar: "var(--mc-success)" },
  stuck: { fg: "var(--mc-danger)", bg: "var(--mc-danger-bg)", bar: "var(--mc-danger)" },
};

const KIND_LABEL: Record<string, string> = {
  received: "Received",
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  stuck: "Stuck",
  reply: "Reply",
  note: "Note",
  remind: "Remind",
};

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
  body?: string;
  body_html?: string;
  attachments?: MailAttachment[];
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

function usedTag(job: AgentJob): string {
  const k = Number(job.used_k);
  const n = Number.isFinite(k) && k > 0 ? Math.round(k) : 0;
  return `${n}/500K`;
}

function StageDot({ stage }: { stage: Stage }) {
  return (
    <span
      className="h-1.5 w-1.5 rounded-full flex-shrink-0"
      style={{ backgroundColor: STAGE_TONE[stage].bar }}
      aria-hidden
    />
  );
}

function StageChip({ stage }: { stage: Stage }) {
  const tone = STAGE_TONE[stage];
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold"
      style={{ color: tone.fg, backgroundColor: tone.bg }}
    >
      <StageDot stage={stage} />
      {KIND_LABEL[stage] || stage}
    </span>
  );
}

function JobCard({
  job,
  selected,
  last,
  onClick,
}: {
  job: AgentJob;
  selected: boolean;
  last: boolean;
  onClick: () => void;
}) {
  const tone = STAGE_TONE[job.stage] || STAGE_TONE.received;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full min-w-0 text-left px-3 py-2.5 min-h-[44px] md:min-h-0 md:py-2"
      style={{
        borderBottom: last ? "none" : "1px solid var(--mc-border-subtle)",
        backgroundColor: selected ? "var(--mc-accent-bg)" : "transparent",
        borderLeft: `3px solid ${tone.bar}`,
      }}
    >
      <div className="text-[13px] truncate" style={{ color: "var(--mc-text)" }}>
        {job.base_subject || "(no subject)"}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] min-w-0" style={{ color: "var(--mc-text-muted)" }}>
        <span className="truncate">{agentLabel(job.agent_local)}</span>
        <span className="tabular-nums flex-shrink-0">{usedTag(job)}</span>
      </div>
      <div className="text-[11px] truncate" style={{ color: "var(--mc-text-faint)" }}>
        {relTime(job.last_reply_at || job.updated_at)}
      </div>
    </button>
  );
}

function ThreadMail({
  message,
  expanded,
  onToggle,
}: {
  message: JobMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const files = Array.isArray(message.attachments) ? message.attachments : [];
  const body = (message.body || message.preview || "").trim();
  const html = (message.body_html || "").trim();
  return (
    <div className="rounded-[10px] min-w-0 overflow-hidden" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-3 py-2.5 min-w-0"
      >
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <div className="text-[13px] font-medium truncate" style={{ color: "var(--mc-text)" }}>
            {message.from_name || message.from || (message.direction === "outbound" ? "Agent" : "Unknown")}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {files.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[11px]" style={{ color: "var(--mc-text-faint)" }}>
                <Paperclip className="h-3 w-3" />
                {files.length}
              </span>
            )}
            <span className="text-[11px]" style={{ color: "var(--mc-text-faint)" }}>
              {clock(message.received_at)}
            </span>
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" style={{ color: "var(--mc-text-faint)" }} />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" style={{ color: "var(--mc-text-faint)" }} />
            )}
          </div>
        </div>
        {!expanded && (
          <div className="text-[12px] mt-0.5 truncate" style={{ color: "var(--mc-text-muted)" }}>
            {message.preview || message.subject || "(no preview)"}
          </div>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {html ? (
            <iframe
              srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>:root{color-scheme:light}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.55;color:#1a1a1a!important;background:#fff!important;margin:0;padding:8px;word-wrap:break-word}a{color:#007AFF!important}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`}
              sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              className="w-full min-h-[120px] rounded-md"
              title={message.subject || "Email"}
              style={{ background: "#fff", border: "1px solid var(--mc-border-subtle)" }}
              onLoad={(e) => {
                const iframe = e.target as HTMLIFrameElement;
                const doc = iframe.contentDocument;
                if (!doc) return;
                iframe.style.height = Math.min((doc.body?.scrollHeight || 120) + 16, 720) + "px";
              }}
            />
          ) : (
            <pre
              className="text-[13px] whitespace-pre-wrap font-sans leading-relaxed"
              style={{ color: "var(--mc-text)" }}
            >
              {body || "(no content)"}
            </pre>
          )}
          <AttachmentChips attachments={files} />
        </div>
      )}
    </div>
  );
}

function ThreadSection({ messages }: { messages: JobMessage[] }) {
  const ids = useMemo(() => messages.map((m) => m.id), [messages]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(ids));
  const allOpen = ids.length > 0 && ids.every((id) => open.has(id));

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-3 pb-1.5">
        <div className="text-[11px] font-semibold" style={{ color: "var(--mc-text-faint)" }}>
          Thread
        </div>
        {messages.length > 1 && (
          <button
            type="button"
            onClick={() => setOpen(allOpen ? new Set() : new Set(ids))}
            className="text-[11px]"
            style={{ color: "var(--mc-accent)" }}
          >
            {allOpen ? "Collapse" : "Read all"}
          </button>
        )}
      </div>
      {messages.length === 0 ? (
        <div
          className="rounded-[10px] px-3 py-2.5 text-[13px]"
          style={{ backgroundColor: "var(--mc-bg-tertiary)", color: "var(--mc-text-muted)" }}
        >
          No messages on this card
        </div>
      ) : (
        <div className="space-y-2">
          {messages.map((m) => (
            <ThreadMail
              key={m.id}
              message={m}
              expanded={open.has(m.id)}
              onToggle={() => toggle(m.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentKanban({
  onMobileMenuClick,
  agents: agentCatalog = [],
}: {
  onMobileMenuClick?: () => void;
  agents?: { local: string; label: string }[];
}) {
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
  const [detailError, setDetailError] = useState<string | null>(null);
  const [remindBusy, setRemindBusy] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const agentDropRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError(null);
    const params = new URLSearchParams();
    if (agent) params.set("agent", agent);
    const qs = params.toString();
    const res = await apiFetch(`/api/email/agent-jobs${qs ? `?${qs}` : ""}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (!silent) {
        setError(typeof data.error === "string" ? data.error : "Couldn't load the board");
        setJobs([]);
      }
      return;
    }
    if (data.needs_migration) {
      setError("Couldn't load the board");
      setJobs([]);
      return;
    }
    setError(null);
    setJobs(Array.isArray(data.jobs) ? data.jobs : []);
  }, [agent]);

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
    const t = setInterval(() => {
      load(true).catch(() => {});
    }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const loadDetail = useCallback(async (id: string, silent = false) => {
    if (!silent) {
      setDetailLoading(true);
      setDetailError(null);
    }
    try {
      const res = await apiFetch(`/api/email/agent-jobs?id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.job) {
        if (!silent) {
          setDetail(null);
          setDetailError(typeof data.error === "string" ? data.error : "Couldn't load this card");
        }
        return;
      }
      setDetailError(null);
      setDetail({
        job: data.job,
        events: Array.isArray(data.events) ? data.events : [],
        messages: Array.isArray(data.messages) ? data.messages : [],
      });
    } catch {
      if (!silent) {
        setDetail(null);
        setDetailError("Couldn't load this card");
      }
    } finally {
      if (!silent) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    loadDetail(selectedId).catch(() => {
      if (!cancelled) setDetailError("Couldn't load this card");
    });
    const t = setInterval(() => {
      loadDetail(selectedId, true).catch(() => {});
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (!agentOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.("[data-mc-kanban-agent-dropdown]")) setAgentOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [agentOpen]);

  const agents = useMemo(() => {
    const seen = new Set<string>();
    const out: { local: string; label: string }[] = [];
    for (const a of agentCatalog) {
      if (!a.local || seen.has(a.local)) continue;
      seen.add(a.local);
      out.push(a);
    }
    for (const j of jobs) {
      if (!j.agent_local || seen.has(j.agent_local)) continue;
      seen.add(j.agent_local);
      out.push({ local: j.agent_local, label: agentLabel(j.agent_local) });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [agentCatalog, jobs]);

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

  const visibleStages = useMemo(
    () => STAGES.filter((col) => !stage || stage === col.id),
    [stage],
  );

  const visibleCount = useMemo(
    () => visibleStages.reduce((n, col) => n + byStage[col.id].length, 0),
    [visibleStages, byStage],
  );

  async function refresh() {
    setRefreshing(true);
    try {
      await load();
      if (selectedId) await loadDetail(selectedId, true);
    } finally {
      setRefreshing(false);
    }
  }

  async function remind() {
    if (!selectedId) return;
    setRemindBusy(true);
    try {
      await apiFetch(`/api/email/agent-jobs?id=${encodeURIComponent(selectedId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "remind", id: selectedId }),
      });
      await Promise.all([load(true), loadDetail(selectedId, true)]);
    } finally {
      setRemindBusy(false);
    }
  }

  const selected = detail?.job;
  const canRemind = selected && (selected.stage === "stuck" || selected.stage === "waiting");
  const showBoard = !selectedId;
  const showFive = showBoard && !stage;
  const agentCurrent = agents.find((a) => a.local === agent);

  function renderGroups(opts: { five: boolean }) {
    const cols = visibleStages;
    if (opts.five) {
      return (
        <div className="hidden md:grid flex-1 min-h-0 grid-cols-5 gap-2 p-2">
          {cols.map((col) => (
            <div
              key={col.id}
              className="min-h-0 min-w-0 flex flex-col rounded-[10px] overflow-hidden"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                boxShadow: `inset 0 3px 0 ${STAGE_TONE[col.id].bar}`,
              }}
            >
              <div
                className="flex-shrink-0 px-3 py-1.5 text-[11px] font-semibold truncate flex items-center gap-1.5"
                style={{ color: STAGE_TONE[col.id].fg }}
              >
                <StageDot stage={col.id} />
                {col.label}
                <span className="ml-0.5 tabular-nums opacity-80">{byStage[col.id].length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {byStage[col.id].map((job, i, arr) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    selected={selectedId === job.id}
                    last={i === arr.length - 1}
                    onClick={() => setSelectedId(job.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="p-3 space-y-4 overflow-y-auto h-full">
        {cols.filter((col) => byStage[col.id].length > 0).map((col) => (
          <div key={col.id}>
            <div
              className="text-[11px] font-semibold px-3 pb-1.5 flex items-center gap-1.5"
              style={{ color: STAGE_TONE[col.id].fg }}
            >
              <StageDot stage={col.id} />
              {col.label}
              <span className="ml-0.5 tabular-nums opacity-80">{byStage[col.id].length}</span>
            </div>
            <div
              className="rounded-[10px] overflow-hidden"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                boxShadow: `inset 3px 0 0 ${STAGE_TONE[col.id].bar}`,
              }}
            >
              {byStage[col.id].map((job, i, arr) => (
                <JobCard
                  key={job.id}
                  job={job}
                  selected={selectedId === job.id}
                  last={i === arr.length - 1}
                  onClick={() => setSelectedId(job.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const boardBody = loading ? (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 text-mc-teal animate-spin" />
    </div>
  ) : jobs.length === 0 ? (
    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
      <Columns3 className="h-6 w-6 mb-2 opacity-40" />
      <p className="text-[13px]">No agent jobs yet</p>
      <p className="text-[11px] mt-1" style={{ color: "var(--mc-text-faint)" }}>
        Mail an agent and the card shows up here.
      </p>
    </div>
  ) : visibleCount === 0 ? (
    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
      <Columns3 className="h-6 w-6 mb-2 opacity-40" />
      <p className="text-[13px]">No {stage} jobs</p>
      <button
        type="button"
        onClick={() => setStage("")}
        className="text-[11px] text-mc-teal hover:underline mt-1"
      >
        Show all
      </button>
    </div>
  ) : (
    <>
      <div className={showFive ? "md:hidden flex-1 min-h-0 overflow-hidden" : "flex-1 min-h-0 overflow-hidden"}>
        {renderGroups({ five: false })}
      </div>
      {showFive && renderGroups({ five: true })}
    </>
  );

  const detailBody = !selectedId ? null : detailLoading && !selected ? (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 text-mc-teal animate-spin" />
    </div>
  ) : detailError || !selected ? (
    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground px-6 text-center">
      <p className="text-[13px]">{detailError || "Couldn't load this card"}</p>
      <button
        type="button"
        onClick={() => selectedId && loadDetail(selectedId)}
        className="text-[11px] text-mc-teal hover:underline mt-1"
      >
        Try again
      </button>
    </div>
  ) : (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="min-w-0">
        <div className="text-[16px] font-semibold truncate" style={{ color: "var(--mc-text)" }}>
          {selected.base_subject || "(no subject)"}
        </div>
        <div className="text-[12px] mt-1 flex items-center gap-2 flex-wrap" style={{ color: "var(--mc-text-muted)" }}>
          <span className="truncate">{agentLabel(selected.agent_local)}</span>
          <StageChip stage={selected.stage} />
          <span className="tabular-nums">{usedTag(selected)}</span>
        </div>
      </div>
      <div className="rounded-[10px] overflow-hidden" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
        {[
          ["Received", selected.received_at],
          ["Started", selected.started_at],
          ["Last reply", selected.last_reply_at],
          selected.done_at ? ["Done", selected.done_at] : null,
          selected.stuck_at ? ["Stuck", selected.stuck_at] : null,
        ]
          .filter((row): row is [string, string | null] => !!row)
          .map(([label, at], i, arr) => (
            <div
              key={label}
              className="flex items-center justify-between gap-3 px-3 py-2.5 min-h-[40px]"
              style={{ borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--mc-border-subtle)" }}
            >
              <div className="text-[13px]" style={{ color: "var(--mc-text)" }}>{label}</div>
              <div className="text-[13px] flex-shrink-0" style={{ color: "var(--mc-text-muted)" }}>{clock(at)}</div>
            </div>
          ))}
      </div>
      <div>
        <div className="text-[11px] font-semibold px-3 pb-1.5" style={{ color: "var(--mc-text-faint)" }}>
          Notes
        </div>
        <div className="rounded-[10px] p-3 min-w-0" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
          {selected.notes ? (
            <div className="text-[13px] leading-5 whitespace-pre-wrap break-words" style={{ color: "var(--mc-text)" }}>
              {selected.notes}
            </div>
          ) : (
            <div className="text-[13px]" style={{ color: "var(--mc-text-muted)" }}>No notes</div>
          )}
        </div>
      </div>
      <div>
        <div className="text-[11px] font-semibold px-3 pb-1.5" style={{ color: "var(--mc-text-faint)" }}>
          Timeline
        </div>
        <div className="rounded-[10px] overflow-hidden" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
          {(detail.events || []).length === 0 ? (
            <div className="px-3 py-2.5 text-[13px]" style={{ color: "var(--mc-text-muted)" }}>
              No events yet
            </div>
          ) : (
            detail.events.map((ev, i, arr) => (
              <div
                key={ev.id}
                className="px-3 py-2.5 min-w-0"
                style={{ borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--mc-border-subtle)" }}
              >
                <div className="flex items-baseline justify-between gap-2 min-w-0">
                  <span className="text-[13px] truncate" style={{ color: "var(--mc-text)" }}>
                    {KIND_LABEL[ev.kind] || ev.kind}
                  </span>
                  <span className="text-[11px] flex-shrink-0" style={{ color: "var(--mc-text-faint)" }}>
                    {clock(ev.at)}
                  </span>
                </div>
                {ev.detail && (
                  <div className="text-[12px] mt-0.5 break-words" style={{ color: "var(--mc-text-muted)" }}>
                    {ev.detail}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
      <ThreadSection
        key={(detail.messages || []).map((m) => m.id).join("|") || "empty"}
        messages={detail.messages || []}
      />
    </div>
  );

  return (
    <div className="h-full min-h-0 min-w-0 flex overflow-hidden" style={{ backgroundColor: "var(--mc-bg-secondary)" }}>
      <div
        className={`min-h-0 min-w-0 flex flex-col overflow-hidden ${
          selectedId ? "hidden md:flex md:w-[380px] md:flex-shrink-0" : "flex flex-1"
        }`}
        style={selectedId ? { borderRight: "1px solid var(--mc-border)" } : undefined}
      >
        <div className="p-3 flex-shrink-0" style={{ borderBottom: "1px solid var(--mc-border)" }}>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onMobileMenuClick?.()}
              className="md:hidden flex items-center gap-0.5 -ml-1 pr-1 rounded-lg transition-opacity active:opacity-60"
              style={{ color: "var(--mc-accent)" }}
              aria-label="Back to mailboxes"
            >
              <ChevronLeft className="h-6 w-6 -mr-1" />
              <span className="text-[15px] mc-touch-exempt">Mailboxes</span>
            </button>
            {agents.length > 0 ? (
              <div className="flex-1 min-w-0 relative" data-mc-kanban-agent-dropdown ref={agentDropRef}>
                  <button
                    type="button"
                    onClick={() => setAgentOpen((v) => !v)}
                    className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[11px] transition-colors"
                    style={{
                      color: agent ? "var(--mc-accent)" : "var(--mc-text-muted)",
                      backgroundColor: agent ? "var(--mc-accent-bg)" : "var(--mc-bg-hover, rgba(255,255,255,0.04))",
                      border: "1px solid var(--mc-border)",
                    }}
                    title="Filter by agent mailbox"
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--mc-text-faint)" }}>
                        Agent:
                      </span>
                      <span className="truncate">{agentCurrent ? agentCurrent.label : "All agents"}</span>
                    </span>
                    <ChevronDown className="h-3 w-3 flex-shrink-0" style={{ color: "var(--mc-text-faint)" }} />
                  </button>
                  {agentOpen && (
                    <div
                      className="absolute left-0 right-0 top-full mt-1 rounded-lg shadow-xl z-30 py-1 max-h-[240px] overflow-y-auto"
                      style={{ backgroundColor: "var(--mc-bg)", border: "1px solid var(--mc-border)" }}
                    >
                      <button
                        type="button"
                        onClick={() => { setAgent(""); setAgentOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-[11px] transition-colors"
                        style={{
                          color: !agent ? "var(--mc-accent)" : "var(--mc-text-muted)",
                          backgroundColor: !agent ? "var(--mc-accent-bg)" : "transparent",
                        }}
                      >
                        All agents
                      </button>
                      {agents.map((a) => {
                        const on = a.local === agent;
                        return (
                          <button
                            key={a.local}
                            type="button"
                            onClick={() => { setAgent(on ? "" : a.local); setAgentOpen(false); }}
                            className="w-full text-left px-3 py-1.5 text-[11px] transition-colors truncate"
                            style={{
                              color: on ? "var(--mc-accent)" : "var(--mc-text-muted)",
                              backgroundColor: on ? "var(--mc-accent-bg)" : "transparent",
                            }}
                          >
                            {a.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
              </div>
            ) : (
              <div className="flex-1 min-w-0" />
            )}
            <button
              type="button"
              onClick={() => void refresh()}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: "var(--mc-text-muted)" }}
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <div
          className="flex flex-wrap items-center gap-1.5 px-3 py-2 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--mc-border, rgba(255,255,255,0.06))" }}
        >
          <button
            type="button"
            onClick={() => setStage("")}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all"
            style={
              !stage
                ? { backgroundColor: "var(--mc-accent-bg)", color: "var(--mc-accent)" }
                : { color: "var(--mc-text-muted)" }
            }
          >
            All
            {jobs.length > 0 && (
              <span className="text-[10px] font-semibold tabular-nums opacity-70">{jobs.length}</span>
            )}
          </button>
          {STAGES.map((s) => {
            const count = byStage[s.id].length;
            const on = stage === s.id;
            const tone = STAGE_TONE[s.id];
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setStage(on ? "" : s.id)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-all"
                style={
                  on
                    ? { backgroundColor: tone.bg, color: tone.fg }
                    : { color: "var(--mc-text-muted)" }
                }
              >
                <StageDot stage={s.id} />
                {s.label}
                {count > 0 && (
                  <span className="text-[10px] font-semibold tabular-nums opacity-70">{count}</span>
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mx-3 mt-2 flex-shrink-0 rounded-[10px] p-3" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
            <div className="text-[13px] font-medium" style={{ color: "var(--mc-text)" }}>{error}</div>
            <button
              type="button"
              onClick={() => void load()}
              className="text-[11px] text-mc-teal hover:underline mt-1"
            >
              Try again
            </button>
          </div>
        )}

        <div className="relative flex-1 min-h-0 overflow-hidden flex flex-col">
          {boardBody}
        </div>
      </div>

      {selectedId && (
        <div
          className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden"
          style={{ backgroundColor: "var(--mc-bg)" }}
        >
          <div
            className={`flex items-center gap-0.5 px-3 py-2 flex-shrink-0 ${canRemind ? "" : "md:hidden"}`}
            style={{ borderBottom: "1px solid var(--mc-border)" }}
          >
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="md:hidden flex items-center gap-0.5 pr-2 py-2 -ml-1 rounded-lg transition-all active:opacity-60"
              style={{ color: "var(--mc-accent)" }}
            >
              <ChevronLeft className="h-6 w-6 -mr-1" />
              <span className="text-[16px] max-w-[9rem] truncate">Kanban</span>
            </button>
            <div className="flex-1" />
            {canRemind && (
              <button
                type="button"
                onClick={() => void remind()}
                disabled={remindBusy || !!selected?.remind_requested_at}
                className="h-8 px-2 rounded-md text-[13px] font-medium"
                style={{
                  color: "var(--mc-accent)",
                  backgroundColor: "var(--mc-accent-bg)",
                  opacity: remindBusy || selected?.remind_requested_at ? 0.6 : 1,
                }}
              >
                {selected?.remind_requested_at ? "Remind queued" : remindBusy ? "Reminding…" : "Remind"}
              </button>
            )}
          </div>
          {detailBody}
        </div>
      )}
    </div>
  );
}
