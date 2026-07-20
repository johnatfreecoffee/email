"use client";

import { useState } from "react";
import { usePush } from "@/lib/push-notifications";
import { apiFetch } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import { NOTIFICATION_SOUNDS, playNotificationSound } from "@/lib/notification-sound";
import { SettingsSection, SettingsRow, MCSwitch, SelectRow } from "./controls";

export function GeneralTab() {
  const push = usePush();
  const { settings, updateSetting } = useSettings();
  const notif = settings.notifications;
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
        title="Push notifications"
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
          label="Push for catch-all mail"
          description="When off, mail sent to a catch-all address won't push. Applies to all your devices."
          control={
            <MCSwitch
              checked={notif.pushCatchAll}
              onCheckedChange={(next) => updateSetting("notifications", { pushCatchAll: next })}
            />
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

      <SettingsSection
        title="Sound"
        footnote="Plays a short alert tone when new mail arrives while the app is open — no push required."
      >
        <SettingsRow
          label="Play sound for new mail"
          control={
            <MCSwitch
              checked={notif.soundOnNewEmail}
              onCheckedChange={(next) => {
                // Toggling on doubles as the gesture that unlocks audio.
                if (next) playNotificationSound(notif.sound);
                updateSetting("notifications", { soundOnNewEmail: next });
              }}
            />
          }
        />
        <SettingsRow
          label="Alert sound"
          last
          control={
            <div className="flex items-center gap-1.5">
              <SelectRow
                options={NOTIFICATION_SOUNDS}
                value={notif.sound}
                onChange={(next) => {
                  updateSetting("notifications", { sound: next });
                  playNotificationSound(next);
                }}
              />
              <button
                onClick={() => playNotificationSound(notif.sound)}
                className="px-2.5 py-1 rounded-md text-[12px] font-medium"
                style={{ backgroundColor: "var(--mc-bg-elevated)", color: "var(--mc-text)", border: "1px solid var(--mc-border)" }}
                title="Preview sound"
              >
                Play
              </button>
            </div>
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
