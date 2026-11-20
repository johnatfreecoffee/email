"use client";

// macOS Sequoia System Settings-style window: two-pane sidebar + detail view
// on desktop (consistent dimensions across every tab), full-screen sheet with
// scrollable pill bar on mobile.

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
  Wrench,
  HelpCircle,
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
import { SetupTab } from "./setup-tab";
import { HowToTab } from "./howto-tab";

interface TabDef {
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
  tint: string; // Apple HIG icon badge color (no purple/violet/indigo)
}

const TAB_SECTIONS: Array<{ title: string; items: TabDef[] }> = [
  {
    title: "Workspace",
    items: [
      { id: "setup", label: "Setup", icon: Wrench, tint: "#007AFF" },
      { id: "accounts", label: "Accounts", icon: AtSign, tint: "#32ADE6" },
      { id: "agents", label: "Agents", icon: Bot, tint: "#34C759" },
      { id: "howto", label: "How it works", icon: HelpCircle, tint: "#64748B" },
    ],
  },
  {
    title: "Mail",
    items: [
      { id: "general", label: "General", icon: SlidersHorizontal, tint: "#64748B" },
      { id: "viewing", label: "Viewing", icon: Eye, tint: "#007AFF" },
      { id: "composing", label: "Composing", icon: PencilLine, tint: "#FF9500" },
      { id: "signatures", label: "Signatures", icon: Signature, tint: "#0EA5E9" },
      { id: "rules", label: "Rules", icon: ListFilter, tint: "#34C759" },
      { id: "junk", label: "Junk Mail", icon: AlertOctagon, tint: "#FF3B30" },
    ],
  },
  {
    title: "System",
    items: [
      { id: "appearance", label: "Appearance", icon: SunMoon, tint: "#007AFF" },
      { id: "privacy", label: "Privacy", icon: Hand, tint: "#FF9500" },
    ],
  },
];

const ALL_TABS: TabDef[] = TAB_SECTIONS.flatMap((s) => s.items);

export interface SettingsModalProps {
  initialTab?: SettingsTab;
  initialDomainId?: string | null;
  domains: EmailDomain[];
  onClose: () => void;
  onRefreshDomains: () => void;
  onLaunchWizard?: () => void;
}

export function SettingsModal({
  initialTab = "general",
  initialDomainId = null,
  domains,
  onClose,
  onRefreshDomains,
  onLaunchWizard,
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

  const activeDef = ALL_TABS.find((t) => t.id === activeTab);
  const activeLabel = activeDef?.label ?? "Settings";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-[2px]"
      style={{ backgroundColor: "var(--mc-modal-overlay)" }}
      onClick={onClose}
    >
      <div
        className="mc-window-sheet flex flex-col md:flex-row w-full h-full md:w-[min(960px,95vw)] md:h-[min(680px,90vh)] md:rounded-[14px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Desktop left sidebar — macOS Sequoia System Settings */}
        <aside
          className="hidden md:flex flex-col w-[220px] flex-shrink-0 select-none overflow-y-auto py-3 px-2.5"
          style={{
            backgroundColor: "var(--mc-sidebar-solid)",
            borderRight: "1px solid var(--mc-border)",
          }}
        >
          <div className="px-2 pb-2.5 mb-1 flex items-center justify-between">
            <span
              className="text-[13px] font-semibold tracking-[-0.01em]"
              style={{ color: "var(--mc-text)" }}
            >
              Settings
            </span>
          </div>

          <nav className="space-y-4">
            {TAB_SECTIONS.map((section) => (
              <div key={section.title}>
                <div
                  className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--mc-text-faint)" }}
                >
                  {section.title}
                </div>
                <div className="space-y-0.5">
                  {section.items.map((t) => {
                    const active = t.id === activeTab;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setActiveTab(t.id)}
                        className="w-full flex items-center gap-2.5 px-2 py-[6px] rounded-[7px] text-[13px] transition-colors text-left"
                        style={{
                          backgroundColor: active ? "var(--mc-sidebar-selected)" : "transparent",
                          color: active ? "var(--mc-sidebar-selected-text)" : "var(--mc-text-secondary)",
                          fontWeight: active ? 600 : 450,
                        }}
                        onMouseEnter={(e) => {
                          if (!active) e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          if (!active) e.currentTarget.style.backgroundColor = "transparent";
                        }}
                      >
                        <span
                          className="h-[22px] w-[22px] rounded-[6px] flex items-center justify-center flex-shrink-0"
                          style={{
                            backgroundColor: active ? "var(--mc-accent)" : `${t.tint}1F`,
                            color: active ? "#FFFFFF" : t.tint,
                          }}
                        >
                          <t.icon className="h-[13px] w-[13px]" strokeWidth={2} />
                        </span>
                        <span className="truncate">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        {/* Right detail pane (full width on mobile) */}
        <div
          className="flex-1 flex flex-col min-w-0 min-h-0"
          style={{ backgroundColor: "var(--mc-bg-elevated)" }}
        >
          {/* Header bar */}
          <div
            className="mc-glass-bar flex items-center justify-between px-4 md:px-5 h-[48px] flex-shrink-0"
            style={{ borderBottom: "1px solid var(--mc-border-subtle)" }}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {activeDef && (
                <span
                  className="hidden md:flex h-6 w-6 rounded-[7px] items-center justify-center flex-shrink-0"
                  style={{
                    backgroundColor: `${activeDef.tint}1F`,
                    color: activeDef.tint,
                  }}
                >
                  <activeDef.icon className="h-3.5 w-3.5" strokeWidth={2} />
                </span>
              )}
              <h2
                className="text-[15px] font-semibold tracking-[-0.015em] truncate"
                style={{ color: "var(--mc-text)" }}
              >
                {activeLabel}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: "var(--mc-text-muted)" }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Mobile horizontal pill bar */}
          <div
            className="flex md:hidden items-center gap-1 px-2.5 py-2 overflow-x-auto flex-shrink-0"
            style={{
              borderBottom: "1px solid var(--mc-border-subtle)",
              backgroundColor: "var(--mc-sidebar-solid)",
            }}
          >
            {ALL_TABS.map((t) => {
              const active = t.id === activeTab;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium flex-shrink-0 transition-colors"
                  style={{
                    backgroundColor: active ? "var(--mc-sidebar-selected)" : "transparent",
                    color: active ? "var(--mc-sidebar-selected-text)" : "var(--mc-text-secondary)",
                  }}
                >
                  <t.icon className="h-3.5 w-3.5" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>

          {/* Scrollable tab body */}
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            {needsMigration && <MigrationNotice />}
            {activeTab === "general" && <GeneralTab />}
            {activeTab === "accounts" && (
              <AccountsTab domains={domains} initialDomainId={initialDomainId} onRefreshDomains={onRefreshDomains} />
            )}
            {activeTab === "agents" && (
              <AgentsTab domains={domains} onRefreshDomains={onRefreshDomains} />
            )}
            {activeTab === "setup" && (
              <SetupTab
                domains={domains}
                onOpenTab={setActiveTab}
                onRefreshDomains={onRefreshDomains}
                onLaunchWizard={
                  onLaunchWizard
                    ? () => {
                        onClose();
                        onLaunchWizard();
                      }
                    : undefined
                }
              />
            )}
            {activeTab === "howto" && <HowToTab />}
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
    </div>
  );
}
