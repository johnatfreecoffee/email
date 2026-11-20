"use client";

import { useEffect, useState } from "react";
import {
  X,
  Globe,
  Check,
  Copy,
  Loader2,
  AlertCircle,
  RefreshCw,
  Zap,
  AlertTriangle,
  ArrowRight,
  Replace,
  GitBranch,
} from "lucide-react";
import { apiFetch } from "@/lib/auth";

export interface CloudflareZoneOption {
  id: string;
  name: string;
  status?: string;
}

interface DomainSetupProps {
  onClose?: () => void;
  onDomainAdded: () => void;
  initialDomain?: string;
  cloudflareZones?: CloudflareZoneOption[];
  embedded?: boolean;
}

interface MxConflict {
  provider: string;
  existing_mx: Array<{ name: string; content: string; priority: number }>;
  suggested_subdomain: string | null;
}

type Step = "input" | "checking" | "conflict" | "configuring" | "done" | "error";

// Embeddable macOS Sequoia Domain Setup Wizard — used in Settings → Accounts
// and directly inside the plug-and-play Setup Hub.
export function DomainSetupCard({
  onClose,
  onDomainAdded,
  initialDomain = "",
  cloudflareZones = [],
  embedded = false,
}: DomainSetupProps) {
  const [domain, setDomain] = useState(initialDomain);
  const [step, setStep] = useState<Step>("input");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<MxConflict | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | "all" | null>(null);

  useEffect(() => {
    if (initialDomain) setDomain(initialDomain);
  }, [initialDomain]);

  // Step 1: Check for MX conflicts before creating
  const handleCheck = async (overrideDomain?: string) => {
    const target = (overrideDomain ?? domain).trim().toLowerCase();
    if (!target) return;
    if (overrideDomain) setDomain(target);

    setStep("checking");
    setError("");

    try {
      const res = await apiFetch("/api/email/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: target, check_only: true }),
      });

      const data = await res.json();

      if (data.has_conflict) {
        setConflict({
          provider: data.provider,
          existing_mx: data.existing_mx,
          suggested_subdomain: data.suggested_subdomain,
        });
        setStep("conflict");
      } else {
        await createDomain(target, false);
      }
    } catch (e: any) {
      setError(e.message || "Something went wrong");
      setStep("error");
    }
  };

  // Create the domain (with optional force replace)
  const createDomain = async (domainName: string, forceReplace: boolean) => {
    setStep("configuring");
    setError("");

    try {
      const res = await apiFetch("/api/email/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: domainName,
          force_replace_mx: forceReplace,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409 && data.conflict) {
          setConflict({
            provider: data.provider,
            existing_mx: data.existing_mx,
            suggested_subdomain: data.suggested_subdomain,
          });
          setStep("conflict");
          return;
        }
        throw new Error(data.error || data.message || "Failed to add domain");
      }

      setResult(data);
      setStep("done");
    } catch (e: any) {
      setError(e.message || "Something went wrong");
      setStep("error");
    }
  };

  const handleUseSubdomain = () => {
    if (conflict?.suggested_subdomain) {
      setDomain(conflict.suggested_subdomain);
      setConflict(null);
      setStep("input");
    }
  };

  const handleReplaceExisting = async () => {
    await createDomain(domain.trim(), true);
  };

  const handleVerify = async () => {
    if (!result?.domain) return;
    setStep("configuring");

    try {
      const res = await apiFetch("/api/email/domains-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain_id: result.domain.id,
          resend_domain_id: result.domain.resend_domain_id || result.resend_domain_id,
        }),
      });
      const data = await res.json();
      setResult((prev: any) => ({ ...prev, verifyResult: data }));
      setStep("done");
    } catch (e: any) {
      setError(e.message);
      setStep("error");
    }
  };

  const copyText = (text: string, key: number | "all") => {
    try {
      void navigator.clipboard.writeText(text);
      setCopiedIdx(key);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className={
        embedded
          ? "w-full rounded-[12px] overflow-hidden"
          : "w-full max-w-[520px] mc-window-sheet overflow-hidden"
      }
      style={
        embedded
          ? {
              backgroundColor: "var(--mc-bg-elevated)",
              border: "1px solid var(--mc-border)",
            }
          : undefined
      }
    >
      {/* Header */}
      <div
        className="mc-glass-bar flex items-center justify-between px-4 h-[46px]"
        style={{ borderBottom: "1px solid var(--mc-border-subtle)" }}
      >
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4" style={{ color: "var(--mc-accent)" }} />
          <h2 className="text-[14px] font-semibold tracking-[-0.015em]" style={{ color: "var(--mc-text)" }}>
            Add Email Domain
          </h2>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: "var(--mc-text-muted)" }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="p-4 sm:p-5">
        {/* INPUT STEP */}
        {step === "input" && (
          <div className="space-y-4">
            <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--mc-text-muted)" }}>
              Enter any domain you own. If it’s on Cloudflare, SPF/DKIM/MX records are pushed automatically; otherwise we give you clean copy-paste DNS records.
            </p>

            {/* 1-Click Cloudflare zone pills */}
            {cloudflareZones.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--mc-text-faint)" }}>
                  Your Cloudflare domains (1-click)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {cloudflareZones.map((z) => {
                    const selected = domain.trim().toLowerCase() === z.name.toLowerCase();
                    return (
                      <button
                        key={z.id}
                        type="button"
                        onClick={() => setDomain(z.name)}
                        className="px-2.5 py-1 rounded-full text-[12px] font-medium transition-colors"
                        style={{
                          backgroundColor: selected ? "var(--mc-accent)" : "var(--mc-bg-tertiary)",
                          color: selected ? "#FFFFFF" : "var(--mc-text)",
                          border: `1px solid ${selected ? "var(--mc-accent)" : "var(--mc-border)"}`,
                        }}
                      >
                        {z.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <label className="text-[11.5px] font-medium block mb-1.5" style={{ color: "var(--mc-text-muted)" }}>
                Domain name
              </label>
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="yourdomain.com"
                className="w-full rounded-[10px] px-3.5 py-2.5 text-[14px] focus:outline-none transition-colors"
                style={{
                  backgroundColor: "var(--mc-bg-tertiary)",
                  border: "1px solid var(--mc-border)",
                  color: "var(--mc-text)",
                }}
                onKeyDown={(e) => e.key === "Enter" && handleCheck()}
                autoFocus={!embedded}
              />
            </div>

            <div
              className="rounded-[10px] p-3"
              style={{
                backgroundColor: "var(--mc-accent-bg)",
                border: "1px solid var(--mc-border-subtle)",
              }}
            >
              <div className="flex items-start gap-2">
                <Zap className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
                <div className="text-[12px]" style={{ color: "var(--mc-text-secondary)" }}>
                  <p className="font-semibold mb-1" style={{ color: "var(--mc-accent)" }}>
                    Automated setup pipeline:
                  </p>
                  <ul className="space-y-0.5 list-disc pl-4">
                    <li>Checks for existing email (MX) records so nothing breaks</li>
                    <li>Registers domain with Resend for both sending + receiving</li>
                    <li>Auto-pushes SPF, DKIM &amp; MX records if on Cloudflare</li>
                    <li>Triggers DNS verification right away</li>
                  </ul>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleCheck()}
              disabled={!domain.trim()}
              className="w-full py-2.5 rounded-[10px] text-white text-[13.5px] font-semibold hover:brightness-110 active:scale-[0.99] disabled:opacity-45 transition-all"
              style={{ backgroundColor: "var(--mc-accent)" }}
            >
              Connect Domain
            </button>
          </div>
        )}

        {/* CHECKING STEP */}
        {step === "checking" && (
          <div className="flex flex-col items-center py-8">
            <Loader2 className="h-7 w-7 animate-spin mb-3" style={{ color: "var(--mc-accent)" }} />
            <p className="text-[14px] font-medium mb-1" style={{ color: "var(--mc-text)" }}>
              Checking DNS for {domain}…
            </p>
            <p className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
              Scanning for existing email providers
            </p>
          </div>
        )}

        {/* MX CONFLICT STEP */}
        {step === "conflict" && conflict && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 py-1">
              <div
                className="h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: "var(--mc-warning-bg)" }}
              >
                <AlertTriangle className="h-4 w-4" style={{ color: "var(--mc-warning)" }} />
              </div>
              <div>
                <p className="text-[14px] font-semibold" style={{ color: "var(--mc-text)" }}>
                  Existing Email Detected
                </p>
                <p className="text-[12px] mt-0.5" style={{ color: "var(--mc-warning)" }}>
                  {conflict.provider}
                </p>
              </div>
            </div>

            <div
              className="rounded-[10px] p-3 text-[12px]"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                border: "1px solid var(--mc-border-subtle)",
                color: "var(--mc-text-muted)",
              }}
            >
              <p className="mb-2">
                <strong style={{ color: "var(--mc-text)" }}>{domain}</strong> already has MX records pointing to{" "}
                <strong style={{ color: "var(--mc-warning)" }}>{conflict.provider}</strong>.
              </p>
              <div className="space-y-1 font-mono text-[11px] mt-2">
                {conflict.existing_mx.map((mx, i) => (
                  <div
                    key={i}
                    className="rounded px-2 py-1"
                    style={{ backgroundColor: "var(--mc-bg-elevated)", color: "var(--mc-text-secondary)" }}
                  >
                    MX {mx.priority} → {mx.content}
                  </div>
                ))}
              </div>
            </div>

            {conflict.suggested_subdomain && (
              <button
                type="button"
                onClick={handleUseSubdomain}
                className="w-full flex items-center gap-3 p-3 rounded-[10px] text-left transition-colors"
                style={{
                  backgroundColor: "var(--mc-accent-bg)",
                  border: "1px solid var(--mc-accent)",
                }}
              >
                <div
                  className="h-8 w-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: "var(--mc-accent)", color: "#fff" }}
                >
                  <GitBranch className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                    Use subdomain instead <span style={{ color: "var(--mc-accent)" }}>· Recommended</span>
                  </p>
                  <p className="text-[11.5px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
                    Set up <strong style={{ color: "var(--mc-text)" }}>{conflict.suggested_subdomain}</strong> — keeps {conflict.provider} working
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
              </button>
            )}

            <button
              type="button"
              onClick={handleReplaceExisting}
              className="w-full flex items-center gap-3 p-3 rounded-[10px] text-left transition-colors"
              style={{
                backgroundColor: "var(--mc-danger-bg)",
                border: "1px solid rgba(255, 59, 48, 0.25)",
              }}
            >
              <div
                className="h-8 w-8 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: "rgba(255, 59, 48, 0.16)", color: "var(--mc-red)" }}
              >
                <Replace className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                  Replace existing MX records
                </p>
                <p className="text-[11.5px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
                  Removes {conflict.provider} records so all email routes through this app.
                </p>
              </div>
              <ArrowRight className="h-4 w-4 flex-shrink-0" style={{ color: "var(--mc-red)" }} />
            </button>

            <button
              type="button"
              onClick={() => {
                setConflict(null);
                setStep("input");
              }}
              className="w-full py-2 text-[12.5px] transition-colors"
              style={{ color: "var(--mc-text-muted)" }}
            >
              Back
            </button>
          </div>
        )}

        {/* CONFIGURING STEP */}
        {step === "configuring" && (
          <div className="flex flex-col items-center py-8">
            <Loader2 className="h-7 w-7 animate-spin mb-3" style={{ color: "var(--mc-accent)" }} />
            <p className="text-[14px] font-medium mb-1" style={{ color: "var(--mc-text)" }}>
              Configuring {domain}…
            </p>
            <p className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
              Registering on Resend → Pushing DNS → Verifying
            </p>
          </div>
        )}

        {/* DONE STEP */}
        {step === "done" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 py-1">
              <div
                className="h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: "var(--mc-success-bg)" }}
              >
                <Check className="h-4 w-4" style={{ color: "var(--mc-success)" }} />
              </div>
              <div>
                <p className="text-[14px] font-semibold" style={{ color: "var(--mc-text)" }}>
                  Domain Connected!
                </p>
                <p className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
                  {result?.domain?.domain || domain}
                </p>
              </div>
            </div>

            {result?.mx_replaced && (
              <div
                className="rounded-[10px] p-3 text-[12px]"
                style={{ backgroundColor: "var(--mc-warning-bg)", color: "var(--mc-text)" }}
              >
                Previous MX records were replaced. All email for this domain now routes through this app.
              </div>
            )}

            {result?.dns_auto_configured ? (
              <div
                className="rounded-[10px] p-3 text-[12px]"
                style={{
                  backgroundColor: "var(--mc-success-bg)",
                  border: "1px solid rgba(52, 199, 89, 0.25)",
                  color: "var(--mc-text)",
                }}
              >
                DNS records (MX, SPF, DKIM) were pushed to Cloudflare automatically. Verification usually completes within 1–3 minutes.
              </div>
            ) : (
              <div
                className="rounded-[10px] p-3 space-y-2.5 text-[12px]"
                style={{
                  backgroundColor: "var(--mc-bg-tertiary)",
                  border: "1px solid var(--mc-border-subtle)",
                  color: "var(--mc-text-muted)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium" style={{ color: "var(--mc-text)" }}>
                    Add these DNS records at your registrar:
                  </span>
                  {Array.isArray(result?.records) && result.records.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const dump = result.records
                          .map((r: any) =>
                            `${r.type}\t${r.name || "@"}\t${r.value}${r.priority !== undefined ? `\t(priority ${r.priority})` : ""}`
                          )
                          .join("\n");
                        copyText(dump, "all");
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium"
                      style={{
                        backgroundColor: "var(--mc-bg-elevated)",
                        border: "1px solid var(--mc-border)",
                        color: copiedIdx === "all" ? "var(--mc-green)" : "var(--mc-text)",
                      }}
                    >
                      {copiedIdx === "all" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copiedIdx === "all" ? "Copied all" : "Copy all"}
                    </button>
                  )}
                </div>

                {Array.isArray(result?.records) && result.records.length > 0 && (
                  <div className="space-y-1.5">
                    {result.records.map((r: any, i: number) => (
                      <div
                        key={i}
                        className="rounded-lg px-2.5 py-2 flex items-start justify-between gap-2"
                        style={{
                          backgroundColor: "var(--mc-bg-elevated)",
                          border: "1px solid var(--mc-border-subtle)",
                        }}
                      >
                        <div className="min-w-0 font-mono text-[11px] space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <span
                              className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                              style={{ backgroundColor: "var(--mc-accent-bg)", color: "var(--mc-accent)" }}
                            >
                              {r.type}
                            </span>
                            <span className="truncate font-semibold" style={{ color: "var(--mc-text)" }}>
                              {r.name || "@"}
                            </span>
                            {r.priority !== undefined && (
                              <span style={{ color: "var(--mc-text-faint)" }}>pri {r.priority}</span>
                            )}
                          </div>
                          <div className="break-all" style={{ color: "var(--mc-text-secondary)" }}>
                            {r.value}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => copyText(String(r.value || ""), i)}
                          className="p-1.5 rounded-md flex-shrink-0 transition-colors"
                          style={{ color: copiedIdx === i ? "var(--mc-green)" : "var(--mc-text-muted)" }}
                          title="Copy value"
                        >
                          {copiedIdx === i ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {result?.verifyResult && (
              <div className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
                Verification status:{" "}
                <span className="font-semibold" style={{ color: "var(--mc-accent)" }}>
                  {result.verifyResult.status}
                </span>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleVerify}
                className="flex-1 flex items-center justify-center gap-2 py-2 rounded-[10px] text-[13px] font-medium transition-colors"
                style={{
                  border: "1px solid var(--mc-border)",
                  color: "var(--mc-text)",
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Verify DNS
              </button>
              <button
                type="button"
                onClick={onDomainAdded}
                className="flex-1 py-2 rounded-[10px] text-white text-[13px] font-semibold hover:brightness-110 transition-all"
                style={{ backgroundColor: "var(--mc-accent)" }}
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* ERROR STEP */}
        {step === "error" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 py-1">
              <div
                className="h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: "var(--mc-danger-bg)" }}
              >
                <AlertCircle className="h-4 w-4" style={{ color: "var(--mc-red)" }} />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold" style={{ color: "var(--mc-text)" }}>
                  Could not add domain
                </p>
                <p className="text-[12px] break-words" style={{ color: "var(--mc-red)" }}>
                  {error}
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setStep("input");
                  setError("");
                }}
                className="flex-1 py-2 rounded-[10px] text-[13px] font-medium"
                style={{ border: "1px solid var(--mc-border)", color: "var(--mc-text)" }}
              >
                Try Again
              </button>
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2 rounded-[10px] text-[13px]"
                  style={{ color: "var(--mc-text-muted)" }}
                >
                  Close
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
