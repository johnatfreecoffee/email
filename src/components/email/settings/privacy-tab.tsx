"use client";

import { useSettings } from "@/lib/settings";
import { SettingsSection, SettingsRow, MCSwitch } from "./controls";

export function PrivacyTab() {
  const { settings, updateSetting } = useSettings();

  return (
    <SettingsSection
      title="Remote content"
      footnote="Remote images can report when and where you opened a message. When blocked, images and other remote content load only when you click Load Remote Content in the message."
    >
      <SettingsRow
        label="Block remote content"
        last
        control={
          <MCSwitch
            checked={settings.privacy.blockRemoteContent}
            onCheckedChange={(next) => updateSetting("privacy", { blockRemoteContent: next })}
          />
        }
      />
    </SettingsSection>
  );
}
