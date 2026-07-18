"use client";

import { useState } from "react";
import {
  X,
  Globe,
  Check,
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

interface DomainSetupProps {
  onClose: () => void;
  onDomainAdded: () => void;
}

interface MxConflict {
  provider: string;
  existing_mx: Array<{ name: string; content: string; priority: number }>;
  suggested_subdomain: string | null;
}

type Step = "input" | "checking" | "conflict" | "configuring" | "done" | "error";

export function DomainSetup({ onClose, onDomainAdded }: DomainSetupProps) {
  const [domain, setDomain] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<MxConflict | null>(null);

  // Step 1: Check for MX conflicts before creating
  const handleCheck = async () => {
    if (!domain.trim()) return;

    setStep("checking");
    setError("");

    try {
      const res = await apiFetch("/api/email/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: domain.trim(), check_only: true }),
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
        // No conflict — go straight to creating
        await createDomain(domain.trim(), false);
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
        // If it's a conflict response (shouldn't happen with force, but safety net)
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

  // Use subdomain instead
  const handleUseSubdomain = () => {
    if (conflict?.suggested_subdomain) {
      setDomain(conflict.suggested_subdomain);
      setConflict(null);
      setStep("input");
    }
  };

  // Force replace existing MX
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

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-[500px] bg-card rounded-2xl border border-border shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-mc-teal" />
            <h2 className="text-[16px] font-semibold text-foreground">Add Email Domain</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          {/* INPUT STEP */}
          {step === "input" && (
            <div className="space-y-4">
              <p className="text-[13px] text-muted-foreground">
                Enter a domain you own. DNS records will be automatically configured.
              </p>

              <div>
                <label className="text-[12px] text-muted-foreground block mb-1.5">Domain</label>
                <input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="cleanenergyexperts.pro"
                  className="w-full bg-muted/40 border border-border rounded-lg px-3 py-2.5 text-[14px] text-foreground placeholder-[#4B5563] focus:outline-none focus:border-mc-teal transition-colors"
                  onKeyDown={(e) => e.key === "Enter" && handleCheck()}
                  autoFocus
                />
              </div>

              <div className="bg-mc-teal-glow border border-mc-teal-dim rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <Zap className="h-4 w-4 text-mc-teal mt-0.5 flex-shrink-0" />
                  <div className="text-[12px] text-muted-foreground">
                    <p className="font-medium text-mc-teal mb-1">What happens automatically:</p>
                    <ul className="space-y-0.5 list-disc pl-4">
                      <li>Checks for existing email (MX) records</li>
                      <li>Domain registered with Resend (sending + receiving)</li>
                      <li>SPF, DKIM, MX records pushed to Cloudflare DNS</li>
                      <li>Verification triggered automatically</li>
                    </ul>
                  </div>
                </div>
              </div>

              <button
                onClick={handleCheck}
                disabled={!domain.trim()}
                className="w-full py-2.5 rounded-lg bg-mc-teal text-white text-[14px] font-medium hover:brightness-110 disabled:opacity-50 transition-all"
              >
                Add Domain
              </button>
            </div>
          )}

          {/* CHECKING STEP */}
          {step === "checking" && (
            <div className="flex flex-col items-center py-8">
              <Loader2 className="h-8 w-8 text-mc-teal animate-spin mb-4" />
              <p className="text-[14px] text-foreground mb-1">Checking DNS...</p>
              <p className="text-[12px] text-muted-foreground">Looking for existing email records</p>
            </div>
          )}

          {/* MX CONFLICT STEP */}
          {step === "conflict" && conflict && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 py-2">
                <div className="h-10 w-10 rounded-full bg-[var(--mc-accent-bg-hover)] flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="h-5 w-5 text-mc-amber" />
                </div>
                <div>
                  <p className="text-[14px] font-medium text-foreground">Existing Email Detected</p>
                  <p className="text-[12px] text-mc-amber mt-0.5">{conflict.provider}</p>
                </div>
              </div>

              <div className="bg-[var(--mc-accent-bg-hover)] border border-[var(--mc-accent-bg-hover)] rounded-lg p-3 text-[12px] text-muted-foreground">
                <p className="mb-2">
                  <strong className="text-foreground">{domain}</strong> already has MX records pointing to{" "}
                  <strong className="text-mc-amber">{conflict.provider}</strong>. Adding Resend will conflict with your current email setup.
                </p>
                <div className="space-y-1 font-mono text-[11px] mt-2">
                  {conflict.existing_mx.map((mx, i) => (
                    <div key={i} className="bg-secondary rounded px-2 py-1">
                      MX {mx.priority} → {mx.content}
                    </div>
                  ))}
                </div>
              </div>

              <p className="text-[12px] text-muted-foreground">Choose how to proceed:</p>

              {/* Option 1: Use subdomain */}
              {conflict.suggested_subdomain && (
                <button
                  onClick={handleUseSubdomain}
                  className="w-full flex items-center gap-3 p-3 rounded-lg border border-mc-teal-dim bg-mc-teal-glow hover:bg-mc-teal-glow transition-all text-left group"
                >
                  <div className="h-9 w-9 rounded-lg bg-mc-teal-dim flex items-center justify-center flex-shrink-0">
                    <GitBranch className="h-4 w-4 text-mc-teal" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[13px] font-medium text-foreground">
                      Use subdomain instead
                      <span className="text-mc-teal ml-1.5 font-normal">← Recommended</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Set up <strong className="text-muted-foreground">{conflict.suggested_subdomain}</strong> — keeps {conflict.provider} working on the main domain
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-mc-teal transition-colors" />
                </button>
              )}

              {/* Option 2: Replace existing */}
              <button
                onClick={handleReplaceExisting}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-[rgba(255, 59, 48, 0.1)] bg-[rgba(255, 59, 48, 0.1)] hover:bg-[rgba(255, 59, 48, 0.1)] transition-all text-left group"
              >
                <div className="h-9 w-9 rounded-lg bg-[rgba(255, 59, 48, 0.1)] flex items-center justify-center flex-shrink-0">
                  <Replace className="h-4 w-4 text-mc-red" />
                </div>
                <div className="flex-1">
                  <p className="text-[13px] font-medium text-foreground">Replace existing MX records</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Removes {conflict.provider} records. All email for this domain will go through this app.
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-mc-red transition-colors" />
              </button>

              {/* Cancel */}
              <button
                onClick={onClose}
                className="w-full py-2 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {/* CONFIGURING STEP */}
          {step === "configuring" && (
            <div className="flex flex-col items-center py-8">
              <Loader2 className="h-8 w-8 text-mc-teal animate-spin mb-4" />
              <p className="text-[14px] text-foreground mb-1">Configuring...</p>
              <p className="text-[12px] text-muted-foreground">
                Setting up Resend → Pushing DNS → Verifying
              </p>
            </div>
          )}

          {/* DONE STEP */}
          {step === "done" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 py-2">
                <div className="h-10 w-10 rounded-full bg-[rgba(52, 199, 89, 0.12)] flex items-center justify-center">
                  <Check className="h-5 w-5 text-mc-green" />
                </div>
                <div>
                  <p className="text-[14px] font-medium text-foreground">Domain Added!</p>
                  <p className="text-[12px] text-muted-foreground">{result?.domain?.domain || domain}</p>
                </div>
              </div>

              {result?.mx_replaced && (
                <div className="bg-[var(--mc-accent-bg-hover)] border border-[var(--mc-accent-bg-hover)] rounded-lg p-3 text-[12px] text-muted-foreground">
                  ⚠️ Previous MX records were removed. All email for this domain now routes through this app.
                </div>
              )}

              {result?.dns_auto_configured ? (
                <div className="bg-[rgba(52, 199, 89, 0.12)] border border-[rgba(52, 199, 89, 0.12)] rounded-lg p-3 text-[12px] text-muted-foreground">
                  ✅ DNS records auto-configured via Cloudflare. Verification in progress — may take a few minutes.
                </div>
              ) : (
                <div className="bg-[var(--mc-accent-bg-hover)] border border-[var(--mc-accent-bg-hover)] rounded-lg p-3 text-[12px] text-muted-foreground">
                  ⚠️ Domain not found in your Cloudflare zones. Add these DNS records manually:
                  {result?.records && (
                    <div className="mt-2 space-y-1 font-mono text-[11px]">
                      {result.records.map((r: any, i: number) => (
                        <div key={i} className="bg-secondary rounded px-2 py-1">
                          {r.type} → {r.name}: {r.value}
                          {r.priority !== undefined && ` (priority: ${r.priority})`}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {result?.verifyResult && (
                <div className="text-[12px] text-muted-foreground">
                  Verification status:{" "}
                  <span className="font-medium text-mc-teal">{result.verifyResult.status}</span>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleVerify}
                  className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border border-border text-[13px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Re-verify
                </button>
                <button
                  onClick={onDomainAdded}
                  className="flex-1 py-2 rounded-lg bg-mc-teal text-white text-[13px] font-medium hover:brightness-110 transition-all"
                >
                  Done
                </button>
              </div>
            </div>
          )}

          {/* ERROR STEP */}
          {step === "error" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 py-2">
                <div className="h-10 w-10 rounded-full bg-[rgba(255, 59, 48, 0.1)] flex items-center justify-center">
                  <AlertCircle className="h-5 w-5 text-mc-red" />
                </div>
                <div>
                  <p className="text-[14px] font-medium text-foreground">Something went wrong</p>
                  <p className="text-[12px] text-mc-red">{error}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setStep("input");
                    setError("");
                  }}
                  className="flex-1 py-2 rounded-lg border border-border text-[13px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all"
                >
                  Try Again
                </button>
                <button
                  onClick={onClose}
                  className="flex-1 py-2 rounded-lg text-[13px] text-muted-foreground hover:text-foreground"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
