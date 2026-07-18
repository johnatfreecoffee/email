"use client";

// Shown at the top of the settings body while the email_settings table
// doesn't exist yet. One copy-paste in the Supabase SQL editor fixes it.

import { useState } from "react";
import { TriangleAlert, Copy, Check, RefreshCw } from "lucide-react";
import { useSettings } from "@/lib/settings";

// Keep in sync with migrations/email-settings.sql + migrations/email-rules.sql
export const SETTINGS_MIGRATION_SQL = `-- Email app: settings sync + rules (paste once in the Supabase SQL editor)

CREATE TABLE IF NOT EXISTS email_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  priority INT NOT NULL DEFAULT 0,
  match_type TEXT NOT NULL DEFAULT 'all' CHECK (match_type IN ('all','any')),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  domain_id UUID REFERENCES email_domains(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_rules_active ON email_rules (is_active, priority);`;

export function MigrationNotice() {
  const { refetch } = useSettings();
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showSql, setShowSql] = useState(false);

  return (
    <div
      className="rounded-[10px] p-3 mb-4"
      style={{ backgroundColor: "rgba(255, 149, 0, 0.1)", border: "1px solid rgba(255, 149, 0, 0.3)" }}
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="h-4 w-4 flex-shrink-0 mt-0.5" style={{ color: "var(--mc-warning)" }} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium" style={{ color: "var(--mc-text)" }}>
            Settings sync isn&apos;t set up yet
          </div>
          <div className="text-[12px] mt-0.5 leading-4" style={{ color: "var(--mc-text-muted)" }}>
            Preferences are saved on this device only. Run this once in the Supabase SQL editor to
            enable sync everywhere (also enables Rules).
          </div>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(SETTINGS_MIGRATION_SQL);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium text-white"
              style={{ backgroundColor: "var(--mc-accent)" }}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy SQL"}
            </button>
            <button
              onClick={() => setShowSql((v) => !v)}
              className="px-2 py-1 rounded-md text-[12px]"
              style={{ color: "var(--mc-text-muted)" }}
            >
              {showSql ? "Hide" : "Show"} SQL
            </button>
            <button
              onClick={async () => {
                setChecking(true);
                await refetch();
                setChecking(false);
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px]"
              style={{ color: "var(--mc-text-muted)" }}
            >
              <RefreshCw className={`h-3 w-3 ${checking ? "animate-spin" : ""}`} />
              Re-check
            </button>
          </div>
          {showSql && (
            <pre
              className="mt-2 p-2.5 rounded-md text-[10px] leading-4 overflow-x-auto"
              style={{ backgroundColor: "var(--mc-bg)", color: "var(--mc-text-secondary)", border: "1px solid var(--mc-border)" }}
            >
              {SETTINGS_MIGRATION_SQL}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
