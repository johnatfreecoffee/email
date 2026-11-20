"use client";

import { useCallback, useEffect, useState } from "react";
import {
  X,
  Mail,
  Globe,
  Cloud,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  Webhook,
  Bell,
  Download,
  Wrench,
  Loader2,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  Check,
} from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { usePush } from "@/lib/push-notifications";
import type { EmailDomain } from "./email-layout";
import { DomainSetupCard, type CloudflareZoneOption } from "./domain-setup";

export const ONBOARDING_DISMISSED_KEY = "mc.email.onboardingDismissed";

export function isOnboardingDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissOnboarding(): void {
  try {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
  } catch {
    /* ignore */
  }
}

type StepId = "welcome" | "resend" | "domain" | "ready";

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: "welcome", label: "Welcome" },
  { id: "resend", label: "Mail Engine" },
  { id: "domain", label: "Your Domain" },
  { id: "ready", label: "Finish" },
];

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
  };
}

interface Tile {
  id: string;
  ok: boolean;
  configured: boolean;
  detail: string;
}

export function OnboardingWizard({
  open,
  domains,
  onClose,
  onRefreshDomains,
  onOpenSetupHub,
  onInstallApp,
  isStandalone,
}: {
  open: boolean;
  domains: EmailDomain[];
  onClose: () => void;
  onRefreshDomains: () => void;
  onOpenSetupHub: () => void;
  onInstallApp?: () => void;
  isStandalone?: boolean;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [config, setConfig] = useState<SetupConfigResponse | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [cfZones, setCfZones] = useState<CloudflareZoneOption[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(false);

  // Resend key form
  const [resendKey, setResendKey] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [resendFeedback, setResendFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Webhook 1-click form
  const defaultInboundUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/email/inbound`
      : "https://your-app.pages.dev/api/email/inbound";
  const [webhookUrl, setWebhookUrl] = useState(defaultInboundUrl);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookFeedback, setWebhookFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Cloudflare token form (optional)
  const [showCfInput, setShowCfInput] = useState(false);
  const [cfToken, setCfToken] = useState("");
  const [cfBusy, setCfBusy] = useState(false);
  const [cfFeedback, setCfFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const push = usePush();

  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const [cfgRes, setupRes] = await Promise.all([
        apiFetch("/api/email/setup-config"),
        apiFetch("/api/email/agent-setup"),
      ]);
      if (setupRes.ok) {
        const d = await setupRes.json();
        setTiles(d.tiles || []);
      }
      if (cfgRes.ok) {
        const cfg = (await cfgRes.json()) as SetupConfigResponse;
        setConfig(cfg);
        if (cfg.providers?.cloudflare?.configured) {
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
      /* non-fatal */
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStepIndex(0);
    setResendFeedback(null);
    setWebhookFeedback(null);
    setCfFeedback(null);
    void refreshStatus();
  }, [open, refreshStatus]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismissOnboarding();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const step = STEPS[stepIndex];
  const resendTile = tiles.find((t) => t.id === "resend");
  const inboundTile = tiles.find((t) => t.id === "inbound");
  const resendConnected = !!(config?.providers?.resend?.configured || resendTile?.ok);
  const inboundConnected = !!inboundTile?.ok;
  const cfConnected = !!config?.providers?.cloudflare?.configured;

  const handleClose = () => {
    dismissOnboarding();
    onClose();
  };

  async function saveResendKey() {
    if (!resendKey.trim()) return;
    setResendBusy(true);
    setResendFeedback(null);
    try {
      const res = await apiFetch("/api/email/setup-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_key",
          provider: "resend",
          value: resendKey.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setResendKey("");
        setResendFeedback({ ok: true, text: data.detail || "Resend verified & connected!" });
        await refreshStatus();
      } else {
        setResendFeedback({ ok: false, text: data.detail || data.error || "Could not verify key" });
      }
    } catch (err) {
      setResendFeedback({ ok: false, text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setResendBusy(false);
    }
  }

  async function provisionWebhook() {
    setWebhookBusy(true);
    setWebhookFeedback(null);
    try {
      const res = await apiFetch("/api/email/setup-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "provision_webhook", endpoint: webhookUrl.trim() }),
      });
      const data = await res.json();
      setWebhookFeedback({
        ok: !!data.ok,
        text: data.detail || (data.ok ? "Inbound webhook created!" : "Could not create webhook"),
      });
      if (data.ok) await refreshStatus();
    } catch (err) {
      setWebhookFeedback({ ok: false, text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setWebhookBusy(false);
    }
  }

  async function saveCloudflareToken() {
    if (!cfToken.trim()) return;
    setCfBusy(true);
    setCfFeedback(null);
    try {
      const res = await apiFetch("/api/email/setup-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_key",
          provider: "cloudflare",
          value: cfToken.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setCfToken("");
        setShowCfInput(false);
        setCfFeedback({ ok: true, text: data.detail || "Cloudflare connected!" });
        await refreshStatus();
      } else {
        setCfFeedback({ ok: false, text: data.detail || data.error || "Could not verify token" });
      }
    } catch (err) {
      setCfFeedback({ ok: false, text: err instanceof Error ? err.message : "Network error" });
    } finally {
      setCfBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-[3px]"
      style={{ backgroundColor: "var(--mc-modal-overlay)" }}
      onClick={handleClose}
    >
      <div
        className="mc-window-sheet w-full max-w-[600px] max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top bar with step progress dots */}
        <div
          className="mc-glass-bar flex items-center justify-between px-5 h-[52px] flex-shrink-0"
          style={{ borderBottom: "1px solid var(--mc-border-subtle)" }}
        >
          <div className="flex items-center gap-2">
            {STEPS.map((s, idx) => {
              const active = idx === stepIndex;
              const done = idx < stepIndex;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStepIndex(idx)}
                  className="flex items-center gap-1.5 text-[12px] transition-colors rounded-full px-2 py-0.5"
                  style={{
                    backgroundColor: active ? "var(--mc-accent-bg)" : "transparent",
                    color: active
                      ? "var(--mc-accent)"
                      : done
                        ? "var(--mc-text)"
                        : "var(--mc-text-muted)",
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  <span
                    className="h-[18px] w-[18px] rounded-full text-[10.5px] font-semibold flex items-center justify-center flex-shrink-0"
                    style={{
                      backgroundColor: done
                        ? "var(--mc-success)"
                        : active
                          ? "var(--mc-accent)"
                          : "var(--mc-bg-tertiary)",
                      color: done || active ? "#FFFFFF" : "var(--mc-text-muted)",
                    }}
                  >
                    {done ? <Check className="h-3 w-3" strokeWidth={2.5} /> : idx + 1}
                  </span>
                  <span className="hidden sm:inline">{s.label}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: "var(--mc-text-muted)" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
            title="Skip setup (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable step content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* ==================== STEP 1: WELCOME ==================== */}
          {step.id === "welcome" && (
            <div className="space-y-5">
              <div className="flex flex-col items-center text-center pt-1">
                <div
                  className="h-14 w-14 rounded-[16px] flex items-center justify-center mb-3.5"
                  style={{
                    background: "linear-gradient(145deg, #007AFF 0%, #32ADE6 100%)",
                    boxShadow: "0 8px 24px rgba(0, 122, 255, 0.28)",
                  }}
                >
                  <Mail className="h-7 w-7 text-white" strokeWidth={1.9} />
                </div>
                <h2
                  className="text-[20px] font-semibold tracking-[-0.02em]"
                  style={{ color: "var(--mc-text)" }}
                >
                  Welcome to Your Own Email
                </h2>
                <p
                  className="text-[13.5px] leading-relaxed mt-1.5 max-w-[440px]"
                  style={{ color: "var(--mc-text-muted)" }}
                >
                  Send and receive real, DKIM/SPF-verified email on any domain you own — in a fast
                  macOS-style inbox. Takes about 2 minutes to connect.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {[
                  {
                    icon: Mail,
                    tint: "#007AFF",
                    title: "1. Resend",
                    desc: "Handles sending & receiving with legit SPF/DKIM signing.",
                    done: resendConnected && inboundConnected,
                  },
                  {
                    icon: Cloud,
                    tint: "#FF9500",
                    title: "2. DNS (Auto or Manual)",
                    desc: "1-click Cloudflare auto-DNS, or copy 3 records anywhere.",
                    done: cfConnected,
                  },
                  {
                    icon: Globe,
                    tint: "#34C759",
                    title: "3. Your Domain",
                    desc: "Add unlimited addresses like you@yourdomain.com.",
                    done: domains.length > 0,
                  },
                ].map((item) => (
                  <div
                    key={item.title}
                    className="rounded-[12px] p-3.5 flex flex-col gap-2"
                    style={{
                      backgroundColor: "var(--mc-bg-tertiary)",
                      border: "1px solid var(--mc-border-subtle)",
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className="h-7 w-7 rounded-[8px] flex items-center justify-center"
                        style={{ backgroundColor: `${item.tint}1F`, color: item.tint }}
                      >
                        <item.icon className="h-4 w-4" strokeWidth={2} />
                      </span>
                      {item.done && (
                        <CheckCircle2 className="h-4 w-4" style={{ color: "var(--mc-success)" }} />
                      )}
                    </div>
                    <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                      {item.title}
                    </div>
                    <div className="text-[12px] leading-snug" style={{ color: "var(--mc-text-muted)" }}>
                      {item.desc}
                    </div>
                  </div>
                ))}
              </div>

              <div
                className="rounded-[10px] px-3.5 py-2.5 flex items-center gap-2.5 text-[12px]"
                style={{
                  backgroundColor: "var(--mc-accent-bg)",
                  color: "var(--mc-text-secondary)",
                }}
              >
                <ShieldCheck className="h-4 w-4 flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
                <span>
                  Your keys stay safely in your own Supabase database — never shared with any third
                  party, and you can change them anytime in <strong>Settings → Setup</strong>.
                </span>
              </div>
            </div>
          )}

          {/* ==================== STEP 2: RESEND + WEBHOOK ==================== */}
          {step.id === "resend" && (
            <div className="space-y-4">
              <div>
                <h2
                  className="text-[17px] font-semibold tracking-[-0.015em]"
                  style={{ color: "var(--mc-text)" }}
                >
                  Connect Resend (Your Mail Engine)
                </h2>
                <p className="text-[12.5px] mt-1 leading-relaxed" style={{ color: "var(--mc-text-muted)" }}>
                  Resend delivers your outgoing emails with proper DKIM &amp; SPF authentication and
                  forwards incoming mail straight to your inbox.
                </p>
              </div>

              {/* Card 1: Resend API key */}
              <div
                className="rounded-[12px] p-4 space-y-3"
                style={{
                  backgroundColor: "var(--mc-bg-tertiary)",
                  border: "1px solid var(--mc-border-subtle)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-7 w-7 rounded-[8px] flex items-center justify-center"
                      style={{ backgroundColor: "#007AFF1F", color: "#007AFF" }}
                    >
                      <Mail className="h-4 w-4" />
                    </span>
                    <div>
                      <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                        Resend API Key
                      </div>
                      <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
                        {resendConnected
                          ? `Connected (${config?.providers?.resend?.preview || "configured"})`
                          : "Create a free Full-Access key at resend.com/api-keys"}
                      </div>
                    </div>
                  </div>
                  {resendConnected ? (
                    <span
                      className="inline-flex items-center gap-1 text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full"
                      style={{ backgroundColor: "var(--mc-success-bg)", color: "var(--mc-success)" }}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                    </span>
                  ) : (
                    <a
                      href="https://resend.com/api-keys"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[12px] font-medium hover:underline"
                      style={{ color: "var(--mc-accent)" }}
                    >
                      Get key <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>

                <div className="flex gap-2">
                  <input
                    type="password"
                    value={resendKey}
                    onChange={(e) => setResendKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveResendKey();
                    }}
                    placeholder={resendConnected ? "Paste a new key to replace…" : "re_xxxxxxxxxxxxxxxxx"}
                    className="flex-1 min-w-0 px-3 py-2 text-[13px] font-mono rounded-lg focus:outline-none"
                    style={{
                      backgroundColor: "var(--mc-bg-elevated)",
                      border: "1px solid var(--mc-border)",
                      color: "var(--mc-text)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void saveResendKey()}
                    disabled={!resendKey.trim() || resendBusy}
                    className="px-3.5 py-2 rounded-lg text-[12.5px] font-semibold transition-all hover:brightness-110 disabled:opacity-45 flex items-center gap-1.5 flex-shrink-0"
                    style={{ backgroundColor: "var(--mc-accent)", color: "#FFFFFF" }}
                  >
                    {resendBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Verify &amp; Save
                  </button>
                </div>

                {resendFeedback && (
                  <div
                    className="flex items-center gap-2 text-[12px] px-3 py-2 rounded-lg"
                    style={{
                      backgroundColor: resendFeedback.ok
                        ? "var(--mc-success-bg)"
                        : "var(--mc-danger-bg)",
                      color: resendFeedback.ok ? "var(--mc-success)" : "var(--mc-danger)",
                    }}
                  >
                    {resendFeedback.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    )}
                    <span>{resendFeedback.text}</span>
                  </div>
                )}
              </div>

              {/* Card 2: 1-Click Inbound Webhook */}
              <div
                className="rounded-[12px] p-4 space-y-3"
                style={{
                  backgroundColor: "var(--mc-bg-tertiary)",
                  border: "1px solid var(--mc-border-subtle)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-7 w-7 rounded-[8px] flex items-center justify-center"
                      style={{ backgroundColor: "#32ADE61F", color: "#32ADE6" }}
                    >
                      <Webhook className="h-4 w-4" />
                    </span>
                    <div>
                      <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                        1-Click Inbound Receiving
                      </div>
                      <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
                        Tells Resend to push every incoming email straight into this app.
                      </div>
                    </div>
                  </div>
                  {inboundConnected && (
                    <span
                      className="inline-flex items-center gap-1 text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full"
                      style={{ backgroundColor: "var(--mc-success-bg)", color: "var(--mc-success)" }}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Active
                    </span>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    className="flex-1 min-w-0 px-3 py-2 text-[12px] font-mono rounded-lg focus:outline-none"
                    style={{
                      backgroundColor: "var(--mc-bg-elevated)",
                      border: "1px solid var(--mc-border)",
                      color: "var(--mc-text)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void provisionWebhook()}
                    disabled={!resendConnected || webhookBusy}
                    className="px-3.5 py-2 rounded-lg text-[12.5px] font-semibold transition-all hover:brightness-110 disabled:opacity-45 flex items-center justify-center gap-1.5 flex-shrink-0"
                    style={{
                      backgroundColor: inboundConnected ? "var(--mc-bg-elevated)" : "var(--mc-accent)",
                      color: inboundConnected ? "var(--mc-text)" : "#FFFFFF",
                      border: inboundConnected ? "1px solid var(--mc-border)" : "none",
                    }}
                  >
                    {webhookBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {inboundConnected ? "Verify Webhook" : "Connect in 1 Click"}
                  </button>
                </div>

                {webhookFeedback && (
                  <div
                    className="flex items-center gap-2 text-[12px] px-3 py-2 rounded-lg"
                    style={{
                      backgroundColor: webhookFeedback.ok
                        ? "var(--mc-success-bg)"
                        : "var(--mc-danger-bg)",
                      color: webhookFeedback.ok ? "var(--mc-success)" : "var(--mc-danger)",
                    }}
                  >
                    {webhookFeedback.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    )}
                    <span>{webhookFeedback.text}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ==================== STEP 3: CLOUDFLARE (OPT) + DOMAIN ==================== */}
          {step.id === "domain" && (
            <div className="space-y-4">
              <div>
                <h2
                  className="text-[17px] font-semibold tracking-[-0.015em]"
                  style={{ color: "var(--mc-text)" }}
                >
                  Add Your Custom Domain
                </h2>
                <p className="text-[12.5px] mt-1 leading-relaxed" style={{ color: "var(--mc-text-muted)" }}>
                  Use Cloudflare for 1-click automatic DKIM, SPF &amp; MX setup — or type any domain
                  from Namecheap, GoDaddy, or Porkbun to get copy-paste DNS records.
                </p>
              </div>

              {/* Optional Cloudflare Auto-DNS strip */}
              <div
                className="rounded-[12px] p-3.5 space-y-2.5"
                style={{
                  backgroundColor: "var(--mc-bg-tertiary)",
                  border: "1px solid var(--mc-border-subtle)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="h-7 w-7 rounded-[8px] flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: "#FF95001F", color: "#FF9500" }}
                    >
                      <Cloud className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-semibold truncate" style={{ color: "var(--mc-text)" }}>
                        Cloudflare Auto-DNS{" "}
                        <span className="font-normal" style={{ color: "var(--mc-text-muted)" }}>
                          (Optional)
                        </span>
                      </div>
                      <div className="text-[11.5px] truncate" style={{ color: "var(--mc-text-muted)" }}>
                        {cfConnected
                          ? `Connected · ${cfZones.length} domain${cfZones.length === 1 ? "" : "s"} discovered`
                          : "Writes SPF, DKIM & MX records automatically in 1 click"}
                      </div>
                    </div>
                  </div>

                  {cfConnected ? (
                    <span
                      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: "var(--mc-success-bg)", color: "var(--mc-success)" }}
                    >
                      <CheckCircle2 className="h-3 w-3" /> Auto-DNS On
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowCfInput((v) => !v)}
                      className="text-[12px] font-medium px-2.5 py-1 rounded-lg flex-shrink-0 transition-colors"
                      style={{
                        backgroundColor: "var(--mc-bg-elevated)",
                        border: "1px solid var(--mc-border)",
                        color: "var(--mc-text)",
                      }}
                    >
                      {showCfInput ? "Hide" : "Connect Cloudflare"}
                    </button>
                  )}
                </div>

                {showCfInput && !cfConnected && (
                  <div className="space-y-2 pt-1">
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={cfToken}
                        onChange={(e) => setCfToken(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveCloudflareToken();
                        }}
                        placeholder="Paste Cloudflare API Token (Zone:DNS:Edit)…"
                        className="flex-1 min-w-0 px-3 py-1.5 text-[12.5px] font-mono rounded-lg focus:outline-none"
                        style={{
                          backgroundColor: "var(--mc-bg-elevated)",
                          border: "1px solid var(--mc-border)",
                          color: "var(--mc-text)",
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void saveCloudflareToken()}
                        disabled={!cfToken.trim() || cfBusy}
                        className="px-3 py-1.5 rounded-lg text-[12px] font-semibold flex items-center gap-1.5 flex-shrink-0 disabled:opacity-45"
                        style={{ backgroundColor: "var(--mc-accent)", color: "#FFFFFF" }}
                      >
                        {cfBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                        Connect
                      </button>
                    </div>
                    <a
                      href="https://dash.cloudflare.com/profile/api-tokens"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11.5px] hover:underline"
                      style={{ color: "var(--mc-accent)" }}
                    >
                      Create an “Edit zone DNS” token on Cloudflare <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}

                {cfFeedback && (
                  <div
                    className="flex items-center gap-2 text-[12px] px-2.5 py-1.5 rounded-lg"
                    style={{
                      backgroundColor: cfFeedback.ok ? "var(--mc-success-bg)" : "var(--mc-danger-bg)",
                      color: cfFeedback.ok ? "var(--mc-success)" : "var(--mc-danger)",
                    }}
                  >
                    {cfFeedback.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    )}
                    <span>{cfFeedback.text}</span>
                  </div>
                )}
              </div>

              {/* Existing domains pill strip if any */}
              {domains.length > 0 && (
                <div
                  className="rounded-[10px] px-3.5 py-2.5 flex flex-wrap items-center gap-2"
                  style={{
                    backgroundColor: "var(--mc-success-bg)",
                    border: "1px solid var(--mc-border-subtle)",
                  }}
                >
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0" style={{ color: "var(--mc-success)" }} />
                  <span className="text-[12px] font-medium" style={{ color: "var(--mc-text)" }}>
                    Active domains:
                  </span>
                  {domains.map((d) => (
                    <span
                      key={d.id}
                      className="text-[11.5px] font-mono px-2 py-0.5 rounded-md"
                      style={{
                        backgroundColor: "var(--mc-bg-elevated)",
                        color: "var(--mc-text)",
                      }}
                    >
                      {d.domain}
                    </span>
                  ))}
                </div>
              )}

              {/* Embedded Domain Setup Wizard */}
              <DomainSetupCard
                embedded
                cloudflareZones={cfZones}
                onDomainAdded={() => {
                  onRefreshDomains();
                  void refreshStatus();
                }}
              />
            </div>
          )}

          {/* ==================== STEP 4: YOU'RE READY ==================== */}
          {step.id === "ready" && (
            <div className="space-y-4">
              <div className="flex flex-col items-center text-center pt-1">
                <div
                  className="h-12 w-12 rounded-[14px] flex items-center justify-center mb-3"
                  style={{ backgroundColor: "var(--mc-success-bg)", color: "var(--mc-success)" }}
                >
                  <Sparkles className="h-6 w-6" />
                </div>
                <h2
                  className="text-[19px] font-semibold tracking-[-0.02em]"
                  style={{ color: "var(--mc-text)" }}
                >
                  You&apos;re Ready to Roll
                </h2>
                <p
                  className="text-[13px] mt-1 max-w-[420px] leading-relaxed"
                  style={{ color: "var(--mc-text-muted)" }}
                >
                  {domains.length > 0
                    ? `Your inbox is wired up with ${domains.length} domain${domains.length === 1 ? "" : "s"}. Finish up with optional alerts or install as an app.`
                    : "You can jump straight into your inbox now and finish connecting a domain anytime in Settings → Setup."}
                </p>
              </div>

              {/* Optional finishing actions */}
              <div className="space-y-2">
                {push.supported && (
                  <div
                    className="rounded-[12px] px-4 py-3 flex items-center justify-between gap-3"
                    style={{
                      backgroundColor: "var(--mc-bg-tertiary)",
                      border: "1px solid var(--mc-border-subtle)",
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className="h-8 w-8 rounded-[9px] flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: "#007AFF1F", color: "#007AFF" }}
                      >
                        <Bell className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                          Instant Push Notifications
                        </div>
                        <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
                          Get notified on desktop &amp; phone the second new mail lands.
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void push.toggle()}
                      disabled={push.loading}
                      className="px-3 py-1.5 rounded-lg text-[12px] font-semibold flex-shrink-0 transition-colors"
                      style={{
                        backgroundColor: push.enabled ? "var(--mc-success-bg)" : "var(--mc-accent)",
                        color: push.enabled ? "var(--mc-success)" : "#FFFFFF",
                      }}
                    >
                      {push.loading ? "Working…" : push.enabled ? "Enabled ✓" : "Enable"}
                    </button>
                  </div>
                )}

                {onInstallApp && !isStandalone && (
                  <div
                    className="rounded-[12px] px-4 py-3 flex items-center justify-between gap-3"
                    style={{
                      backgroundColor: "var(--mc-bg-tertiary)",
                      border: "1px solid var(--mc-border-subtle)",
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className="h-8 w-8 rounded-[9px] flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: "#32ADE61F", color: "#32ADE6" }}
                      >
                        <Download className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                          Install as Mac / Phone App
                        </div>
                        <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
                          Runs in its own Dock window with badge counts and native feel.
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        handleClose();
                        onInstallApp();
                      }}
                      className="px-3 py-1.5 rounded-lg text-[12px] font-semibold flex-shrink-0 transition-colors"
                      style={{
                        backgroundColor: "var(--mc-bg-elevated)",
                        border: "1px solid var(--mc-border)",
                        color: "var(--mc-text)",
                      }}
                    >
                      Install App
                    </button>
                  </div>
                )}

                <div
                  className="rounded-[12px] px-4 py-3 flex items-center justify-between gap-3"
                  style={{
                    backgroundColor: "var(--mc-bg-tertiary)",
                    border: "1px solid var(--mc-border-subtle)",
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className="h-8 w-8 rounded-[9px] flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: "#34C7591F", color: "#34C759" }}
                    >
                      <Wrench className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                        AI Agents, SQL &amp; Advanced Setup
                      </div>
                      <div className="text-[11.5px]" style={{ color: "var(--mc-text-muted)" }}>
                        Connect AI email agents, export deploy bundles, or manage storage.
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      handleClose();
                      onOpenSetupHub();
                    }}
                    className="px-3 py-1.5 rounded-lg text-[12px] font-semibold flex-shrink-0 transition-colors"
                    style={{
                      backgroundColor: "var(--mc-bg-elevated)",
                      border: "1px solid var(--mc-border)",
                      color: "var(--mc-text)",
                    }}
                  >
                    Open Setup Hub
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer navigation */}
        <div
          className="mc-glass-bar flex items-center justify-between px-5 h-[56px] flex-shrink-0"
          style={{ borderTop: "1px solid var(--mc-border-subtle)" }}
        >
          <div>
            {stepIndex === 0 ? (
              <button
                type="button"
                onClick={handleClose}
                className="text-[12.5px] font-medium px-2.5 py-1.5 rounded-lg transition-colors"
                style={{ color: "var(--mc-text-muted)" }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                Skip for now
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-medium px-3 py-1.5 rounded-lg transition-colors"
                style={{ color: "var(--mc-text-secondary)" }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {loadingStatus && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--mc-text-faint)" }} />
            )}
            {stepIndex < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all hover:brightness-110 active:scale-[0.98]"
                style={{ backgroundColor: "var(--mc-accent)", color: "#FFFFFF" }}
              >
                {stepIndex === 0 ? "Start Quick Setup" : "Continue"}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleClose}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all hover:brightness-110 active:scale-[0.98]"
                style={{ backgroundColor: "var(--mc-accent)", color: "#FFFFFF" }}
              >
                Open My Inbox
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
