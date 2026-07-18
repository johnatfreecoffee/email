"use client";

import { useState } from "react";
import { usePush } from "@/lib/push-notifications";
import { apiFetch } from "@/lib/auth";
import { SettingsSection, SettingsRow, MCSwitch } from "./controls";

export function GeneralTab() {
  const push = usePush();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [bannerReset, setBannerReset] = useState(false);

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch("/api/email/push-test", { method: "POST" });
      const data = await res.json();
      setTestResult(data.success ? "Sent — check your notifications." : `Failed: ${data.error || "unknown error"}`);
    } catch (e) {
      setTestResult(`Error: ${(e as Error).message}`);
    }
    setTesting(false);
  };

  return (
    <div>
      <SettingsSection
        title="Notifications"
        footnote="Push alerts arrive even when the app is closed, on every device where notifications are enabled."
      >
        <SettingsRow
          label="Push notifications"
          description={push.supported ? undefined : "Not supported in this browser"}
          control={
            <MCSwitch checked={push.enabled} onCheckedChange={() => push.toggle()} disabled={!push.supported || push.loading} />
          }
        />
        <SettingsRow
          label="Send test notification"
          description={testResult ?? undefined}
          control={
            <button
              onClick={sendTest}
              disabled={!push.enabled || testing}
              className="px-2.5 py-1 rounded-md text-[12px] font-medium disabled:opacity-40"
              style={{ backgroundColor: "var(--mc-bg-elevated)", color: "var(--mc-text)", border: "1px solid var(--mc-border)" }}
            >
              {testing ? "Sending…" : "Send Test"}
            </button>
          }
        />
        <SettingsRow
          label="Notification prompts"
          description="Show the enable-notifications banner again if it was dismissed"
          last
          control={
            <button
              onClick={() => {
                try { localStorage.removeItem("mc-push-banner-dismissed"); } catch {}
                setBannerReset(true);
                setTimeout(() => setBannerReset(false), 1500);
              }}
              className="px-2.5 py-1 rounded-md text-[12px] font-medium"
              style={{ backgroundColor: "var(--mc-bg-elevated)", color: "var(--mc-text)", border: "1px solid var(--mc-border)" }}
            >
              {bannerReset ? "Done" : "Reset"}
            </button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Mailbox behavior">
        <SettingsRow
          label="Check for new messages"
          control={<span className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>Every 30 seconds while open</span>}
        />
        <SettingsRow
          label="Recount unread"
          last
          control={<span className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>Every minute</span>}
        />
      </SettingsSection>
    </div>
  );
}
