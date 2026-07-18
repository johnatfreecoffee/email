"use client";

// Blocked / trusted sender management backed by email_sender_reputation.

import { useState, useEffect, useCallback } from "react";
import { Loader2, Trash2, ArrowLeftRight } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { SettingsSection, SegmentedControl } from "./controls";

interface SenderRow {
  from_address: string;
  verdict: "spam" | "trusted";
  spam_score: number | null;
  user_override: boolean;
  last_seen_at: string | null;
}

export function SenderLists() {
  const [verdict, setVerdict] = useState<"spam" | "trusted">("spam");
  const [rows, setRows] = useState<SenderRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (v: "spam" | "trusted") => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/email/senders?verdict=${v}&limit=100`);
      setRows(res.ok ? await res.json() : []);
    } catch {
      setRows([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load(verdict);
  }, [verdict, load]);

  const forget = async (addr: string) => {
    setRows((prev) => prev.filter((r) => r.from_address !== addr));
    await apiFetch(`/api/email/senders?from_address=${encodeURIComponent(addr)}`, { method: "DELETE" });
  };

  const flip = async (addr: string) => {
    const next = verdict === "spam" ? "trusted" : "spam";
    setRows((prev) => prev.filter((r) => r.from_address !== addr));
    await apiFetch("/api/email/senders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_address: addr, verdict: next }),
    });
  };

  return (
    <SettingsSection
      title="Senders"
      footnote='Managed automatically when you use Junk / Not Junk on a message. "Forget" clears the memory so the next message is classified fresh.'
    >
      <div className="px-3 pt-2.5 pb-1">
        <SegmentedControl<"spam" | "trusted">
          value={verdict}
          onChange={setVerdict}
          options={[
            { value: "spam", label: "Blocked" },
            { value: "trusted", label: "Trusted" },
          ]}
        />
      </div>
      <div className="max-h-[220px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--mc-accent)" }} />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-5 text-[12px] text-center" style={{ color: "var(--mc-text-faint)" }}>
            No {verdict === "spam" ? "blocked" : "trusted"} senders yet.
          </div>
        ) : (
          rows.map((r, i) => (
            <div
              key={r.from_address}
              className="flex items-center gap-2 px-3 py-1.5"
              style={{ borderBottom: i === rows.length - 1 ? "none" : "1px solid var(--mc-border-subtle)" }}
            >
              <span className="flex-1 min-w-0 truncate text-[12px]" style={{ color: "var(--mc-text-secondary)" }}>
                {r.from_address}
              </span>
              {r.user_override && (
                <span className="text-[9px] font-bold px-1 rounded flex-shrink-0" style={{ backgroundColor: "var(--mc-accent-bg)", color: "var(--mc-accent)" }}>
                  YOURS
                </span>
              )}
              <button
                onClick={() => flip(r.from_address)}
                className="p-1 rounded flex-shrink-0"
                style={{ color: "var(--mc-text-muted)" }}
                title={verdict === "spam" ? "Move to Trusted" : "Move to Blocked"}
              >
                <ArrowLeftRight className="h-3 w-3" />
              </button>
              <button
                onClick={() => forget(r.from_address)}
                className="p-1 rounded flex-shrink-0"
                style={{ color: "var(--mc-text-muted)" }}
                title="Forget this sender"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </SettingsSection>
  );
}
