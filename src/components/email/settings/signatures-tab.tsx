"use client";

// Per-address rich-text signatures, auto-saved into settings.

import { useState, useMemo } from "react";
import { Check } from "lucide-react";
import type { EmailDomain } from "../email-layout";
import { useSettings } from "@/lib/settings";
import { RichEditor } from "../rich-editor";
import { MCSwitch } from "./controls";

export function SignaturesTab({ domains }: { domains: EmailDomain[] }) {
  const { settings, replaceSetting } = useSettings();
  const byAddressId = settings.signatures.byAddressId;

  const addresses = useMemo(
    () =>
      domains.flatMap((d) =>
        (d.addresses || [])
          .filter((a) => a.is_active)
          .map((a) => ({ id: a.id, email: `${a.address}@${d.domain}`, domain: d.domain }))
      ),
    [domains]
  );

  const [selectedId, setSelectedId] = useState<string | null>(addresses[0]?.id ?? null);
  const selected = addresses.find((a) => a.id === selectedId) ?? null;
  const sig = selectedId ? byAddressId[selectedId] : undefined;

  const save = (id: string, patch: Partial<{ html: string; enabled: boolean }>) => {
    const current = byAddressId[id] ?? { html: "", enabled: true };
    replaceSetting("signatures", {
      byAddressId: { ...byAddressId, [id]: { ...current, ...patch } },
    });
  };

  if (addresses.length === 0) {
    return (
      <div className="py-12 text-center text-[13px]" style={{ color: "var(--mc-text-faint)" }}>
        No sending addresses yet — add one under Accounts.
      </div>
    );
  }

  let lastDomain = "";

  return (
    <div className="flex gap-3 h-full min-h-[320px]">
      {/* Address rail */}
      <div
        className="w-[200px] flex-shrink-0 overflow-y-auto rounded-[10px] py-1"
        style={{ backgroundColor: "var(--mc-bg-tertiary)" }}
      >
        {addresses.map((a) => {
          const header = a.domain !== lastDomain ? a.domain : null;
          lastDomain = a.domain;
          const active = a.id === selectedId;
          const enabled = !!byAddressId[a.id]?.enabled && !!byAddressId[a.id]?.html;
          return (
            <div key={a.id}>
              {header && (
                <div className="px-2.5 pt-2 pb-0.5 text-[10px] font-semibold" style={{ color: "var(--mc-text-faint)" }}>
                  {header}
                </div>
              )}
              <button
                onClick={() => setSelectedId(a.id)}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-left"
                style={{
                  backgroundColor: active ? "var(--mc-sidebar-selected)" : "transparent",
                  color: active ? "var(--mc-text)" : "var(--mc-text-secondary)",
                }}
              >
                <span className="flex-1 min-w-0 truncate">{a.email}</span>
                {enabled && <Check className="h-3 w-3 flex-shrink-0" style={{ color: "var(--mc-accent)" }} />}
              </button>
            </div>
          );
        })}
      </div>

      {/* Editor */}
      {selected && (
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] truncate" style={{ color: "var(--mc-text-muted)" }}>
              Signature for <span style={{ color: "var(--mc-text)" }}>{selected.email}</span>
            </span>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-[11px]" style={{ color: "var(--mc-text-muted)" }}>Use signature</span>
              <MCSwitch
                checked={sig?.enabled ?? true}
                onCheckedChange={(next) => save(selected.id, { enabled: next })}
              />
            </div>
          </div>
          <div
            className="flex-1 min-h-[220px] rounded-[10px] overflow-hidden"
            style={{ backgroundColor: "var(--mc-bg)", border: "1px solid var(--mc-border)" }}
          >
            <RichEditor
              key={selected.id}
              initialContent={sig?.html ?? ""}
              placeholder="Type your signature…"
              onHtmlChange={(html) => save(selected.id, { html })}
              onTextChange={() => {}}
            />
          </div>
        </div>
      )}
    </div>
  );
}
