"use client";

import type { EmailDomain } from "../email-layout";
import { useSettings } from "@/lib/settings";
import { SettingsSection, SettingsRow, SegmentedControl, SelectRow } from "./controls";

export function ComposingTab({ domains }: { domains: EmailDomain[] }) {
  const { settings, updateSetting } = useSettings();
  const c = settings.composing;

  const addressOptions = [
    { value: "auto", label: "Address of selected mailbox" },
    ...domains.flatMap((d) =>
      (d.addresses || [])
        .filter((a) => a.is_active)
        .map((a) => ({ value: a.id, label: `${a.address}@${d.domain}` }))
    ),
  ];

  return (
    <div>
      <SettingsSection title="Sending">
        <SettingsRow
          label="Send new messages from"
          description="Replies keep using the address the message was sent to"
          last
          control={
            <SelectRow
              value={c.defaultAddressId ?? "auto"}
              onChange={(next) => updateSetting("composing", { defaultAddressId: next === "auto" ? null : next })}
              options={addressOptions}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Responding">
        <SettingsRow
          label="Place signature"
          last
          control={
            <SegmentedControl<"above" | "below">
              value={c.signaturePlacement}
              onChange={(next) => updateSetting("composing", { signaturePlacement: next })}
              options={[
                { value: "above", label: "Above quoted text" },
                { value: "below", label: "Below quoted text" },
              ]}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
