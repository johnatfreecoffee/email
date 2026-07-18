"use client";

// Apple Mail Accounts pane: domain list on the left, detail on the right.

import { useState, useEffect } from "react";
import { Plus, Minus } from "lucide-react";
import type { EmailDomain } from "../email-layout";
import { DomainAccountDetail } from "../domain-account-detail";
import { DomainSetupCard } from "../domain-setup";

function healthDot(d: EmailDomain): string {
  const status = d.status?.toLowerCase() || "";
  if (status === "failed" || status === "error") return "var(--mc-danger)";
  if (status === "pending" || status === "not_started") return "var(--mc-warning)";
  if (["active", "verified", "dns_configured"].includes(status)) return "var(--mc-success)";
  return "var(--mc-text-faint)";
}

export function AccountsTab({
  domains,
  initialDomainId,
  onRefreshDomains,
}: {
  domains: EmailDomain[];
  initialDomainId?: string | null;
  onRefreshDomains: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialDomainId ?? domains[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const [jumpToDanger, setJumpToDanger] = useState(false);

  // Keep a valid selection as domains arrive/leave
  useEffect(() => {
    if (adding) return;
    if (!selectedId || !domains.some((d) => d.id === selectedId)) {
      setSelectedId(domains[0]?.id ?? null);
    }
  }, [domains, selectedId, adding]);

  const selected = domains.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="flex flex-col md:flex-row gap-3 h-full min-h-[360px]">
      {/* Account rail */}
      <div
        className="md:w-[210px] flex-shrink-0 flex md:flex-col rounded-[10px] overflow-hidden"
        style={{ backgroundColor: "var(--mc-bg-tertiary)" }}
      >
        <div className="flex-1 overflow-y-auto md:max-h-none max-h-[120px] flex md:block overflow-x-auto">
          {domains.map((d) => {
            const active = !adding && d.id === selectedId;
            return (
              <button
                key={d.id}
                onClick={() => {
                  setAdding(false);
                  setJumpToDanger(false);
                  setSelectedId(d.id);
                }}
                className="w-auto md:w-full flex items-center gap-2 px-3 py-2 text-left flex-shrink-0"
                style={{
                  backgroundColor: active ? "var(--mc-sidebar-selected)" : "transparent",
                }}
              >
                <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: healthDot(d) }} />
                <span className="min-w-0">
                  <span className="block text-[13px] truncate" style={{ color: "var(--mc-text)" }}>{d.domain}</span>
                  <span className="block text-[10px] truncate" style={{ color: "var(--mc-text-faint)" }}>
                    {d.status || "unknown"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {/* +/- footer */}
        <div
          className="flex items-center gap-0.5 px-1.5 py-1 flex-shrink-0"
          style={{ borderTop: "1px solid var(--mc-border-subtle)" }}
        >
          <button
            onClick={() => setAdding(true)}
            className="p-1 rounded"
            style={{ color: "var(--mc-text-muted)" }}
            title="Add domain"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              if (selected) {
                setAdding(false);
                setJumpToDanger(true);
              }
            }}
            disabled={!selected}
            className="p-1 rounded disabled:opacity-30"
            style={{ color: "var(--mc-text-muted)" }}
            title="Remove selected domain"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {adding ? (
          <div className="flex justify-center">
            <DomainSetupCard
              onClose={() => setAdding(false)}
              onDomainAdded={() => {
                setAdding(false);
                onRefreshDomains();
              }}
            />
          </div>
        ) : selected ? (
          <DomainAccountDetail
            key={`${selected.id}:${jumpToDanger ? "danger" : "info"}`}
            domain={selected}
            initialSegment={jumpToDanger ? "danger" : "info"}
            onRefresh={onRefreshDomains}
            onDeleted={() => {
              setJumpToDanger(false);
              setSelectedId(null);
              onRefreshDomains();
            }}
          />
        ) : (
          <div className="py-12 text-center text-[13px]" style={{ color: "var(--mc-text-faint)" }}>
            No domains yet — click + to add one.
          </div>
        )}
      </div>
    </div>
  );
}
