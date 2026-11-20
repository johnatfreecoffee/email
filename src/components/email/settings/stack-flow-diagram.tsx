"use client";

import {
  Globe,
  Cloud,
  Mail,
  Database,
  Server,
  Laptop,
  KeyRound,
  Sparkles,
  ArrowRight,
  ArrowDown,
  ArrowLeftRight,
  CheckCircle2,
  CircleDashed,
  Bot,
  CreditCard,
} from "lucide-react";

export interface StackTile {
  id: string;
  ok: boolean;
  configured: boolean;
  detail: string;
}

export interface AgentRuntimeInfo {
  hands: "auto" | "local" | "box" | "api";
  worker_seen_at: string | null;
  box_seen_at: string | null;
  online: boolean;
  box_online: boolean;
  needs_migration?: boolean;
}

export type SetupPanelTarget =
  | "hub"
  | "database"
  | "mail"
  | "cloudflare"
  | "domain"
  | "signin"
  | "hands"
  | "extras"
  | "deploy";

function tile(tiles: StackTile[], id: string): StackTile | undefined {
  return tiles.find((t) => t.id === id);
}

export function formatRelativeSeen(iso: string | null | undefined): string {
  if (!iso) return "Never connected";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "Just now";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function describeActiveAgentEngine({
  runtime,
  xaiConfigured,
}: {
  runtime: AgentRuntimeInfo | null;
  xaiConfigured: boolean;
}): {
  mode: "subscription" | "api" | "hybrid" | "none";
  label: string;
  summary: string;
  subActive: boolean;
  apiActive: boolean;
} {
  const macOnline = !!runtime?.online;
  const boxOnline = !!runtime?.box_online;
  const subOnline = macOnline || boxOnline;
  const subPlace = macOnline && boxOnline ? "This Mac + Cloud Box" : macOnline ? "This Mac" : boxOnline ? "Cloud Box" : null;
  const hands = runtime?.hands || "auto";

  if (hands === "api") {
    if (xaiConfigured) {
      return {
        mode: "api",
        label: "API Key Active (xAI Cloud Q&A)",
        summary: "Forced to API Key mode — Cloudflare answers a.* questions directly via xAI.",
        subActive: false,
        apiActive: true,
      };
    }
    return {
      mode: "none",
      label: "API Key Selected (Key Missing)",
      summary: "Routing is set to API Key, but no xAI API key is connected yet.",
      subActive: false,
      apiActive: false,
    };
  }

  if (hands === "local" || hands === "box") {
    const targetOnline = hands === "local" ? macOnline : boxOnline;
    const targetName = hands === "local" ? "This Mac" : "Cloud Box";
    if (targetOnline) {
      return {
        mode: "subscription",
        label: `Subscription Active (${targetName})`,
        summary: `Using your Grok subscription via the ${targetName} CLI worker — full coding tools & repo edits.`,
        subActive: true,
        apiActive: false,
      };
    }
    return {
      mode: "none",
      label: `Subscription Offline (${targetName})`,
      summary: `Locked to ${targetName} worker (Grok subscription), currently offline. Start the worker or switch to Auto.`,
      subActive: false,
      apiActive: false,
    };
  }

  // Auto mode (default): Subscription primary when online, API Key fallback when Mac sleeps
  if (subOnline && xaiConfigured) {
    return {
      mode: "hybrid",
      label: `Subscription Active (${subPlace}) + API Fallback`,
      summary: `Your Grok subscription on ${subPlace} handles live jobs; xAI API Key answers Q&A automatically when offline.`,
      subActive: true,
      apiActive: true,
    };
  }
  if (subOnline) {
    return {
      mode: "subscription",
      label: `Subscription Active (${subPlace})`,
      summary: `Using your Grok subscription via the ${subPlace} CLI worker — zero per-token API charges.`,
      subActive: true,
      apiActive: false,
    };
  }
  if (xaiConfigured) {
    return {
      mode: "api",
      label: "API Key Active (xAI Cloud Q&A)",
      summary: "No subscription worker online right now — xAI API Key is handling Q&A replies from Cloudflare.",
      subActive: false,
      apiActive: true,
    };
  }
  return {
    mode: "none",
    label: "No Agent Connected",
    summary: "Connect your Grok subscription (Mac / Cloud Box worker) or an xAI API key to activate a.*@ agent mail.",
    subActive: false,
    apiActive: false,
  };
}

function StatusDot({ ok, optional }: { ok: boolean; optional?: boolean }) {
  return (
    <span
      className="h-2 w-2 rounded-full flex-shrink-0"
      style={{
        backgroundColor: ok
          ? "var(--mc-success)"
          : optional
            ? "var(--mc-warning, #FF9500)"
            : "var(--mc-text-faint)",
      }}
    />
  );
}

function FlowArrowRight({ label }: { label: string }) {
  return (
    <div className="flex flex-row sm:flex-col items-center justify-center gap-1 py-1 sm:py-0 px-0.5 flex-shrink-0">
      <ArrowDown className="h-3.5 w-3.5 sm:hidden" style={{ color: "var(--mc-text-muted)" }} />
      <ArrowRight className="h-3.5 w-3.5 hidden sm:block" style={{ color: "var(--mc-text-muted)" }} />
      <span
        className="text-[9.5px] font-medium leading-tight text-center max-w-[74px]"
        style={{ color: "var(--mc-text-faint)" }}
      >
        {label}
      </span>
    </div>
  );
}

export function StackFlowDiagram({
  tiles,
  runtime,
  domainCount,
  xaiSource,
  onSelectPanel,
}: {
  tiles: StackTile[];
  runtime: AgentRuntimeInfo | null;
  domainCount: number;
  xaiSource?: "ui" | "env" | "none";
  onSelectPanel: (panel: SetupPanelTarget) => void;
}) {
  const cf = tile(tiles, "cloudflare");
  const dom = tile(tiles, "domain");
  const resend = tile(tiles, "resend");
  const inbound = tile(tiles, "inbound");
  const supa = tile(tiles, "supabase");
  const mig = tile(tiles, "migrations");
  const chat = tile(tiles, "chat");

  const dnsOk = !!dom?.ok;
  const resendOk = !!resend?.ok && !!inbound?.ok;
  const dbOk = !!supa?.ok && !!mig?.ok;
  const xaiConfigured = !!chat?.ok || (xaiSource !== undefined && xaiSource !== "none");

  const engine = describeActiveAgentEngine({ runtime, xaiConfigured });
  const subOnline = !!(runtime?.online || runtime?.box_online);
  const lastSeenText = runtime?.online
    ? "Online now (This Mac)"
    : runtime?.box_online
      ? "Online now (Cloud Box)"
      : runtime?.worker_seen_at
        ? `Offline · seen ${formatRelativeSeen(runtime.worker_seen_at)}`
        : runtime?.box_seen_at
          ? `Offline · seen ${formatRelativeSeen(runtime.box_seen_at)}`
          : "Not installed yet";

  return (
    <div
      className="rounded-[12px] p-4 space-y-3.5"
      style={{
        backgroundColor: "var(--mc-bg-tertiary)",
        border: "1px solid var(--mc-border-subtle)",
      }}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13.5px] font-semibold tracking-[-0.015em]" style={{ color: "var(--mc-text)" }}>
            Live Stack Map — How Everything Connects
          </div>
          <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
            Click any box to configure it. Arrows show how mail &amp; AI agents flow end-to-end.
          </div>
        </div>
        <div className="flex items-center gap-2.5 text-[10.5px]" style={{ color: "var(--mc-text-muted)" }}>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "var(--mc-success)" }} /> Live
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "var(--mc-accent)" }} /> Active Agent
          </span>
        </div>
      </div>

      {/* ROW 1: CORE MAIL FLOW */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5">
        {/* Node 1: Domain + Cloudflare */}
        <button
          type="button"
          onClick={() => onSelectPanel(cf?.ok ? "domain" : "cloudflare")}
          className="flex-1 min-w-0 text-left rounded-[10px] p-2.5 transition-all"
          style={{
            backgroundColor: "var(--mc-bg-elevated)",
            border: `1px solid ${dnsOk ? "rgba(52, 199, 89, 0.35)" : "var(--mc-border-subtle)"}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--mc-accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = dnsOk
              ? "rgba(52, 199, 89, 0.35)"
              : "var(--mc-border-subtle)";
          }}
        >
          <div className="flex items-center justify-between gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--mc-text)" }}>
              <Cloud className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#FF9500" }} />
              <span className="truncate">Domain &amp; DNS</span>
            </span>
            <StatusDot ok={dnsOk} />
          </div>
          <div className="text-[10.5px] mt-1 leading-snug" style={{ color: "var(--mc-text-muted)" }}>
            {cf?.ok ? "Cloudflare Auto-DNS" : "Manual / Cloudflare"} ·{" "}
            {domainCount > 0 ? `${domainCount} domain${domainCount === 1 ? "" : "s"}` : "No domain yet"}
          </div>
          <div className="text-[10px] mt-1 font-medium" style={{ color: "var(--mc-text-faint)" }}>
            Proves legit DKIM &amp; SPF
          </div>
        </button>

        <FlowArrowRight label="DKIM · SPF · MX" />

        {/* Node 2: Resend */}
        <button
          type="button"
          onClick={() => onSelectPanel("mail")}
          className="flex-1 min-w-0 text-left rounded-[10px] p-2.5 transition-all"
          style={{
            backgroundColor: "var(--mc-bg-elevated)",
            border: `1px solid ${resendOk ? "rgba(52, 199, 89, 0.35)" : "var(--mc-border-subtle)"}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--mc-accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = resendOk
              ? "rgba(52, 199, 89, 0.35)"
              : "var(--mc-border-subtle)";
          }}
        >
          <div className="flex items-center justify-between gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--mc-text)" }}>
              <Mail className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#007AFF" }} />
              <span className="truncate">Resend</span>
            </span>
            <StatusDot ok={resendOk} />
          </div>
          <div className="text-[10.5px] mt-1 leading-snug" style={{ color: "var(--mc-text-muted)" }}>
            {resend?.ok ? "Sending live" : "Key needed"} · {inbound?.ok ? "Webhook live" : "No webhook"}
          </div>
          <div className="text-[10px] mt-1 font-medium" style={{ color: "var(--mc-text-faint)" }}>
            Delivers &amp; receives mail
          </div>
        </button>

        <FlowArrowRight label="Send + Webhook" />

        {/* Node 3: Mail App (CF Pages) */}
        <button
          type="button"
          onClick={() => onSelectPanel("signin")}
          className="flex-1 min-w-0 text-left rounded-[10px] p-2.5 transition-all"
          style={{
            backgroundColor: "var(--mc-bg-elevated)",
            border: "1px solid rgba(52, 199, 89, 0.35)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--mc-accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "rgba(52, 199, 89, 0.35)";
          }}
        >
          <div className="flex items-center justify-between gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--mc-text)" }}>
              <Globe className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#32ADE6" }} />
              <span className="truncate">Your Mail App</span>
            </span>
            <StatusDot ok />
          </div>
          <div className="text-[10.5px] mt-1 leading-snug" style={{ color: "var(--mc-text-muted)" }}>
            Cloudflare Pages + API
          </div>
          <div className="text-[10px] mt-1 font-medium" style={{ color: "var(--mc-text-faint)" }}>
            Inbox UI, rules &amp; routing
          </div>
        </button>

        <div className="flex flex-row sm:flex-col items-center justify-center gap-1 py-1 sm:py-0 px-0.5 flex-shrink-0">
          <ArrowLeftRight className="h-3.5 w-3.5" style={{ color: "var(--mc-text-muted)" }} />
          <span
            className="text-[9.5px] font-medium leading-tight text-center max-w-[68px]"
            style={{ color: "var(--mc-text-faint)" }}
          >
            Stores mail
          </span>
        </div>

        {/* Node 4: Supabase */}
        <button
          type="button"
          onClick={() => onSelectPanel("database")}
          className="flex-1 min-w-0 text-left rounded-[10px] p-2.5 transition-all"
          style={{
            backgroundColor: "var(--mc-bg-elevated)",
            border: `1px solid ${dbOk ? "rgba(52, 199, 89, 0.35)" : "var(--mc-border-subtle)"}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--mc-accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = dbOk
              ? "rgba(52, 199, 89, 0.35)"
              : "var(--mc-border-subtle)";
          }}
        >
          <div className="flex items-center justify-between gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--mc-text)" }}>
              <Database className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#34C759" }} />
              <span className="truncate">Supabase</span>
            </span>
            <StatusDot ok={dbOk} />
          </div>
          <div className="text-[10.5px] mt-1 leading-snug" style={{ color: "var(--mc-text-muted)" }}>
            {dbOk ? "DB + tables ready" : "Run SQL bundle"}
          </div>
          <div className="text-[10px] mt-1 font-medium" style={{ color: "var(--mc-text-faint)" }}>
            Mail, keys &amp; allowlist
          </div>
        </button>
      </div>

      {/* BRANCH CONNECTOR TO AI AGENT LAYER */}
      <div className="flex items-center gap-2 px-1">
        <div className="h-px flex-1" style={{ backgroundColor: "var(--mc-border-subtle)" }} />
        <div
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10.5px] font-medium"
          style={{
            backgroundColor: "var(--mc-bg-elevated)",
            border: "1px solid var(--mc-border-subtle)",
            color: "var(--mc-text-secondary)",
          }}
        >
          <ArrowDown className="h-3 w-3" style={{ color: "var(--mc-accent)" }} />
          <span>
            Mail to <code className="font-mono text-[10px]">a.*@yourdomain</code> checks allowlist → routes to AI Agent → replies via Resend
          </span>
        </div>
        <div className="h-px flex-1" style={{ backgroundColor: "var(--mc-border-subtle)" }} />
      </div>

      {/* ROW 2: AI AGENT ENGINE (SUBSCRIPTION vs API KEY) */}
      <div
        className="rounded-[10px] p-3 space-y-2.5"
        style={{
          backgroundColor: "var(--mc-bg-elevated)",
          border: "1px solid var(--mc-border-subtle)",
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="h-6 w-6 rounded-[7px] flex items-center justify-center flex-shrink-0"
              style={{
                backgroundColor:
                  engine.mode === "none" ? "var(--mc-bg-tertiary)" : "var(--mc-accent-bg)",
                color: engine.mode === "none" ? "var(--mc-text-muted)" : "var(--mc-accent)",
              }}
            >
              <Bot className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-semibold truncate" style={{ color: "var(--mc-text)" }}>
                AI Agent Connection
              </div>
              <div className="text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>
                {engine.summary}
              </div>
            </div>
          </div>
          <span
            className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full flex-shrink-0"
            style={{
              backgroundColor:
                engine.mode === "none"
                  ? "var(--mc-bg-tertiary)"
                  : engine.subActive
                    ? "var(--mc-success-bg)"
                    : "var(--mc-accent-bg)",
              color:
                engine.mode === "none"
                  ? "var(--mc-text-muted)"
                  : engine.subActive
                    ? "var(--mc-success)"
                    : "var(--mc-accent)",
            }}
          >
            {engine.label}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* Option 1: Subscription (Grok CLI Worker) */}
          <button
            type="button"
            onClick={() => onSelectPanel("hands")}
            className="text-left rounded-[10px] p-3 transition-all space-y-1.5"
            style={{
              backgroundColor: "var(--mc-bg-tertiary)",
              border: engine.subActive
                ? "1.5px solid var(--mc-success)"
                : "1px solid var(--mc-border-subtle)",
            }}
            onMouseEnter={(e) => {
              if (!engine.subActive) e.currentTarget.style.borderColor = "var(--mc-accent)";
            }}
            onMouseLeave={(e) => {
              if (!engine.subActive) e.currentTarget.style.borderColor = "var(--mc-border-subtle)";
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--mc-text)" }}>
                <CreditCard className="h-3.5 w-3.5" style={{ color: "#34C759" }} />
                Subscription (Grok CLI)
              </span>
              {engine.subActive ? (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: "var(--mc-success-bg)", color: "var(--mc-success)" }}
                >
                  <CheckCircle2 className="h-3 w-3" /> Active
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: "var(--mc-bg-elevated)", color: "var(--mc-text-muted)" }}
                >
                  <CircleDashed className="h-3 w-3" /> {subOnline ? "Standby" : "Offline"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--mc-text-secondary)" }}>
              {runtime?.box_online && !runtime?.online ? (
                <Server className="h-3 w-3 flex-shrink-0" style={{ color: "#0EA5E9" }} />
              ) : (
                <Laptop className="h-3 w-3 flex-shrink-0" style={{ color: "#34C759" }} />
              )}
              <span>{lastSeenText}</span>
            </div>
            <div className="text-[10.5px] leading-snug" style={{ color: "var(--mc-text-muted)" }}>
              Uses your <strong>Grok subscription</strong> via local Mac or Docker CLI worker. Full repo edits, tools &amp; Kanban — no API key billing.
            </div>
          </button>

          {/* Option 2: API Key (xAI Cloud Q&A) */}
          <button
            type="button"
            onClick={() => onSelectPanel("hands")}
            className="text-left rounded-[10px] p-3 transition-all space-y-1.5"
            style={{
              backgroundColor: "var(--mc-bg-tertiary)",
              border: engine.apiActive
                ? "1.5px solid var(--mc-accent)"
                : "1px solid var(--mc-border-subtle)",
            }}
            onMouseEnter={(e) => {
              if (!engine.apiActive) e.currentTarget.style.borderColor = "var(--mc-accent)";
            }}
            onMouseLeave={(e) => {
              if (!engine.apiActive) e.currentTarget.style.borderColor = "var(--mc-border-subtle)";
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--mc-text)" }}>
                <KeyRound className="h-3.5 w-3.5" style={{ color: "#007AFF" }} />
                API Key (xAI Cloud)
              </span>
              {engine.apiActive ? (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: "var(--mc-accent-bg)", color: "var(--mc-accent)" }}
                >
                  <Sparkles className="h-3 w-3" /> {engine.mode === "hybrid" ? "Fallback Ready" : "Active"}
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: "var(--mc-bg-elevated)", color: "var(--mc-text-muted)" }}
                >
                  <CircleDashed className="h-3 w-3" /> {xaiConfigured ? "Standby" : "Not set"}
                </span>
              )}
            </div>
            <div className="text-[11px]" style={{ color: "var(--mc-text-secondary)" }}>
              {xaiConfigured
                ? `xAI key connected (${xaiSource === "ui" ? "saved in UI" : "Cloudflare secret"})`
                : "No XAI_API_KEY configured"}
            </div>
            <div className="text-[10.5px] leading-snug" style={{ color: "var(--mc-text-muted)" }}>
              Uses an <strong>xAI API key</strong> inside Cloudflare Functions. Instant Q&amp;A replies even when your Mac is asleep (no file edits).
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
