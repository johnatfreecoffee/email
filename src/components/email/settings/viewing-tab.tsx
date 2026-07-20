"use client";

import { useSettings } from "@/lib/settings";
import { SettingsSection, SettingsRow, SegmentedControl, SelectRow, MCSwitch } from "./controls";

const MARK_READ_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "0", label: "Immediately" },
  { value: "1.5", label: "After 1.5 seconds" },
  { value: "3", label: "After 3 seconds" },
] as const;

export function ViewingTab() {
  const { settings, updateSetting } = useSettings();
  const v = settings.viewing;

  const markReadValue = v.markReadDelaySeconds === null ? "never" : String(v.markReadDelaySeconds);

  return (
    <div>
      <SettingsSection
        title="Message list — desktop"
        footnote="Mobile always uses the card list. Column sorting reorders the messages loaded so far."
      >
        <SettingsRow
          label="List style"
          control={
            <SegmentedControl<"stacked" | "columns">
              value={v.desktopView}
              onChange={(next) => updateSetting("viewing", { desktopView: next })}
              options={[
                { value: "stacked", label: "Stacked cards" },
                { value: "columns", label: "Columns" },
              ]}
            />
          }
        />
        <SettingsRow
          label="Preview lines"
          description="Lines of message preview under the subject (stacked view)"
          last
          control={
            <SegmentedControl<"1" | "2">
              value={String(v.previewLines) as "1" | "2"}
              onChange={(next) => updateSetting("viewing", { previewLines: next === "1" ? 1 : 2 })}
              options={[
                { value: "1", label: "1 line" },
                { value: "2", label: "2 lines" },
              ]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Reading">
        <SettingsRow
          label="Organize by conversation"
          description="Group replies into threads (like Apple Mail). Default on."
          control={
            <MCSwitch
              checked={v.threadConversations !== false}
              onCheckedChange={(next) => updateSetting("viewing", { threadConversations: next })}
            />
          }
        />
        <SettingsRow
          label="Mark messages as read"
          description="When a message is opened or focused"
          control={
            <SelectRow
              value={markReadValue}
              onChange={(next) =>
                updateSetting("viewing", { markReadDelaySeconds: next === "never" ? null : parseFloat(next) })
              }
              options={MARK_READ_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          }
        />
        <SettingsRow
          label="Show catch-all mail in Inbox"
          description="Fold catch-all messages into the regular inbox view"
          last
          control={
            <MCSwitch
              checked={v.showCatchAllInInbox}
              onCheckedChange={(next) => updateSetting("viewing", { showCatchAllInInbox: next })}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
