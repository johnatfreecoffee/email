"use client";

import { useSettings } from "@/lib/settings";
import { SettingsSection, SettingsRow, MCSwitch } from "./controls";
import { SenderLists } from "./sender-lists";

export function JunkTab() {
  const { settings, updateSetting } = useSettings();
  const j = settings.junk;

  return (
    <div>
      <SettingsSection
        title="Filtering"
        footnote="Applies to newly arriving mail from unknown senders. Senders you've marked as junk or not-junk keep your decision."
      >
        <SettingsRow
          label="Use AI to catch spam"
          description="Heuristics only when off"
          control={
            <MCSwitch checked={j.llmAssist} onCheckedChange={(next) => updateSetting("junk", { llmAssist: next })} />
          }
        />
        <SettingsRow
          label="Aggressiveness"
          description={`Messages scoring ${j.threshold.toFixed(2)} or higher go to Junk`}
          last
          control={
            <div className="flex items-center gap-2 w-[180px]">
              <span className="text-[10px]" style={{ color: "var(--mc-text-faint)" }}>Aggressive</span>
              <input
                type="range"
                min={0.5}
                max={0.9}
                step={0.05}
                // Lower threshold = more junk; render slider left-to-right as aggressive → relaxed
                value={j.threshold}
                onChange={(e) => updateSetting("junk", { threshold: parseFloat(e.target.value) })}
                className="flex-1 accent-[var(--mc-accent)]"
              />
              <span className="text-[10px]" style={{ color: "var(--mc-text-faint)" }}>Relaxed</span>
            </div>
          }
        />
      </SettingsSection>

      <SenderLists />
    </div>
  );
}
