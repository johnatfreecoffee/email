"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Check,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Database,
  Mail,
  Webhook,
  Cloud,
  Globe,
  ShieldCheck,
  Bell,
  Sparkles,
  Laptop,
  Server,
  MessageSquare,
  Loader2,
  Download,
  Package,
  Trash2,
  Zap,
  AlertCircle,
  Bot,
  CreditCard,
  KeyRound,
  type LucideIcon,
} from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { usePush } from "@/lib/push-notifications";
import type { SettingsTab } from "@/lib/settings";
import type { EmailDomain } from "../email-layout";
import { DomainSetupCard, type CloudflareZoneOption } from "../domain-setup";
import {
  StackFlowDiagram,
  type AgentRuntimeInfo,
  describeActiveAgentEngine,
  formatRelativeSeen,
} from "./stack-flow-diagram";

type Path = "mail" | "machine" | "box" | "chat";
type Panel =
  | "hub"
  | "database"
  | "mail"
  | "cloudflare"
  | "domain"
  | "signin"
  | "hands"
  | "extras"
  | "deploy";

type Tile = { id: string; ok: boolean; configured: boolean; detail: string };

interface ProviderStatus {
  configured: boolean;
  source: "ui" | "env" | "none";
  preview: string | null;
}

interface SetupConfigResponse {
  hasSettingsTable: boolean;
  providers: {
    resend: ProviderStatus;
    cloudflare: ProviderStatus;
    xai: ProviderStatus;
    openrouter: ProviderStatus;
  };
  cloudflareAccountIdPreview: string | null;
}

const PATHS: Array<{ id: Path; short: string; title: string; body: string }> = [
  {
    id: "mail",
    short: "Mail only",
    title: "Mail only",
    body: "Custom-domain inbox & sending in the browser + PWA push alerts. No AI agents.",
  },
  {
    id: "machine",
    short: "This Mac",
    title: "Mail + agents on this computer",
    body: "A local worker on your Mac/Linux box answers a.* mail and edits repos you allow.",
  },
  {
    id: "box",
    short: "Cloud box",
    title: "Mail + agents on a cloud box",
    body: "Always-on Docker worker on Fly/VPS so agents keep working when your laptop sleeps.",
  },
  {
    id: "chat",
    short: "Cloud Q&A",
    title: "Mail + always-on cloud Q&A",
    body: "xAI answers questions directly from Cloudflare Pages Functions — zero local worker required.",
  },
];

const TILE_META: Record<
  string,
  {
    label: string;
    required: (p: Path) => boolean;
    optional?: boolean;
    panel: Panel;
    icon: LucideIcon;
    tint: string;
  }
> = {
  supabase: { label: "Database", required: () => true, panel: "database", icon: Database, tint: "#34C759" },
  migrations: { label: "Tables", required: () => true, panel: "database", icon: Database, tint: "#34C759" },
  resend: { label: "Resend", required: () => true, panel: "mail", icon: Mail, tint: "#007AFF" },
  inbound: { label: "Inbound webhook", required: () => true, panel: "mail", icon: Webhook, tint: "#32ADE6" },
  cloudflare: { label: "Cloudflare DNS", required: () => false, optional: true, panel: "cloudflare", icon: Cloud, tint: "#FF9500" },
  domain: { label: "Domain", required: () => true, panel: "domain", icon: Globe, tint: "#0EA5E9" },
  auth: { label: "Sign-in", required: () => true, panel: "signin", icon: ShieldCheck, tint: "#64748B" },
  push: { label: "Web push", required: () => false, optional: true, panel: "extras", icon: Bell, tint: "#007AFF" },
  junk: { label: "Junk LLM", required: () => false, optional: true, panel: "extras", icon: Sparkles, tint: "#FF9500" },
  machine: { label: "Sub · This Mac", required: (p) => p === "machine", optional: true, panel: "hands", icon: Laptop, tint: "#34C759" },
  box: { label: "Sub · Cloud Box", required: (p) => p === "box", optional: true, panel: "hands", icon: Server, tint: "#0EA5E9" },
  chat: { label: "API Key · xAI", required: (p) => p === "chat", optional: true, panel: "hands", icon: MessageSquare, tint: "#007AFF" },
};

const SETUP_KEY = "email.stack-setup";

function loadSetup(): { path: Path } {
  try {
    const raw = JSON.parse(localStorage.getItem(SETUP_KEY) || "{}") as { path?: Path };
    if (raw.path && PATHS.some((p) => p.id === raw.path)) {
      return { path: raw.path };
    }
  } catch {
    /* ignore */
  }
  return { path: "mail" };
}

function saveSetup(path: Path) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify({ path, done: true }));
  } catch {
    /* ignore */
  }
}

function tileById(tiles: Tile[], id: string): Tile | undefined {
  return tiles.find((t) => t.id === id);
}

export function SetupTab({
  domains,
  onOpenTab,
  onRefreshDomains,
  onLaunchWizard,
}: {
  domains: EmailDomain[];
  onOpenTab: (tab: SettingsTab) => void;
  onRefreshDomains: () => void;
  onLaunchWizard?: () => void;
}) {
  const [path, setPath] = useState<Path>(() => loadSetup().path);
  const [panel, setPanel] = useState<Panel>("hub");
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [config, setConfig] = useState<SetupConfigResponse | null>(null);
  const [runtime, setRuntime] = useState<AgentRuntimeInfo | null>(null);
  const [handsBusy, setHandsBusy] = useState(false);
  const [handsMsg, setHandsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cfZones, setCfZones] = useState<CloudflareZoneOption[]>([]);
  const [checking, setChecking] = useState(false);

  // Webhook 1-click provisioning state
  const defaultInboundUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/email/inbound`
      : "https://YOUR_PAGES_URL/api/email/inbound";
  const [webhookUrl, setWebhookUrl] = useState(defaultInboundUrl);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookMsg, setWebhookMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // All-in-one SQL copy state
  const [sqlBusy, setSqlBusy] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);

  // Push test state
  const push = usePush();
  const [pushTestMsg, setPushTestMsg] = useState<string | null>(null);

  // Deploy / .env builder state
  const [envSupaUrl, setEnvSupaUrl] = useState("");
  const [envOwnerEmail, setEnvOwnerEmail] = useState("");

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const [setupRes, cfgRes, rtRes] = await Promise.all([
        apiFetch("/api/email/agent-setup"),
        apiFetch("/api/email/setup-config"),
        apiFetch("/api/email/agent-runtime"),
      ]);
      if (setupRes.ok) {
        const data = await setupRes.json();
        setTiles(data.tiles || []);
      }
      if (rtRes.ok) {
        const rt = (await rtRes.json()) as AgentRuntimeInfo;
        setRuntime(rt);
      }
      if (cfgRes.ok) {
        const cfgData = (await cfgRes.json()) as SetupConfigResponse;
        setConfig(cfgData);
        if (cfgData.providers?.cloudflare?.configured) {
          const zRes = await apiFetch("/api/email/setup-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "list_cf_zones" }),
          });
          if (zRes.ok) {
            const zData = await zRes.json();
            if (Array.isArray(zData.zones)) setCfZones(zData.zones);
          }
        }
      }
    } catch {
      /* keep last */
    } finally {
      setChecking(false);
    }
  }, []);

  async function handleSaveHands(nextHands: "auto" | "local" | "box" | "api") {
    setHandsBusy(true);
    setHandsMsg(null);
    try {
      const res = await apiFetch("/api/email/agent-runtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hands: nextHands }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setRuntime((prev) =>
          prev
            ? { ...prev, hands: nextHands }
            : { hands: nextHands, worker_seen_at: null, box_seen_at: null, online: false, box_online: false }
        );
        setHandsMsg({ ok: true, text: `Agent routing updated to "${nextHands}".` });
      } else {
        setHandsMsg({ ok: false, text: data.error || "Could not update routing mode" });
      }
    } catch (err) {
      setHandsMsg({ ok: false, text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setHandsBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 20000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleSelectPath = (next: Path) => {
    setPath(next);
    saveSetup(next);
  };

  const picked = PATHS.find((p) => p.id === path) ?? PATHS[0];
  const wantsAgents = path !== "mail";

  const requiredTiles = useMemo(
    () =>
      tiles.filter((t) => {
        const meta = TILE_META[t.id];
        return meta && meta.required(path);
      }),
    [tiles, path]
  );

  const connectedRequiredCount = useMemo(
    () => requiredTiles.filter((t) => t.ok).length,
    [requiredTiles]
  );

  const remaining = useMemo(() => requiredTiles.filter((t) => !t.ok), [requiredTiles]);

  const readinessPct =
    requiredTiles.length > 0 ? Math.round((connectedRequiredCount / requiredTiles.length) * 100) : 0;

  const visibleTiles = useMemo(() => tiles, [tiles]);

  function openTile(id: string) {
    const meta = TILE_META[id];
    if (!meta) return;
    if (id === "machine" || id === "box" || id === "chat") {
      handleSelectPath(id);
    }
    setPanel(meta.panel);
  }

  async function handleProvisionWebhook() {
    setWebhookBusy(true);
    setWebhookMsg(null);
    try {
      const res = await apiFetch("/api/email/setup-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "provision_webhook", endpoint: webhookUrl }),
      });
      const data = await res.json();
      setWebhookMsg({ ok: !!data.ok, text: data.detail || (data.ok ? "Connected!" : "Failed") });
      if (data.ok) await refresh();
    } catch (err) {
      setWebhookMsg({ ok: false, text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setWebhookBusy(false);
    }
  }

  async function handleCopyAllSql() {
    setSqlBusy(true);
    try {
      const res = await fetch("/setup-migrations.sql");
      const sql = await res.text();
      await navigator.clipboard.writeText(sql);
      setSqlCopied(true);
      setTimeout(() => setSqlCopied(false), 2000);
    } catch {
      /* ignore */
    } finally {
      setSqlBusy(false);
    }
  }

  async function handleTestPush() {
    setPushTestMsg(null);
    try {
      const res = await apiFetch("/api/email/push-test", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      setPushTestMsg(res.ok ? "Test notification sent!" : data.error || "Could not send test push");
    } catch {
      setPushTestMsg("Network error sending test push");
    }
  }

  const generatedEnvText = useMemo(() => {
    const supa = envSupaUrl.trim() || "https://YOUR_PROJECT_REF.supabase.co";
    const owner = envOwnerEmail.trim() || "you@yourdomain.com";
    const secret = "replace-with-32-char-random-secret";
    return `# Core database (Supabase)
SUPABASE_URL=${supa}
SUPABASE_SERVICE_KEY=eyJ...
NEXT_PUBLIC_SUPABASE_URL=${supa}
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

# Owner Sign-in
MC_API_SECRET=${secret}
NEXT_PUBLIC_MC_API_SECRET=${secret}
NEXT_PUBLIC_OWNER_EMAIL=${owner}
NEXT_PUBLIC_OWNER_PASSWORD=choose-a-strong-password

# Optional: Resend, Cloudflare, xAI & OpenRouter can be connected
# right inside Settings → Setup with 1-click after first login!`;
  }, [envSupaUrl, envOwnerEmail]);

  function downloadEnvFile() {
    const blob = new Blob([generatedEnvText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ".env.local";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden space-y-4">
      {/* Sub-panel breadcrumb bar */}
      {panel !== "hub" && (
        <div className="flex items-center justify-between gap-2 pb-1">
          <button
            type="button"
            onClick={() => setPanel("hub")}
            className="inline-flex items-center gap-1 text-[12.5px] font-medium px-2 py-1 -ml-2 rounded-lg transition-colors"
            style={{ color: "var(--mc-accent)" }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <ChevronLeft className="h-4 w-4" />
            All Setup Tiles
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="am-ghost inline-flex items-center gap-1.5"
          >
            <RefreshCw className={`h-3 w-3 ${checking ? "animate-spin" : ""}`} />
            Recheck
          </button>
        </div>
      )}

      {/* ==================== HUB: LIVE TILED CONTROL CENTER ==================== */}
      {panel === "hub" && (
        <div className="space-y-4">
          {/* Readiness + Mode selector card */}
          <div
            className="rounded-[12px] p-4 space-y-3"
            style={{
              backgroundColor: "var(--mc-bg-tertiary)",
              border: "1px solid var(--mc-border-subtle)",
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[14px] font-semibold tracking-[-0.015em]" style={{ color: "var(--mc-text)" }}>
                  Plug-and-Play Setup
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
                  {requiredTiles.length > 0
                    ? `${connectedRequiredCount} of ${requiredTiles.length} core services connected`
                    : "Checking live connections…"}
                  {domains.length > 0 ? ` · ${domains.length} domain${domains.length === 1 ? "" : "s"}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="text-[12px] font-semibold tabular-nums px-2.5 py-0.5 rounded-full"
                  style={{
                    backgroundColor: readinessPct === 100 ? "var(--mc-success-bg)" : "var(--mc-accent-bg)",
                    color: readinessPct === 100 ? "var(--mc-success)" : "var(--mc-accent)",
                  }}
                >
                  {readinessPct}% ready
                </span>
                {onLaunchWizard && (
                  <button
                    type="button"
                    onClick={onLaunchWizard}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors"
                    style={{
                      backgroundColor: "var(--mc-bg-elevated)",
                      border: "1px solid var(--mc-border)",
                      color: "var(--mc-text)",
                    }}
                    title="Launch step-by-step setup wizard"
                  >
                    <Sparkles className="h-3.5 w-3.5" style={{ color: "var(--mc-accent)" }} />
                    <span>Guided Wizard</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void refresh();
                    onRefreshDomains();
                  }}
                  className="p-1.5 rounded-lg transition-colors"
                  style={{ color: "var(--mc-text-muted)", border: "1px solid var(--mc-border)" }}
                  title="Recheck all connections"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>

            {/* Progress bar */}
            <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ backgroundColor: "var(--mc-bg-hover)" }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${readinessPct}%`,
                  backgroundColor: readinessPct === 100 ? "var(--mc-success)" : "var(--mc-accent)",
                }}
              />
            </div>

            {/* Mode segmented pills */}
            <div className="pt-1 space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                {PATHS.map((p) => {
                  const active = p.id === path;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handleSelectPath(p.id)}
                      className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all"
                      style={{
                        backgroundColor: active ? "var(--mc-accent)" : "var(--mc-bg-elevated)",
                        color: active ? "#FFFFFF" : "var(--mc-text-secondary)",
                        border: `1px solid ${active ? "var(--mc-accent)" : "var(--mc-border-subtle)"}`,
                      }}
                    >
                      {p.short}
                    </button>
                  );
                })}
              </div>
              <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
                {picked.body}
              </div>
            </div>

            {remaining.length > 0 && (
              <div
                className="flex items-center justify-between gap-2 pt-2 text-[11.5px]"
                style={{ borderTop: "1px solid var(--mc-border-subtle)", color: "var(--mc-text-muted)" }}
              >
                <span>
                  Next up:{" "}
                  <strong style={{ color: "var(--mc-text)" }}>
                    {remaining.map((t) => TILE_META[t.id]?.label || t.id).join(" → ")}
                  </strong>
                </span>
                <button
                  type="button"
                  onClick={() => openTile(remaining[0].id)}
                  className="text-[11.5px] font-semibold flex-shrink-0 inline-flex items-center gap-0.5"
                  style={{ color: "var(--mc-accent)" }}
                >
                  Connect {TILE_META[remaining[0].id]?.label}
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Interactive Live Stack Diagram (Cloudflare -> Resend -> App <-> Supabase -> Subscription vs API Key) */}
          <StackFlowDiagram
            tiles={tiles}
            runtime={runtime}
            domainCount={domains.length}
            xaiSource={config?.providers?.xai?.source}
            onSelectPanel={(target) => setPanel(target)}
          />

          {/* Interactive macOS Service Tiles */}
          <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
            {visibleTiles.map((t) => {
              const meta = TILE_META[t.id];
              const Icon = meta?.icon ?? Zap;
              const tint = meta?.tint ?? "#007AFF";
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => openTile(t.id)}
                  className="group text-left rounded-[12px] p-3.5 min-w-0 overflow-hidden transition-all"
                  style={{
                    backgroundColor: "var(--mc-bg-tertiary)",
                    border: `1px solid ${t.ok ? "rgba(52, 199, 89, 0.30)" : "var(--mc-border-subtle)"}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--mc-accent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = t.ok ? "rgba(52, 199, 89, 0.30)" : "var(--mc-border-subtle)";
                  }}
                >
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="h-6 w-6 rounded-[7px] flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: `${tint}1F`, color: tint }}
                      >
                        <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                      </span>
                      <span className="text-[13px] font-semibold truncate" style={{ color: "var(--mc-text)" }}>
                        {meta?.label || t.id}
                      </span>
                    </div>
                    <div className="flex items-center flex-shrink-0">
                      {t.ok ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                      ) : (
                        <span
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                          style={{
                            backgroundColor: meta?.optional ? "var(--mc-bg-hover)" : "var(--mc-danger-bg)",
                            color: meta?.optional ? "var(--mc-text-muted)" : "var(--mc-red)",
                          }}
                        >
                          {meta?.optional ? "Optional" : "Setup"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-[11.5px] mt-2 break-words leading-snug" style={{ color: "var(--mc-text-muted)" }}>
                    {t.detail}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Quick action bar */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              className="am-btn inline-flex items-center gap-1.5"
              onClick={() => setPanel("domain")}
            >
              <Globe className="h-3.5 w-3.5" />
              Add Domain
            </button>
            <button
              type="button"
              className="am-ghost inline-flex items-center gap-1.5"
              onClick={() => setPanel("deploy")}
            >
              <Package className="h-3.5 w-3.5" />
              Package &amp; Deploy Bundle
            </button>
            {wantsAgents && (
              <button
                type="button"
                className="am-ghost"
                onClick={() => onOpenTab("agents")}
              >
                Manage Agents
              </button>
            )}
            <button
              type="button"
              className="am-ghost"
              onClick={() => onOpenTab("howto")}
            >
              How it works
            </button>
          </div>
        </div>
      )}

      {/* ==================== PANEL: RESEND + 1-CLICK WEBHOOK ==================== */}
      {panel === "mail" && (
        <div className="space-y-4">
          <Block title="Resend (Send & Receive)">
            <p>
              Paste your Resend API key once — we verify it live and save it directly in your workspace so you never have to redeploy to rotate keys.
            </p>
            <KeyConnectCard
              provider="resend"
              label="Resend API Key"
              placeholder="re_xxxxxxxxxxxxxxxxxxxxxxxxx"
              status={config?.providers.resend}
              helperLink={{ label: "Get key in Resend →", href: "https://resend.com/api-keys" }}
              onUpdated={refresh}
            />
          </Block>

          <Block title="1-Click Inbound Webhook">
            <p>
              Let Resend push incoming emails straight to this app. Click once below and we’ll register the webhook automatically via Resend’s API.
            </p>
            <div
              className="rounded-[12px] p-3.5 space-y-2.5"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                border: "1px solid var(--mc-border-subtle)",
              }}
            >
              <label className="block text-[11.5px] font-medium" style={{ color: "var(--mc-text-muted)" }}>
                Webhook destination URL
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  className="flex-1 min-w-0 rounded-[9px] px-3 py-2 text-[12.5px] font-mono focus:outline-none"
                  style={{
                    backgroundColor: "var(--mc-bg-elevated)",
                    border: "1px solid var(--mc-border)",
                    color: "var(--mc-text)",
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleProvisionWebhook()}
                  disabled={webhookBusy}
                  className="am-btn inline-flex items-center justify-center gap-1.5 flex-shrink-0"
                >
                  {webhookBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                  Auto-Connect Webhook
                </button>
              </div>
              {webhookMsg && (
                <InlineFeedback ok={webhookMsg.ok} text={webhookMsg.text} />
              )}
              <Status tiles={tiles} ids={["resend", "inbound"]} />
            </div>
          </Block>
        </div>
      )}

      {/* ==================== PANEL: CLOUDFLARE DNS ==================== */}
      {panel === "cloudflare" && (
        <div className="space-y-4">
          <Block title="Cloudflare Auto-DNS (1-Click Records)">
            <p>
              Optional, but magical: connect a Cloudflare API Token with <strong>Zone:Read</strong> and <strong>DNS:Edit</strong>, and every domain you add gets MX, SPF, and DKIM pushed automatically.
            </p>
            <KeyConnectCard
              provider="cloudflare"
              label="Cloudflare API Token"
              placeholder="Paste Zone:Read + DNS:Edit token"
              status={config?.providers.cloudflare}
              helperLink={{ label: "Create Cloudflare Token →", href: "https://dash.cloudflare.com/profile/api-tokens" }}
              onUpdated={refresh}
              onZonesFound={(zones) => setCfZones(zones)}
            />
            <Status tiles={tiles} ids={["cloudflare"]} />

            {cfZones.length > 0 && (
              <div
                className="rounded-[12px] p-3.5 space-y-2"
                style={{
                  backgroundColor: "var(--mc-bg-tertiary)",
                  border: "1px solid var(--mc-border-subtle)",
                }}
              >
                <div className="text-[12px] font-semibold" style={{ color: "var(--mc-text)" }}>
                  Detected Cloudflare Domains ({cfZones.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {cfZones.map((z) => (
                    <button
                      key={z.id}
                      type="button"
                      onClick={() => setPanel("domain")}
                      className="px-2.5 py-1 rounded-full text-[12px] font-medium transition-colors"
                      style={{
                        backgroundColor: "var(--mc-bg-elevated)",
                        border: "1px solid var(--mc-border)",
                        color: "var(--mc-text)",
                      }}
                    >
                      {z.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Block>
        </div>
      )}

      {/* ==================== PANEL: DOMAIN (1-CLICK EMBEDDED) ==================== */}
      {panel === "domain" && (
        <div className="space-y-4">
          <Block title="Connect Your Domain">
            <p>
              Pick one of your Cloudflare domains below or type any domain you own. You can manage mailboxes and catch-all settings anytime in Accounts.
            </p>
            {domains.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
                  Connected:
                </span>
                {domains.map((d) => (
                  <span
                    key={d.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium"
                    style={{
                      backgroundColor: "var(--mc-bg-tertiary)",
                      border: "1px solid var(--mc-border-subtle)",
                      color: "var(--mc-text)",
                    }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    {d.domain}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => onOpenTab("accounts")}
                  className="text-[12px] font-medium ml-1"
                  style={{ color: "var(--mc-accent)" }}
                >
                  Manage in Accounts →
                </button>
              </div>
            )}
            <DomainSetupCard
              embedded
              cloudflareZones={cfZones}
              onDomainAdded={() => {
                onRefreshDomains();
                void refresh();
                setPanel("hub");
              }}
            />
          </Block>
        </div>
      )}

      {/* ==================== PANEL: DATABASE (SUPABASE) ==================== */}
      {panel === "database" && (
        <div className="space-y-4">
          <Block title="Database & Storage (Supabase)">
            <p>
              One free Supabase project stores your mail, attachments, settings, and agent allowlist. Instead of running 15 separate migration files, paste our single all-in-one SQL script once.
            </p>

            <div
              className="rounded-[12px] p-3.5 space-y-3"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                border: "1px solid var(--mc-border-subtle)",
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                    1-Click All-in-One Schema Bundle
                  </div>
                  <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
                    Creates all email, settings, rules, spam, push, agent tables + attachment storage bucket.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyAllSql()}
                    disabled={sqlBusy}
                    className="am-btn inline-flex items-center gap-1.5"
                  >
                    {sqlCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {sqlCopied ? "SQL Copied!" : "Copy All-in-One SQL"}
                  </button>
                  <a
                    href="/setup-migrations.sql"
                    download="setup-migrations.sql"
                    className="am-ghost inline-flex items-center gap-1.5 no-underline"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </a>
                </div>
              </div>
              <Status tiles={tiles} ids={["supabase", "migrations"]} />
            </div>

            <Code>{`# Required in Cloudflare Pages secrets (and .env.local for dev)
SUPABASE_URL=https://YOUR_REF.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...`}</Code>
          </Block>
        </div>
      )}

      {/* ==================== PANEL: SIGN-IN ==================== */}
      {panel === "signin" && (
        <Block title="Owner Sign-In">
          <p>
            Single-owner gate: set your login email, password, and a shared random API secret in Cloudflare Pages environment variables, then rebuild so the static app picks up <code>NEXT_PUBLIC_*</code>.
          </p>
          <Code>{`MC_API_SECRET=long-random-string
NEXT_PUBLIC_MC_API_SECRET=long-random-string
NEXT_PUBLIC_OWNER_EMAIL=you@example.com
NEXT_PUBLIC_OWNER_PASSWORD=choose-a-strong-password`}</Code>
          <Status tiles={tiles} ids={["auth"]} />
        </Block>
      )}

      {/* ==================== PANEL: AGENTS (SUBSCRIPTION vs API KEY) ==================== */}
      {panel === "hands" && (() => {
        const xaiConfigured = !!(config?.providers?.xai?.configured || tileById(tiles, "chat")?.ok);
        const engine = describeActiveAgentEngine({ runtime, xaiConfigured });
        const currentHands = runtime?.hands || "auto";
        const ROUTING_OPTIONS: Array<{
          id: "auto" | "local" | "box" | "api";
          label: string;
          hint: string;
        }> = [
          { id: "auto", label: "Auto (Sub + API fallback)", hint: "Uses Subscription worker when online; falls back to xAI API Key when asleep." },
          { id: "local", label: "Subscription · This Mac", hint: "Only use your Mac Grok CLI worker (no cloud API replies)." },
          { id: "box", label: "Subscription · Cloud Box", hint: "Only use your always-on Docker Grok CLI worker." },
          { id: "api", label: "API Key · xAI Cloud", hint: "Always answer Q&A directly via Cloudflare + XAI_API_KEY." },
        ];

        return (
          <div className="space-y-4">
            {/* Active Engine + Routing Mode Banner */}
            <Block title="Active AI Agent Connection">
              <div
                className="rounded-[12px] p-3.5 space-y-3"
                style={{
                  backgroundColor: "var(--mc-bg-tertiary)",
                  border: `1px solid ${engine.subActive ? "rgba(52, 199, 89, 0.4)" : engine.apiActive ? "var(--mc-accent)" : "var(--mc-border-subtle)"}`,
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Bot className="h-4 w-4 flex-shrink-0" style={{ color: engine.subActive ? "var(--mc-success)" : "var(--mc-accent)" }} />
                    <span className="text-[13.5px] font-semibold" style={{ color: "var(--mc-text)" }}>
                      {engine.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold"
                      style={{
                        backgroundColor: engine.subActive ? "var(--mc-success-bg)" : "var(--mc-bg-elevated)",
                        color: engine.subActive ? "var(--mc-success)" : "var(--mc-text-muted)",
                      }}
                    >
                      <CreditCard className="h-3 w-3" /> Subscription: {runtime?.online ? "Mac online" : runtime?.box_online ? "Box online" : "Offline"}
                    </span>
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold"
                      style={{
                        backgroundColor: engine.apiActive ? "var(--mc-accent-bg)" : "var(--mc-bg-elevated)",
                        color: engine.apiActive ? "var(--mc-accent)" : "var(--mc-text-muted)",
                      }}
                    >
                      <KeyRound className="h-3 w-3" /> API Key: {xaiConfigured ? "Connected" : "Not set"}
                    </span>
                  </div>
                </div>
                <div className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
                  {engine.summary}
                </div>

                {/* Live Routing Switcher */}
                <div className="pt-2 space-y-1.5" style={{ borderTop: "1px solid var(--mc-border-subtle)" }}>
                  <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--mc-text-faint)" }}>
                    Active Routing Mode
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ROUTING_OPTIONS.map((opt) => {
                      const active = currentHands === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={handsBusy}
                          onClick={() => void handleSaveHands(opt.id)}
                          className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all disabled:opacity-50"
                          style={{
                            backgroundColor: active ? "var(--mc-accent)" : "var(--mc-bg-elevated)",
                            color: active ? "#FFFFFF" : "var(--mc-text-secondary)",
                            border: `1px solid ${active ? "var(--mc-accent)" : "var(--mc-border-subtle)"}`,
                          }}
                          title={opt.hint}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="text-[11px]" style={{ color: "var(--mc-text-muted)" }}>
                    {ROUTING_OPTIONS.find((o) => o.id === currentHands)?.hint}
                  </div>
                  {handsMsg && <InlineFeedback ok={handsMsg.ok} text={handsMsg.text} />}
                </div>
              </div>
            </Block>

            {/* Option 1: Subscription (Grok CLI Worker) */}
            <Block title="Option 1 — Connect via Subscription (Grok CLI Worker)">
              <p>
                Runs on your <strong>Grok subscription</strong> via the local <code>grok</code> CLI (no per-token API charges). Polls Supabase every 30s for mail sent to <code>a.&lt;repo&gt;@yourdomain</code>, runs full coding tools, updates your Agent Kanban, and replies via Resend.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
                <div
                  className="rounded-[10px] p-3"
                  style={{
                    backgroundColor: "var(--mc-bg-tertiary)",
                    border: `1px solid ${runtime?.online ? "rgba(52, 199, 89, 0.35)" : "var(--mc-border-subtle)"}`,
                  }}
                >
                  <div className="flex items-center justify-between font-semibold" style={{ color: "var(--mc-text)" }}>
                    <span className="inline-flex items-center gap-1.5"><Laptop className="h-3.5 w-3.5 text-emerald-500" /> This Mac</span>
                    <span style={{ color: runtime?.online ? "var(--mc-success)" : "var(--mc-text-muted)" }}>
                      {runtime?.online ? "Online" : "Offline"}
                    </span>
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: "var(--mc-text-muted)" }}>
                    Heartbeat: {formatRelativeSeen(runtime?.worker_seen_at)}
                  </div>
                </div>
                <div
                  className="rounded-[10px] p-3"
                  style={{
                    backgroundColor: "var(--mc-bg-tertiary)",
                    border: `1px solid ${runtime?.box_online ? "rgba(52, 199, 89, 0.35)" : "var(--mc-border-subtle)"}`,
                  }}
                >
                  <div className="flex items-center justify-between font-semibold" style={{ color: "var(--mc-text)" }}>
                    <span className="inline-flex items-center gap-1.5"><Server className="h-3.5 w-3.5 text-sky-500" /> Cloud Box (Docker)</span>
                    <span style={{ color: runtime?.box_online ? "var(--mc-success)" : "var(--mc-text-muted)" }}>
                      {runtime?.box_online ? "Online" : "Offline"}
                    </span>
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: "var(--mc-text-muted)" }}>
                    Heartbeat: {formatRelativeSeen(runtime?.box_seen_at)}
                  </div>
                </div>
              </div>
              <Code>{`# Option A — This Mac (uses your signed-in Grok subscription CLI)
./scripts/install-local-worker.sh

# Option B — Always-on Docker Cloud Box (see worker/BOX.md)
cd worker && docker build -t agentmail-box .`}</Code>
              <div className="pt-1">
                <button type="button" className="am-btn" onClick={() => onOpenTab("agents")}>
                  Open Agent Mailboxes &amp; Allowlist →
                </button>
              </div>
            </Block>

            {/* Option 2: API Key (xAI Cloud Q&A) */}
            <Block title="Option 2 — Connect via API Key (xAI Cloud Q&A)">
              <p>
                Pay-per-use API key inside Cloudflare Pages Functions. Answers questions from allowed senders immediately when your subscription worker is offline (locked to Q&amp;A only — never edits files).
              </p>
              <KeyConnectCard
                provider="xai"
                label="xAI API Key (Grok)"
                placeholder="xai-xxxxxxxxxxxxxxxxxxxxxxxxx"
                status={config?.providers.xai}
                helperLink={{ label: "Get xAI key →", href: "https://console.x.ai" }}
                onUpdated={refresh}
              />
              <Status tiles={tiles} ids={["chat"]} />
            </Block>
          </div>
        );
      })()}

      {/* ==================== PANEL: EXTRAS (PUSH + JUNK LLM) ==================== */}
      {panel === "extras" && (
        <div className="space-y-4">
          <Block title="Web Push Notifications (PWA)">
            <p>
              Get real-time desktop &amp; iPhone lock-screen alerts when new mail arrives — even with the browser closed.
            </p>
            <div
              className="rounded-[12px] p-3.5 space-y-3"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                border: "1px solid var(--mc-border-subtle)",
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                    This device push status
                  </div>
                  <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
                    {!push.supported
                      ? "Install as a PWA (Add to Dock / Home Screen) to enable push."
                      : push.enabled
                        ? "Subscribed and receiving notifications."
                        : "Push notifications are currently off on this device."}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {push.supported && (
                    <button
                      type="button"
                      onClick={() => void push.toggle()}
                      disabled={push.loading}
                      className="am-btn"
                    >
                      {push.loading ? "Working…" : push.enabled ? "Disable Push" : "Enable Push"}
                    </button>
                  )}
                  {push.enabled && (
                    <button type="button" onClick={() => void handleTestPush()} className="am-ghost">
                      Send Test
                    </button>
                  )}
                </div>
              </div>
              {pushTestMsg && <InlineFeedback ok={!pushTestMsg.includes("error")} text={pushTestMsg} />}
              <Status tiles={tiles} ids={["push"]} />
            </div>

            <Code>{`# Generate VAPID keys once for Cloudflare Pages secrets
npx web-push generate-vapid-keys --json
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
NEXT_PUBLIC_VAPID_PUBLIC_KEY=`}</Code>
          </Block>

          <Block title="AI Junk Filter (Optional)">
            <p>
              Built-in SPF/DKIM/heuristic filtering runs automatically. Plug in an OpenRouter key for LLM-assisted spam detection on unknown senders.
            </p>
            <KeyConnectCard
              provider="openrouter"
              label="OpenRouter API Key"
              placeholder="sk-or-v1-..."
              status={config?.providers.openrouter}
              helperLink={{ label: "Get OpenRouter key →", href: "https://openrouter.ai/keys" }}
              onUpdated={refresh}
            />
            <Status tiles={tiles} ids={["junk"]} />
          </Block>
        </div>
      )}

      {/* ==================== PANEL: PACKAGE & DEPLOY BUNDLE ==================== */}
      {panel === "deploy" && (
        <div className="space-y-4">
          <Block title="Package & Share / 1-Click Cloudflare Pages Deploy">
            <p>
              Handing this app to someone else? They only need a free Supabase project + Cloudflare Pages deploy — everything else (Resend, Cloudflare DNS, domains, webhooks, xAI) connects right inside this Setup menu after first login.
            </p>

            <div
              className="rounded-[12px] p-3.5 space-y-3"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                border: "1px solid var(--mc-border-subtle)",
              }}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[11px] font-medium block mb-1" style={{ color: "var(--mc-text-muted)" }}>
                    Supabase Project URL (optional)
                  </label>
                  <input
                    value={envSupaUrl}
                    onChange={(e) => setEnvSupaUrl(e.target.value)}
                    placeholder="https://xxxxx.supabase.co"
                    className="w-full rounded-[8px] px-2.5 py-1.5 text-[12.5px] focus:outline-none"
                    style={{
                      backgroundColor: "var(--mc-bg-elevated)",
                      border: "1px solid var(--mc-border)",
                      color: "var(--mc-text)",
                    }}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium block mb-1" style={{ color: "var(--mc-text-muted)" }}>
                    Owner Login Email (optional)
                  </label>
                  <input
                    value={envOwnerEmail}
                    onChange={(e) => setEnvOwnerEmail(e.target.value)}
                    placeholder="founder@company.com"
                    className="w-full rounded-[8px] px-2.5 py-1.5 text-[12.5px] focus:outline-none"
                    style={{
                      backgroundColor: "var(--mc-bg-elevated)",
                      border: "1px solid var(--mc-border)",
                      color: "var(--mc-text)",
                    }}
                  />
                </div>
              </div>

              <Code>{generatedEnvText}</Code>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={downloadEnvFile}
                  className="am-btn inline-flex items-center gap-1.5"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download .env.local
                </button>
                <a
                  href="/setup-migrations.sql"
                  download="setup-migrations.sql"
                  className="am-ghost inline-flex items-center gap-1.5 no-underline"
                >
                  <Database className="h-3.5 w-3.5" />
                  Download All-in-One SQL
                </a>
              </div>
            </div>

            <Code>{`# Deploy to Cloudflare Pages in 2 commands
npm install && npm run build
npx wrangler pages deploy out --project-name my-cloud-mail`}</Code>
          </Block>
        </div>
      )}

      <style>{SETUP_CSS}</style>
    </div>
  );
}

/* ==================== Reusable Plug-and-Play Key Connect Card ==================== */

function KeyConnectCard({
  provider,
  label,
  placeholder,
  status,
  helperLink,
  onUpdated,
  onZonesFound,
}: {
  provider: "resend" | "cloudflare" | "xai" | "openrouter";
  label: string;
  placeholder: string;
  status?: ProviderStatus;
  helperLink?: { label: string; href: string };
  onUpdated: () => Promise<void>;
  onZonesFound?: (zones: CloudflareZoneOption[]) => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const handleSave = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await apiFetch("/api/email/setup-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_key", provider, value: value.trim() }),
      });
      const data = await res.json();
      setFeedback({ ok: !!data.ok, text: data.detail || (data.ok ? "Connected & saved!" : "Verification failed") });
      if (data.ok) {
        setValue("");
        if (Array.isArray(data.zones)) onZonesFound?.(data.zones);
        await onUpdated();
      }
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setFeedback(null);
    try {
      const res = await apiFetch("/api/email/setup-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_key", provider }),
      });
      if (res.ok) {
        setFeedback({ ok: true, text: "Removed saved key (reverted to environment secret if set)." });
        await onUpdated();
      }
    } finally {
      setClearing(false);
    }
  };

  const sourceLabel =
    status?.source === "ui"
      ? "Saved in App"
      : status?.source === "env"
        ? "From Env Secret"
        : "Not connected";

  return (
    <div
      className="rounded-[12px] p-3.5 space-y-2.5"
      style={{
        backgroundColor: "var(--mc-bg-tertiary)",
        border: "1px solid var(--mc-border-subtle)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-semibold" style={{ color: "var(--mc-text)" }}>
            {label}
          </span>
          <span
            className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full"
            style={{
              backgroundColor: status?.configured ? "var(--mc-success-bg)" : "var(--mc-bg-hover)",
              color: status?.configured ? "var(--mc-success)" : "var(--mc-text-muted)",
            }}
          >
            {sourceLabel}
            {status?.preview ? ` · ${status.preview}` : ""}
          </span>
        </div>
        {helperLink && (
          <a
            href={helperLink.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11.5px] font-medium hover:underline"
            style={{ color: "var(--mc-accent)" }}
          >
            {helperLink.label}
          </a>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSave()}
          placeholder={status?.configured ? "Paste a new key to replace…" : placeholder}
          autoComplete="off"
          className="flex-1 min-w-0 rounded-[9px] px-3 py-2 text-[12.5px] font-mono focus:outline-none"
          style={{
            backgroundColor: "var(--mc-bg-elevated)",
            border: "1px solid var(--mc-border)",
            color: "var(--mc-text)",
          }}
        />
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !value.trim()}
            className="am-btn inline-flex items-center justify-center gap-1.5"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Test &amp; Connect
          </button>
          {status?.source === "ui" && (
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={clearing}
              className="am-ghost p-2"
              title="Remove saved app key"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {feedback && <InlineFeedback ok={feedback.ok} text={feedback.text} />}
    </div>
  );
}

function InlineFeedback({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-[9px] px-3 py-2 text-[12px]"
      style={{
        backgroundColor: ok ? "var(--mc-success-bg)" : "var(--mc-danger-bg)",
        color: ok ? "var(--mc-success)" : "var(--mc-danger)",
      }}
    >
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
      ) : (
        <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
      )}
      <span className="break-words">{text}</span>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 min-w-0">
      <h3 className="text-[15px] font-semibold tracking-[-0.015em]" style={{ color: "var(--mc-text)" }}>
        {title}
      </h3>
      <div className="space-y-3 text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>
        {children}
      </div>
    </div>
  );
}

function Status({ tiles, ids }: { tiles: Tile[]; ids: string[] }) {
  return (
    <ul className="space-y-1.5">
      {ids.map((id) => {
        const t = tileById(tiles, id);
        const ok = t?.ok;
        return (
          <li key={id} className="flex items-start gap-2 text-[12px]">
            {ok ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />
            ) : (
              <span
                className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 rounded-full border"
                style={{ borderColor: "var(--mc-border)" }}
              />
            )}
            <span className="min-w-0 break-words" style={{ color: "var(--mc-text)" }}>
              {TILE_META[id]?.label || id}
              {t?.detail ? <span style={{ color: "var(--mc-text-muted)" }}> — {t.detail}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    try {
      void navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="relative group">
      <pre className="am-setup-pre pr-16">{children}</pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-opacity opacity-80 hover:opacity-100"
        style={{
          backgroundColor: "rgba(255,255,255,0.1)",
          color: copied ? "#34C759" : "#E5E7EB",
        }}
        title="Copy snippet"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

const SETUP_CSS = `
  .am-btn { border:0; border-radius:9px; padding:7px 13px; background:var(--mc-accent); color:#fff; font-weight:600; font-size:12.5px; cursor:pointer; transition:filter 0.15s; }
  .am-btn:hover { filter:brightness(1.08); }
  .am-btn:disabled { opacity:0.45; cursor:not-allowed; }
  .am-ghost { background:transparent; color:var(--mc-text); border:1px solid var(--mc-border); border-radius:9px; padding:6px 11px; font-size:12px; font-weight:500; cursor:pointer; transition:background-color 0.15s; }
  .am-ghost:hover { background:var(--mc-bg-hover); }
  .am-setup-pre { margin:0; padding:11px 12px; border-radius:10px; background:#111827; color:#e5e7eb; font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; overflow-x:hidden; max-width:100%; }
`;
