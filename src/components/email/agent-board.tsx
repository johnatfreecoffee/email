"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Columns3, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { isAgentAddress } from "@/lib/agent-mail";
import { formatDate } from "./format";
import {
  AgentBoardCard,
  JOB_STAGES,
  stageLabel,
  stageStyle,
  type AgentJob,
  type AgentJobEvent,
  type AgentJobMessage,
  type AgentJobStage,
} from "./agent-board-card";

const API = "/api/email/agent-jobs";
const STAGE_FILTERS: { id: "" | AgentJobStage; label: string }[] = [
  { id: "", label: "All" },
  { id: "received", label: "Received" },
  { id: "working", label: "Working" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
  { id: "stuck", label: "Stuck" },
];

function stamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = formatDate(value);
  return day.includes(":") ? time : `${day}, ${time}`;
}

function asJob(raw: unknown): AgentJob | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  const stage = JOB_STAGES.includes(r.stage as AgentJobStage) ? (r.stage as AgentJobStage) : "received";
  return {
    id: r.id,
    session_id: typeof r.session_id === "number" ? r.session_id : Number(r.session_id) || 0,
    agent_local: String(r.agent_local || ""),
    mailbox: typeof r.mailbox === "string" ? r.mailbox : null,
    base_subject: String(r.base_subject || "(no subject)"),
    stage,
    email_thread_id: typeof r.email_thread_id === "string" ? r.email_thread_id : null,
    last_message_id: typeof r.last_message_id === "string" ? r.last_message_id : null,
    used_k: typeof r.used_k === "number" ? r.used_k : 1,
    used_tokens: typeof r.used_tokens === "number" ? r.used_tokens : 0,
    received_at: String(r.received_at || ""),
    started_at: typeof r.started_at === "string" ? r.started_at : null,
    last_reply_at: typeof r.last_reply_at === "string" ? r.last_reply_at : null,
    done_at: typeof r.done_at === "string" ? r.done_at : null,
    stuck_at: typeof r.stuck_at === "string" ? r.stuck_at : null,
    updated_at: String(r.updated_at || r.received_at || ""),
    notes: typeof r.notes === "string" ? r.notes : "",
    remind_requested_at: typeof r.remind_requested_at === "string" ? r.remind_requested_at : null,
  };
}

function StateCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-[10px] p-3 text-[13px] text-center"
      style={{ backgroundColor: "var(--mc-bg-tertiary)", color: "var(--mc-text-muted)" }}
    >
      {children}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  children,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 min-w-[148px] flex-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider flex-shrink-0" style={{ color: "var(--mc-text-faint)" }}>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 h-7 rounded-md px-2 text-[13px] focus:outline-none"
        style={{
          backgroundColor: "var(--mc-bg-tertiary)",
          color: "var(--mc-text)",
          border: "1px solid var(--mc-border)",
        }}
      >
        {children}
      </select>
    </label>
  );
}

type BoardDomain = {
  domain: string;
  addresses?: Array<{
    address: string;
    display_name: string | null;
    is_active: boolean;
  }>;
};

export function AgentBoard({
  domains,
  selectedId,
  onSelect,
  onMobileMenuClick,
  inlineDetail,
}: {
  domains: BoardDomain[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMobileMenuClick: () => void;
  inlineDetail: boolean;
}) {
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [agent, setAgent] = useState("");
  const [stage, setStage] = useState<"" | AgentJobStage>("");

  const agentOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { local: string; label: string }[] = [];
    for (const d of domains) {
      for (const a of d.addresses || []) {
        if (!a.is_active || !isAgentAddress(a)) continue;
        const local = a.address.trim().toLowerCase();
        if (!local || seen.has(local)) continue;
        seen.add(local);
        out.push({ local, label: a.display_name || `${a.address}@${d.domain}` });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [domains]);

  useEffect(() => {
    let cancelled = false;
    const run = async (silent: boolean) => {
      try {
        const params = new URLSearchParams();
        if (agent) params.set("agent", agent);
        if (stage) params.set("stage", stage);
        const qs = params.toString();
        const res = await apiFetch(qs ? `${API}?${qs}` : API);
        if (cancelled) return;
        if (!res.ok) throw new Error("Couldn't load board");
        const body = await res.json();
        if (cancelled) return;
        const rows = Array.isArray(body?.jobs) ? body.jobs : [];
        setJobs(rows.map(asJob).filter((j: AgentJob | null): j is AgentJob => !!j));
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load board");
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };
    void run(false);
    const id = window.setInterval(() => void run(true), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [agent, stage]);

  const byStage = useMemo(() => {
    const map: Record<AgentJobStage, AgentJob[]> = {
      received: [],
      working: [],
      waiting: [],
      done: [],
      stuck: [],
    };
    for (const job of jobs) map[job.stage].push(job);
    return map;
  }, [jobs]);

  return (
    <div className="flex h-full min-w-0">
      <div className="flex flex-col h-full min-w-0 flex-1">
        <div className="p-3 flex-shrink-0" style={{ borderBottom: "1px solid var(--mc-border)" }}>
          <div className="flex items-center gap-2">
            <button
              onClick={onMobileMenuClick}
              className="md:hidden flex items-center gap-0.5 -ml-1 pr-1 rounded-lg transition-opacity active:opacity-60"
              style={{ color: "var(--mc-accent)" }}
              aria-label="Back to mailboxes"
            >
              <ChevronLeft className="h-6 w-6 -mr-1" />
              <span className="text-[15px] mc-touch-exempt">Mailboxes</span>
            </button>
            <div className="flex-1 flex flex-wrap gap-2 min-w-0">
              <FilterSelect value={agent} onChange={setAgent} label="Agent">
                <option value="">All agents</option>
                {agentOptions.map((a) => (
                  <option key={a.local} value={a.local}>
                    {a.label}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect value={stage} onChange={(v) => setStage(v as "" | AgentJobStage)} label="Stage">
                {STAGE_FILTERS.map((s) => (
                  <option key={s.id || "all"} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </FilterSelect>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {loading && jobs.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--mc-accent)" }} />
            </div>
          ) : error && jobs.length === 0 ? (
            <StateCard>{error}</StateCard>
          ) : jobs.length === 0 ? (
            <StateCard>No agent jobs yet</StateCard>
          ) : (
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
            >
              {JOB_STAGES.map((col) => (
                <div key={col} className="min-w-0 flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 px-1">
                    <span className="text-[11px] font-semibold" style={{ color: "var(--mc-text-faint)" }}>
                      {stageLabel(col)}
                    </span>
                    <span className="text-[11px] tabular-nums" style={{ color: "var(--mc-text-muted)" }}>
                      {byStage[col].length}
                    </span>
                  </div>
                  {byStage[col].length === 0 ? (
                    <StateCard>None</StateCard>
                  ) : (
                    byStage[col].map((job) => (
                      <AgentBoardCard
                        key={job.id}
                        job={job}
                        selected={selectedId === job.id}
                        onSelect={() => onSelect(job.id)}
                      />
                    ))
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {inlineDetail && (
        <div
          className="hidden md:flex w-[min(420px,42%)] flex-shrink-0 min-w-0 overflow-hidden"
          style={{ borderLeft: "1px solid var(--mc-border)", backgroundColor: "var(--mc-bg)" }}
        >
          <AgentBoardDetail jobId={selectedId} onBack={() => {}} hideBack />
        </div>
      )}
    </div>
  );
}

export function AgentBoardDetail({
  jobId,
  onBack,
  hideBack = false,
}: {
  jobId: string | null;
  onBack: () => void;
  hideBack?: boolean;
}) {
  const [job, setJob] = useState<AgentJob | null>(null);
  const [events, setEvents] = useState<AgentJobEvent[]>([]);
  const [messages, setMessages] = useState<AgentJobMessage[]>([]);
  const [error, setError] = useState("");
  const [reminding, setReminding] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const run = async (silent: boolean) => {
      try {
        const res = await apiFetch(`${API}?id=${encodeURIComponent(jobId)}`);
        if (cancelled) return;
        if (res.status === 404) throw new Error("Job not found");
        if (!res.ok) throw new Error("Couldn't load job");
        const body = await res.json();
        if (cancelled) return;
        const next = asJob(body?.job);
        if (!next) throw new Error("Job not found");
        setJob(next);
        setEvents(Array.isArray(body?.events) ? body.events : []);
        setMessages(Array.isArray(body?.messages) ? body.messages : []);
        setError("");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Couldn't load job");
        if (!silent) setJob(null);
      }
    };
    void run(false);
    const id = window.setInterval(() => void run(true), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [jobId]);

  const remind = async () => {
    if (!jobId || reminding) return;
    setReminding(true);
    try {
      const res = await apiFetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "remind", id: jobId }),
      });
      if (!res.ok) throw new Error("Couldn't remind");
      const body = await res.json();
      const next = asJob(body?.job);
      if (next) setJob(next);
      if (Array.isArray(body?.events)) setEvents(body.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remind");
    } finally {
      setReminding(false);
    }
  };

  if (!jobId) {
    return (
      <div className="flex items-center justify-center h-full w-full" style={{ color: "var(--mc-text-faint)" }}>
        <div className="text-center px-4">
          <Columns3 className="h-8 w-8 mx-auto mb-3 opacity-30" />
          <p className="text-[14px]">Select a card</p>
          <p className="text-[12px] mt-1" style={{ color: "var(--mc-text-faint)" }}>
            Open a job to see the thread
          </p>
        </div>
      </div>
    );
  }

  const live = job && job.id === jobId ? job : null;
  const canRemind = !!(live && (live.stage === "stuck" || live.stage === "waiting"));
  const st = live ? stageStyle(live.stage) : null;

  return (
    <div className="flex flex-col h-full w-full min-w-0">
      <div
        className="flex items-center gap-2 px-3 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--mc-border)" }}
      >
        {!hideBack && (
          <button
            onClick={onBack}
            className="md:hidden flex items-center gap-0.5 pr-2 py-2 -ml-1 rounded-lg transition-all active:opacity-60"
            style={{ color: "var(--mc-accent)" }}
          >
            <ChevronLeft className="h-6 w-6 -mr-1" />
            <span className="text-[16px]">Board</span>
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold truncate" style={{ color: "var(--mc-text)" }}>
            {live ? live.base_subject : "Loading…"}
          </div>
          {live && (
            <div className="text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>
              {live.agent_local}
              {typeof live.session_id === "number" ? ` · ID ${live.session_id}` : ""}
            </div>
          )}
        </div>
        {canRemind && live && (
          <button
            type="button"
            onClick={() => void remind()}
            disabled={reminding || !!live.remind_requested_at}
            className="flex-shrink-0 px-3 py-1.5 rounded-lg text-[13px] font-semibold disabled:opacity-55"
            style={{ backgroundColor: "var(--mc-accent)", color: "#fff" }}
          >
            {reminding ? "…" : live.remind_requested_at ? "Reminded" : "Remind"}
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {!live && !error ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--mc-accent)" }} />
          </div>
        ) : error && !live ? (
          <StateCard>{error}</StateCard>
        ) : live ? (
          <>
            {error && <StateCard>{error}</StateCard>}
            <div className="rounded-[10px] p-3" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
              <div className="flex items-center gap-2 mb-2">
                {st && (
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                    style={{ color: st.color, backgroundColor: st.bg }}
                  >
                    {stageLabel(live.stage)}
                  </span>
                )}
                <span className="text-[11px] tabular-nums" style={{ color: "var(--mc-text-muted)" }}>
                  {live.used_k}/500K
                </span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                <dt style={{ color: "var(--mc-text-faint)" }}>Received</dt>
                <dd style={{ color: "var(--mc-text)" }}>{stamp(live.received_at)}</dd>
                <dt style={{ color: "var(--mc-text-faint)" }}>Started</dt>
                <dd style={{ color: "var(--mc-text)" }}>{stamp(live.started_at)}</dd>
                <dt style={{ color: "var(--mc-text-faint)" }}>Last reply</dt>
                <dd style={{ color: "var(--mc-text)" }}>{stamp(live.last_reply_at)}</dd>
              </dl>
            </div>

            <section>
              <h3 className="text-[11px] font-semibold px-1 pb-1.5" style={{ color: "var(--mc-text-faint)" }}>
                Status
              </h3>
              <div className="rounded-[10px] overflow-hidden" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
                {events.length === 0 ? (
                  <div className="px-3 py-2.5 text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
                    No status changes yet
                  </div>
                ) : (
                  events.map((ev, i) => (
                    <div
                      key={ev.id || `${ev.kind}-${ev.at}`}
                      className="flex items-start gap-2 px-3 py-2 min-h-[40px]"
                      style={{ borderBottom: i === events.length - 1 ? "none" : "1px solid var(--mc-border-subtle)" }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px]" style={{ color: "var(--mc-text)" }}>
                          {stageLabel(ev.kind)}
                          {ev.detail ? ` — ${ev.detail}` : ""}
                        </div>
                        <div className="text-[11px]" style={{ color: "var(--mc-text-muted)" }}>
                          {stamp(ev.at)}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section>
              <h3 className="text-[11px] font-semibold px-1 pb-1.5" style={{ color: "var(--mc-text-faint)" }}>
                Notes
              </h3>
              <div className="rounded-[10px] p-3 text-[13px] whitespace-pre-wrap break-words" style={{ backgroundColor: "var(--mc-bg-tertiary)", color: live.notes ? "var(--mc-text)" : "var(--mc-text-muted)" }}>
                {live.notes.trim() || "No notes"}
              </div>
            </section>

            <section>
              <h3 className="text-[11px] font-semibold px-1 pb-1.5" style={{ color: "var(--mc-text-faint)" }}>
                Thread
              </h3>
              <div className="rounded-[10px] overflow-hidden" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
                {messages.length === 0 ? (
                  <div className="px-3 py-2.5 text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
                    No messages
                  </div>
                ) : (
                  messages.map((m, i) => (
                    <div
                      key={m.id}
                      className="px-3 py-2.5 min-w-0"
                      style={{ borderBottom: i === messages.length - 1 ? "none" : "1px solid var(--mc-border-subtle)" }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold truncate" style={{ color: "var(--mc-text)" }}>
                          {m.from_name || m.from || (m.direction === "outbound" ? "Agent" : "Sender")}
                        </span>
                        <span className="text-[11px] flex-shrink-0 ml-auto" style={{ color: "var(--mc-text-faint)" }}>
                          {m.received_at ? formatDate(m.received_at) : ""}
                        </span>
                      </div>
                      {m.subject && (
                        <div className="text-[12px] truncate" style={{ color: "var(--mc-text-secondary)" }}>
                          {m.subject}
                        </div>
                      )}
                      {m.preview && (
                        <p className="text-[12px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
                          {m.preview}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
