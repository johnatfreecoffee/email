"use client";

// Apple Mail-style Settings window: centered card, icon toolbar of tabs
// across the top, scrollable body. Full-screen sheet on mobile.

import { useState, useEffect } from "react";
import {
  X,
  SlidersHorizontal,
  AtSign,
  AlertOctagon,
  SunMoon,
  Eye,
  PencilLine,
  Signature,
  ListFilter,
  Hand,
  Bot,
  type LucideIcon,
} from "lucide-react";
import type { EmailDomain } from "../email-layout";
import { useSettings, type SettingsTab } from "@/lib/settings";
import { MigrationNotice } from "./migration-notice";
import { GeneralTab } from "./general-tab";
import { AppearanceTab } from "./appearance-tab";
import { RulesTab } from "./rules-tab";
import { AccountsTab } from "./accounts-tab";
import { ViewingTab } from "./viewing-tab";
import { ComposingTab } from "./composing-tab";
import { SignaturesTab } from "./signatures-tab";
import { JunkTab } from "./junk-tab";
import { PrivacyTab } from "./privacy-tab";
import { AgentsTab } from "./agents-tab";

const TABS: Array<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "accounts", label: "Accounts", icon: AtSign },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "junk", label: "Junk Mail", icon: AlertOctagon },
  { id: "appearance", label: "Appearance", icon: SunMoon },
  { id: "viewing", label: "Viewing", icon: Eye },
  { id: "composing", label: "Composing", icon: PencilLine },
  { id: "signatures", label: "Signatures", icon: Signature },
  { id: "rules", label: "Rules", icon: ListFilter },
  { id: "privacy", label: "Privacy", icon: Hand },
];

export interface SettingsModalProps {
  initialTab?: SettingsTab;
  initialDomainId?: string | null;
  domains: EmailDomain[];
  onClose: () => void;
  onRefreshDomains: () => void;
}

export function SettingsModal({
  initialTab = "general",
  initialDomainId = null,
  domains,
  onClose,
  onRefreshDomains,
}: SettingsModalProps) {
  const { needsMigration } = useSettings();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const activeLabel = TABS.find((t) => t.id === activeTab)?.label ?? "Settings";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "var(--mc-modal-overlay)" }}
      onClick={onClose}
    >
      <div
        className={`flex flex-col w-full h-full md:rounded-xl overflow-hidden ${
          activeTab === "agents"
            ? "md:h-[min(760px,94vh)] md:w-[min(960px,96vw)]"
            : "md:h-[min(560px,90vh)] md:w-[min(720px,95vw)]"
        }`}
        style={{
          backgroundColor: "var(--mc-bg-elevated)",
          border: "1px solid var(--mc-border)",
          boxShadow: "var(--mc-shadow)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="relative flex items-center justify-center h-10 flex-shrink-0">
          <span className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
            {activeLabel}
          </span>
          <button
            onClick={onClose}
            className="absolute right-2 p-1.5 rounded-md transition-colors"
            style={{ color: "var(--mc-text-muted)" }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Icon toolbar */}
        <div
          className="flex items-start justify-start md:justify-center gap-0.5 px-2 pb-1.5 overflow-x-auto flex-shrink-0"
          style={{ borderBottom: "1px solid var(--mc-border)" }}
        >
          {TABS.map((t) => {
            const active = t.id === activeTab;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className="flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-lg transition-colors flex-shrink-0"
                style={{
                  backgroundColor: active ? "var(--mc-bg-active)" : "transparent",
                  color: active ? "var(--mc-accent)" : "var(--mc-text-secondary)",
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <t.icon className="h-[18px] w-[18px]" />
                <span className="text-[11px]">{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {needsMigration && <MigrationNotice />}
          {activeTab === "general" && <GeneralTab />}
          {activeTab === "accounts" && (
            <AccountsTab domains={domains} initialDomainId={initialDomainId} onRefreshDomains={onRefreshDomains} />
          )}
          {activeTab === "agents" && <AgentsTab />}
          {activeTab === "junk" && <JunkTab />}
          {activeTab === "appearance" && <AppearanceTab />}
          {activeTab === "viewing" && <ViewingTab />}
          {activeTab === "composing" && <ComposingTab domains={domains} />}
          {activeTab === "signatures" && <SignaturesTab domains={domains} />}
          {activeTab === "rules" && <RulesTab domains={domains} />}
          {activeTab === "privacy" && <PrivacyTab />}
        </div>
      </div>
    </div>
  );
}
