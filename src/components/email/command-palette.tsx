"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  SquarePen,
  Inbox,
  Send,
  FileEdit,
  Star,
  Archive,
  AlertOctagon,
  Trash2,
  Bot,
  Columns3,
  Settings,
  Wrench,
  PanelLeft,
  RefreshCw,
  Sun,
  Moon,
  Monitor,
  HelpCircle,
  AtSign,
  CornerDownLeft,
  Download,
  type LucideIcon,
} from "lucide-react";
import type { EmailDomain } from "./email-layout";
import type { SettingsTab } from "@/lib/settings";
import { useTheme } from "@/lib/theme";
import { AGENT_FOLDER, KANBAN_FOLDER, isAgentAddress } from "@/lib/agent-mail";
import { domainDisplayLabel } from "@/lib/domain-display";

interface CommandItem {
  id: string;
  section: "Actions" | "Mailboxes" | "Domains & Agents" | "Settings";
  label: string;
  subtitle?: string;
  shortcut?: string;
  icon: LucideIcon;
  keywords?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  domains,
  onCompose,
  onSelectFolder,
  onSelectDomainFolder,
  onOpenAgent,
  onOpenSettings,
  onToggleSidebar,
  onRefresh,
  onShowShortcuts,
  onInstallApp,
  onLaunchWizard,
}: {
  open: boolean;
  onClose: () => void;
  domains: EmailDomain[];
  onCompose: () => void;
  onSelectFolder: (folder: string) => void;
  onSelectDomainFolder: (domain: EmailDomain, folder: string) => void;
  onOpenAgent: (domain: EmailDomain, addressId: string | null) => void;
  onOpenSettings: (target?: { tab?: SettingsTab; domainId?: string }) => void;
  onToggleSidebar: () => void;
  onRefresh: () => void;
  onShowShortcuts: () => void;
  onInstallApp?: () => void;
  onLaunchWizard?: () => void;
}) {
  const { setPref } = useTheme();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    const out: CommandItem[] = [
      {
        id: "action:compose",
        section: "Actions",
        label: "Compose New Email",
        subtitle: "Open a new message window",
        shortcut: "C",
        icon: SquarePen,
        keywords: "write send draft new mail",
        run: onCompose,
      },
      {
        id: "action:refresh",
        section: "Actions",
        label: "Get New Mail",
        subtitle: "Refresh messages, domains, and unread counts",
        icon: RefreshCw,
        keywords: "sync check poll reload",
        run: onRefresh,
      },
      {
        id: "action:sidebar",
        section: "Actions",
        label: "Toggle Mailboxes Sidebar",
        subtitle: "Show or hide the left sidebar",
        shortcut: "⌘\\",
        icon: PanelLeft,
        keywords: "hide show collapse expand pane",
        run: onToggleSidebar,
      },
      {
        id: "action:kanban",
        section: "Actions",
        label: "Open Agent Kanban",
        subtitle: "Track live coding agent jobs and threads",
        icon: Columns3,
        keywords: "board jobs tasks agents",
        run: () => onSelectFolder(KANBAN_FOLDER),
      },
      ...(onLaunchWizard
        ? [
            {
              id: "action:onboarding-wizard",
              section: "Actions" as const,
              label: "Run Onboarding Wizard",
              subtitle: "Step-by-step guided setup for Resend, DNS & domain",
              icon: Wrench,
              keywords: "wizard onboarding welcome setup domain resend cloudflare",
              run: onLaunchWizard,
            },
          ]
        : []),
      ...(onInstallApp
        ? [
            {
              id: "action:install-pwa",
              section: "Actions" as const,
              label: "Install Desktop App (PWA)",
              subtitle: "Add Mail to your Mac Dock or Home Screen",
              icon: Download,
              keywords: "pwa dock app install desktop mac ios",
              run: onInstallApp,
            },
          ]
        : []),
      {
        id: "action:shortcuts",
        section: "Actions",
        label: "Keyboard Shortcuts",
        shortcut: "?",
        icon: HelpCircle,
        keywords: "keys hotkeys help",
        run: onShowShortcuts,
      },
      {
        id: "box:inbox",
        section: "Mailboxes",
        label: "All Inboxes",
        icon: Inbox,
        keywords: "mail unread",
        run: () => onSelectFolder("inbox"),
      },
      {
        id: "box:sent",
        section: "Mailboxes",
        label: "Sent",
        icon: Send,
        run: () => onSelectFolder("sent"),
      },
      {
        id: "box:drafts",
        section: "Mailboxes",
        label: "Drafts",
        icon: FileEdit,
        run: () => onSelectFolder("drafts"),
      },
      {
        id: "box:starred",
        section: "Mailboxes",
        label: "Flagged",
        icon: Star,
        keywords: "starred important",
        run: () => onSelectFolder("starred"),
      },
      {
        id: "box:archive",
        section: "Mailboxes",
        label: "Archive",
        icon: Archive,
        run: () => onSelectFolder("archive"),
      },
      {
        id: "box:spam",
        section: "Mailboxes",
        label: "Junk",
        icon: AlertOctagon,
        keywords: "spam",
        run: () => onSelectFolder("spam"),
      },
      {
        id: "box:trash",
        section: "Mailboxes",
        label: "Trash",
        icon: Trash2,
        keywords: "deleted bin",
        run: () => onSelectFolder("trash"),
      },
    ];

    for (const d of domains) {
      const label = domainDisplayLabel(d);
      const isImport = d.capabilities?.import_only === true;
      out.push({
        id: `domain:${d.id}`,
        section: "Domains & Agents",
        label: isImport ? `${label} — Import` : `${label} — Inbox`,
        subtitle: d.domain,
        icon: isImport ? Archive : AtSign,
        keywords: `${d.domain} ${label}`,
        run: () => onSelectDomainFolder(d, isImport ? "import" : "inbox"),
      });

      const agents = (d.addresses || []).filter((a) => a.is_active && isAgentAddress(a));
      if (agents.length > 0 && !isImport) {
        out.push({
          id: `agents:${d.id}`,
          section: "Domains & Agents",
          label: `All Agents — ${label}`,
          subtitle: `${agents.length} agent mailbox${agents.length === 1 ? "" : "es"}`,
          icon: Bot,
          keywords: `agent ai ${d.domain}`,
          run: () => onOpenAgent(d, null),
        });
        for (const a of agents) {
          out.push({
            id: `agent:${d.id}:${a.id}`,
            section: "Domains & Agents",
            label: a.display_name || a.address,
            subtitle: `${a.address}@${d.domain}`,
            icon: Bot,
            keywords: `agent ${a.address} ${d.domain}`,
            run: () => onOpenAgent(d, a.id),
          });
        }
      }
    }

    out.push(
      {
        id: "settings:setup",
        section: "Settings",
        label: "Setup & Connections",
        subtitle: "Resend, Supabase, Cloudflare, Worker status tiles",
        icon: Wrench,
        keywords: "connect resend cloudflare supabase tiles onboarding",
        run: () => onOpenSettings({ tab: "setup" }),
      },
      {
        id: "settings:accounts",
        section: "Settings",
        label: "Accounts & Domains",
        subtitle: "Add domains, DNS records, and addresses",
        icon: AtSign,
        keywords: "dns dkim spf mx domain",
        run: () => onOpenSettings({ tab: "accounts" }),
      },
      {
        id: "settings:agents",
        section: "Settings",
        label: "Agent Access & Mailboxes",
        subtitle: "Manage who can email your agents and permissions",
        icon: Bot,
        keywords: "allowlist grok worker permissions",
        run: () => onOpenSettings({ tab: "agents" }),
      },
      {
        id: "settings:general",
        section: "Settings",
        label: "Settings",
        subtitle: "General, Viewing, Composing, Rules, Privacy",
        icon: Settings,
        keywords: "preferences options config",
        run: () => onOpenSettings({ tab: "general" }),
      },
      {
        id: "theme:light",
        section: "Settings",
        label: "Theme: Light Mode",
        icon: Sun,
        keywords: "appearance bright",
        run: () => setPref("light"),
      },
      {
        id: "theme:dark",
        section: "Settings",
        label: "Theme: Dark Mode",
        icon: Moon,
        keywords: "appearance night",
        run: () => setPref("dark"),
      },
      {
        id: "theme:system",
        section: "Settings",
        label: "Theme: Match System",
        icon: Monitor,
        keywords: "appearance auto os",
        run: () => setPref("system"),
      }
    );

    return out;
  }, [
    domains,
    onCompose,
    onRefresh,
    onToggleSidebar,
    onShowShortcuts,
    onSelectFolder,
    onSelectDomainFolder,
    onOpenAgent,
    onOpenSettings,
    onInstallApp,
    onLaunchWizard,
    setPref,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 14);
    const terms = q.split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      const hay = `${item.label} ${item.subtitle || ""} ${item.keywords || ""} ${item.section}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [items, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const picked = filtered[activeIndex];
        if (picked) {
          onClose();
          picked.run();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, filtered, activeIndex, onClose]);

  if (!open) return null;

  // Group filtered items by section while preserving flat index for keyboard highlight
  const sections: Array<{ name: string; entries: Array<{ item: CommandItem; flatIndex: number }> }> = [];
  filtered.forEach((item, flatIndex) => {
    let group = sections.find((s) => s.name === item.section);
    if (!group) {
      group = { name: item.section, entries: [] };
      sections.push(group);
    }
    group.entries.push({ item, flatIndex });
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4"
      style={{ backgroundColor: "var(--mc-modal-overlay)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        className="mc-window-sheet w-full max-w-[540px] rounded-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "min(520px, 72vh)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Quick Switcher"
      >
        {/* Spotlight search input */}
        <div
          className="flex items-center gap-3 px-4 h-13 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--mc-border)" }}
        >
          <Search className="h-[18px] w-[18px] flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to mailbox, domain, agent, or action…"
            className="flex-1 bg-transparent text-[15px] focus:outline-none"
            style={{ color: "var(--mc-text)" }}
          />
          <kbd className="mc-kbd">Esc</kbd>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2.5">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-[13px]" style={{ color: "var(--mc-text-muted)" }}>
              No matching mailboxes or commands
            </div>
          ) : (
            sections.map((sec) => (
              <div key={sec.name}>
                <div
                  className="px-2.5 pb-1 text-[11px] font-semibold tracking-tight"
                  style={{ color: "var(--mc-text-faint)" }}
                >
                  {sec.name}
                </div>
                <div className="space-y-0.5">
                  {sec.entries.map(({ item, flatIndex }) => {
                    const active = flatIndex === activeIndex;
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseEnter={() => setActiveIndex(flatIndex)}
                        onClick={() => {
                          onClose();
                          item.run();
                        }}
                        className="w-full flex items-center gap-3 px-2.5 py-2 rounded-[9px] text-left transition-colors"
                        style={{
                          backgroundColor: active ? "var(--mc-selected-bg)" : "transparent",
                          color: active ? "var(--mc-selected-fg)" : "var(--mc-text)",
                        }}
                      >
                        <div
                          className="h-7 w-7 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{
                            backgroundColor: active ? "rgba(255,255,255,0.2)" : "var(--mc-bg-tertiary)",
                            color: active ? "#FFFFFF" : "var(--mc-accent)",
                          }}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium truncate">{item.label}</div>
                          {item.subtitle && (
                            <div
                              className="text-[11px] truncate"
                              style={{ color: active ? "rgba(255,255,255,0.78)" : "var(--mc-text-muted)" }}
                            >
                              {item.subtitle}
                            </div>
                          )}
                        </div>
                        {item.shortcut ? (
                          <kbd
                            className="px-1.5 py-0.5 rounded text-[11px] font-mono flex-shrink-0"
                            style={
                              active
                                ? { backgroundColor: "rgba(255,255,255,0.22)", color: "#FFFFFF" }
                                : {
                                    backgroundColor: "var(--mc-bg-tertiary)",
                                    color: "var(--mc-text-muted)",
                                    border: "1px solid var(--mc-border)",
                                  }
                            }
                          >
                            {item.shortcut}
                          </kbd>
                        ) : active ? (
                          <CornerDownLeft className="h-3.5 w-3.5 opacity-80 flex-shrink-0" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div
          className="flex items-center justify-between px-3.5 py-2 text-[11px] flex-shrink-0"
          style={{
            borderTop: "1px solid var(--mc-border)",
            backgroundColor: "var(--mc-sidebar-bg)",
            color: "var(--mc-text-faint)",
          }}
        >
          <span className="flex items-center gap-2">
            <span>↑↓ Navigate</span>
            <span>·</span>
            <span>↵ Select</span>
          </span>
          <span>⌘K Quick Switcher</span>
        </div>
      </div>
    </div>
  );
}
