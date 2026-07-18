"use client";

import { useTheme, type ThemePref } from "@/lib/theme";
import { SettingsSection, SettingsRow, SegmentedControl } from "./controls";

export function AppearanceTab() {
  const { pref, setPref } = useTheme();

  return (
    <SettingsSection
      title="Theme — this device"
      footnote="Appearance follows each device separately; it doesn't sync."
    >
      <SettingsRow
        label="Appearance"
        last
        control={
          <SegmentedControl<ThemePref>
            value={pref}
            onChange={setPref}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        }
      />
    </SettingsSection>
  );
}
