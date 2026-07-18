"use client";

// Placeholder shell — replaced with the live rules list when the rules
// engine lands (email_rules + /api/email/rules).

import { ListFilter } from "lucide-react";

export function RulesTab() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <ListFilter className="h-8 w-8 mb-3" style={{ color: "var(--mc-text-ghost)" }} />
      <div className="text-[13px] font-medium" style={{ color: "var(--mc-text-secondary)" }}>
        No rules yet
      </div>
      <div className="text-[12px] mt-1 max-w-[300px] leading-4" style={{ color: "var(--mc-text-muted)" }}>
        Rules run on incoming mail — file, flag, mark read, or junk messages automatically.
      </div>
      <button
        disabled
        title="Coming right up — rules engine ships in this release"
        className="mt-4 px-3 py-1.5 rounded-md text-[12px] font-medium text-white opacity-40"
        style={{ backgroundColor: "var(--mc-accent)" }}
      >
        Add Rule
      </button>
    </div>
  );
}
