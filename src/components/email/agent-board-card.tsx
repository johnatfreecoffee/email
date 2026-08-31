"use client";

import { formatDate } from "./format";

export const JOB_STAGES = ["received", "working", "waiting", "done", "stuck"] as const;
export type AgentJobStage = (typeof JOB_STAGES)[number];

export interface AgentJob {
  id: string;
  session_id: number;
  agent_local: string;
  mailbox: string | null;
  base_subject: string;
  stage: AgentJobStage;
  email_thread_id: string | null;
  last_message_id: string | null;
  used_k: number;
  used_tokens: number;
  received_at: string;
  started_at: string | null;
  last_reply_at: string | null;
  done_at: string | null;
  stuck_at: string | null;
  updated_at: string;
  notes: string;
  remind_requested_at: string | null;
}

export interface AgentJobEvent {
  id: string;
  job_id: string;
  at: string;
  kind: string;
  detail: string | null;
}

export interface AgentJobMessage {
  id: string;
  from: string;
  from_name: string;
  subject: string;
  received_at: string;
  direction: string;
  preview: string;
}

const STAGE_LABEL: Record<AgentJobStage, string> = {
  received: "Received",
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  stuck: "Stuck",
};

const STAGE_STYLE: Record<AgentJobStage, { color: string; bg: string }> = {
  received: { color: "var(--mc-text-muted)", bg: "var(--mc-bg-tertiary)" },
  working: { color: "var(--mc-accent)", bg: "var(--mc-accent-bg)" },
  waiting: { color: "var(--mc-warning)", bg: "rgba(255, 149, 0, 0.14)" },
  done: { color: "var(--mc-success)", bg: "rgba(52, 199, 89, 0.14)" },
  stuck: { color: "var(--mc-danger)", bg: "rgba(255, 59, 48, 0.12)" },
};

export function stageLabel(stage: string): string {
  if (STAGE_LABEL[stage as AgentJobStage]) return STAGE_LABEL[stage as AgentJobStage];
  if (!stage) return "";
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

export function stageStyle(stage: string): { color: string; bg: string } {
  return STAGE_STYLE[stage as AgentJobStage] || STAGE_STYLE.received;
}

export function AgentBoardCard({
  job,
  selected,
  onSelect,
}: {
  job: AgentJob;
  selected: boolean;
  onSelect: () => void;
}) {
  const st = stageStyle(job.stage);
  const activity = job.last_reply_at || job.updated_at;
  const usedK = typeof job.used_k === "number" ? job.used_k : 1;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left rounded-[10px] px-3 py-2.5 transition-colors"
      style={{
        backgroundColor: selected ? "var(--mc-accent-bg)" : "var(--mc-card)",
        border: `1px solid ${selected ? "var(--mc-accent)" : "var(--mc-border)"}`,
        color: "var(--mc-text)",
      }}
    >
      <div className="text-[13px] font-semibold truncate leading-tight">
        {job.base_subject || "(no subject)"}
      </div>
      <div className="text-[11px] truncate mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
        {job.agent_local}
        {job.mailbox ? ` · ${job.mailbox}` : ""}
      </div>
      <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
        <span
          className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0"
          style={{ color: st.color, backgroundColor: st.bg }}
        >
          {stageLabel(job.stage)}
        </span>
        <span className="text-[11px] tabular-nums flex-shrink-0" style={{ color: "var(--mc-text-muted)" }}>
          {usedK}/500K
        </span>
        <span className="text-[11px] truncate ml-auto flex-shrink-0" style={{ color: "var(--mc-text-faint)" }}>
          {activity ? formatDate(activity) : ""}
        </span>
      </div>
    </button>
  );
}
