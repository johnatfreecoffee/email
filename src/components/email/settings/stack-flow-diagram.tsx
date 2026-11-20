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
  const subPlaceLabel =
    macOnline && boxOnline
      ? "Mac + Cloud Box"
      : macOnline
        ? "This Mac"
        : boxOnline
          ? "Cloud Box"
          : null;
  const subPlaceProse =
    macOnline && boxOnline
      ? "your Mac & Cloud Box"
      : macOnline
        ? "your Mac"
        : boxOnline
          ? "your Cloud Box"
          : "your worker";
  const hands = runtime?.hands || "auto";

  if (hands === "api") {
    if (xaiConfigured) {
      return {
        mode: "api",
        label: "API Key Active (xAI Cloud)",
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
    const targetProse = hands === "local" ? "your Mac" : "your Cloud Box";
    if (targetOnline) {
      return {
        mode: "subscription",
        label: `Subscription Active (${targetName})`,
        summary: `Using your Grok subscription via ${targetProse} CLI worker — full coding tools & repo edits.`,
        subActive: true,
        apiActive: false,
      };
    }
    return {
      mode: "none",
      label: `Subscription Offline (${targetName})`,
      summary: `Locked to ${targetProse} worker (Grok subscription), currently offline. Start the worker or switch to Auto.`,
      subActive: false,
      apiActive: false,
    };
  }

  // Auto mode (default): Subscription primary when online, API Key fallback when offline
  if (subOnline && xaiConfigured) {
    return {
      mode: "hybrid",
      label: `Subscription (${subPlaceLabel}) + API Fallback`,
      summary: `Your Grok subscription on ${subPlaceProse} handles live jobs; xAI API Key answers Q&A automatically when offline.`,
      subActive: true,
      apiActive: true,
    };
  }
  if (subOnline) {
    return {
      mode: "subscription",
      label: `Subscription Active (${subPlaceLabel})`,
      summary: `Using your Grok subscription via ${subPlaceProse} CLI worker — full coding tools & zero API charges.`,
      subActive: true,
      apiActive: false,
    };
  }
  if (xaiConfigured) {
    return {
      mode: "api",
      label: "API Key Active (xAI Cloud)",
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

function StatusPill({ ok, optional }: { ok: boolean; optional?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
      style={{
        backgroundColor: ok
          ? "var(--mc-success-bg)"
          : optional
            ? "var(--mc-bg-tertiary)"
            : "var(--mc-danger-bg)",
        color: ok
          ? "var(--mc-success)"
          : optional
            ? "var(--mc-text-muted)"
            : "var(--mc-red)",
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          backgroundColor: ok
            ? "var(--mc-success)"
            : optional
              ? "var(--mc-text-faint)"
              : "var(--mc-red)",
        }}
      />
      {ok ? "Live" : optional ? "Optional" : "Setup"}
    </span>
  );
}

function FlowStepArrow({ label, bidirectional }: { label: string; bidirectional?: boolean }) {
  return (
    <div className="flex flex-row sm:flex-col items-center justify-center gap-1 py-1 sm:py-0 px-1 flex-shrink-0 sm:w-[92px]">
      {bidirectional ? (
        <ArrowLeftRight className="h-4 w-4 flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
      ) : (
        <>
          <ArrowDown className="h-4 w-4 sm:hidden flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
          <ArrowRight className="h-4 w-4 hidden sm:block flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
        </>
      )}
      <span
        className="text-[10px] font-medium leading-tight text-center"
        style={{ color: "var(--mc-text-muted)" }}
      >
        {label}
      </span>
    </div>
  );
}

function VerticalConnector({ label }: { label: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <div className="h-px flex-1" style={{ backgroundColor: "var(--mc-border-subtle)" }} />
      <div
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10.5px] font-medium max-w-full"
        style={{
          backgroundColor: "var(--mc-bg-elevated)",
          border: "1px solid var(--mc-border-subtle)",
          color: "var(--mc-text-secondary)",
        }}
      >
        <ArrowDown className="h-3 w-3 flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
        <span className="truncate">{label}</span>
      </div>
      <div className="h-px flex-1" style={{ backgroundColor: "var(--mc-border-subtle)" }} />
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
      className="rounded-[12px] p-4 space-y-3 overflow-hidden"
      style={{
        backgroundColor: "var(--mc-bg-tertiary)",
        border: "1px solid var(--mc-border-subtle)",
      }}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold tracking-[-0.015em]" style={{ color: "var(--mc-text)" }}>
            Live Stack Map — How Everything Connects
          </div>
          <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
            Click any card to configure it. Arrows show how mail &amp; AI agents flow end-to-end.
          </div>
        </div>
      </div>

      {/* ROW 1: Domain & DNS  ──DKIM · SPF · MX──▶  Resend */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5">
        {/* Node 1: Domain + Cloudflare */}
        <button
          type="button"
          onClick={() => onSelectPanel(cf?.ok ? "domain" : "cloudflare")}
          className="flex-1 min-w-0 overflow-hidden text-left rounded-[10px] p-3 transition-all"
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
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="inline-flex items-center gap-1.5 min-w-0 text-[12.5px] font-semibold" style={{ color: "var(--mc-text)" }}>
              <Cloud className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#FF9500" }} />
              <span className="truncate">1. Domain &amp; DNS</span>
            </span>
            <StatusPill ok={dnsOk} />
          </div>
          <div className="text-[11px] mt-1.5 leading-snug" style={{ color: "var(--mc-text-secondary)" }}>
            {cf?.ok ? "Cloudflare Auto-DNS" : "Manual / Cloudflare"} ·{" "}
            {domainCount > 0 ? `${domainCount} domain${domainCount === 1 ? "" : "s"}` : "No domain yet"}
          </div>
          <div className="text-[10.5px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
            Verifies your domain with legit DKIM, SPF &amp; MX records.
          </div>
        </button>

        <FlowStepArrow label="DKIM · SPF · MX" />

        {/* Node 2: Resend */}
        <button
          type="button"
          onClick={() => onSelectPanel("mail")}
          className="flex-1 min-w-0 overflow-hidden text-left rounded-[10px] p-3 transition-all"
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
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="inline-flex items-center gap-1.5 min-w-0 text-[12.5px] font-semibold" style={{ color: "var(--mc-text)" }}>
              <Mail className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#007AFF" }} />
              <span className="truncate">2. Resend Mail Engine</span>
            </span>
            <StatusPill ok={resendOk} />
          </div>
          <div className="text-[11px] mt-1.5 leading-snug" style={{ color: "var(--mc-text-secondary)" }}>
            {resend?.ok ? "Sending live" : "Key needed"} · {inbound?.ok ? "Inbound webhook live" : "Webhook needed"}
          </div>
          <div className="text-[10.5px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
            Delivers outgoing mail &amp; pushes incoming mail to this app.
          </div>
        </button>
      </div>

      <VerticalConnector label="Send API & Inbound Webhook (/api/email/inbound)" />

      {/* ROW 2: Your Mail App  ◀──Stores mail & keys──▶  Supabase */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5">
        {/* Node 3: Mail App (CF Pages) */}
        <button
          type="button"
          onClick={() => onSelectPanel("signin")}
          className="flex-1 min-w-0 overflow-hidden text-left rounded-[10px] p-3 transition-all"
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
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="inline-flex items-center gap-1.5 min-w-0 text-[12.5px] font-semibold" style={{ color: "var(--mc-text)" }}>
              <Globe className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#32ADE6" }} />
              <span className="truncate">3. Your Mail App</span>
            </span>
            <StatusPill ok />
          </div>
          <div className="text-[11px] mt-1.5 leading-snug" style={{ color: "var(--mc-text-secondary)" }}>
            Cloudflare Pages + Serverless Functions
          </div>
          <div className="text-[10.5px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
            Your inbox UI, spam filter, rules, push alerts &amp; routing.
          </div>
        </button>

        <FlowStepArrow label="Stores mail & keys" bidirectional />

        {/* Node 4: Supabase */}
        <button
          type="button"
          onClick={() => onSelectPanel("database")}
          className="flex-1 min-w-0 overflow-hidden text-left rounded-[10px] p-3 transition-all"
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
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="inline-flex items-center gap-1.5 min-w-0 text-[12.5px] font-semibold" style={{ color: "var(--mc-text)" }}>
              <Database className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#34C759" }} />
              <span className="truncate">4. Supabase Storage</span>
            </span>
            <StatusPill ok={dbOk} />
          </div>
          <div className="text-[11px] mt-1.5 leading-snug" style={{ color: "var(--mc-text-secondary)" }}>
            {dbOk ? "Database & tables ready" : "Run 1-click SQL bundle"}
          </div>
          <div className="text-[10.5px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
            Stores emails, threads, attachments, keys &amp; agent allowlist.
          </div>
        </button>
      </div>

      {/* BRANCH CONNECTOR TO AI AGENT LAYER */}
      <VerticalConnector
        label={
          <>
            Mail to <code className="font-mono text-[10px]">a.*@yourdomain</code> → allowlist → AI Agent → replies via Resend
          </>
        }
      />

      {/* ROW 3: AI AGENT ENGINE (SUBSCRIPTION vs API KEY) */}
      <div
        className="rounded-[10px] p-3.5 space-y-2.5 overflow-hidden"
        style={{
          backgroundColor: "var(--mc-bg-elevated)",
          border: "1px solid var(--mc-border-subtle)",
        }}
      >
        <div className="space-y-1">
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
              <span className="text-[12.5px] font-semibold" style={{ color: "var(--mc-text)" }}>
                5. AI Agent Connection
              </span>
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
          <div className="text-[11.5px] leading-snug" style={{ color: "var(--mc-text-muted)" }}>
            {engine.summary}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* Option 1: Subscription (Grok CLI Worker) */}
          <button
            type="button"
            onClick={() => onSelectPanel("hands")}
            className="min-w-0 overflow-hidden text-left rounded-[10px] p-3 transition-all space-y-1.5"
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
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="inline-flex items-center gap-1.5 min-w-0 text-[12px] font-semibold" style={{ color: "var(--mc-text)" }}>
                <CreditCard className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#34C759" }} />
                <span className="truncate">Subscription (Grok CLI)</span>
              </span>
              {engine.subActive ? (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: "var(--mc-success-bg)", color: "var(--mc-success)" }}
                >
                  <CheckCircle2 className="h-3 w-3" /> Active
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: "var(--mc-bg-elevated)", color: "var(--mc-text-muted)" }}
                >
                  <CircleDashed className="h-3 w-3" /> {subOnline ? "Standby" : "Offline"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--mc-text-secondary)" }}>
              {runtime?.box_online && !runtime?.online ? (
                <Server className="h-3 w-3 flex-shrink-0" style={{ color: "#0EA5E9" }} />
              ) : (
                <Laptop className="h-3 w-3 flex-shrink-0" style={{ color: "#34C759" }} />
              )}
              <span className="truncate">{lastSeenText}</span>
            </div>
            <div className="text-[10.5px] leading-snug" style={{ color: "var(--mc-text-muted)" }}>
              Uses your <strong>Grok subscription</strong> via local Mac or Docker CLI worker. Full repo edits, tools &amp; Kanban — no API key billing.
            </div>
          </button>

          {/* Option 2: API Key (xAI Cloud Q&A) */}
          <button
            type="button"
            onClick={() => onSelectPanel("hands")}
            className="min-w-0 overflow-hidden text-left rounded-[10px] p-3 transition-all space-y-1.5"
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
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="inline-flex items-center gap-1.5 min-w-0 text-[12px] font-semibold" style={{ color: "var(--mc-text)" }}>
                <KeyRound className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "#007AFF" }} />
                <span className="truncate">API Key (xAI Cloud)</span>
              </span>
              {engine.apiActive ? (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: "var(--mc-accent-bg)", color: "var(--mc-accent)" }}
                >
                  <Sparkles className="h-3 w-3" /> {engine.mode === "hybrid" ? "Fallback" : "Active"}
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: "var(--mc-bg-elevated)", color: "var(--mc-text-muted)" }}
                >
                  <CircleDashed className="h-3 w-3" /> {xaiConfigured ? "Standby" : "Not set"}
                </span>
              )}
            </div>
            <div className="text-[11px] truncate" style={{ color: "var(--mc-text-secondary)" }}>
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
