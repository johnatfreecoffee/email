"use client";

import {
  Inbox,
  Send,
  FileEdit,
  Star,
  Trash2,
  Archive,
  Plus,
  Pencil,
  RefreshCw,
  Settings,
  Bell,
  BellOff,
  Loader2,
  ChevronRight,
  ChevronDown,
  User,
  Bot,
  Shield,
  AlertOctagon,
  SunMoon,
  Sun,
  Moon,
  Monitor,
  Check,
  GripVertical,
  Minus,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns3,
  type LucideIcon,
} from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { useRef } from "react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import type { EmailDomain } from "./email-layout";
import { usePush } from "@/lib/push-notifications";
import { useTheme, type ThemePref } from "@/lib/theme";
import { useSettings, type SettingsTab } from "@/lib/settings";
import { type FavoriteRef, favKey } from "./favorites";
import { AGENT_FOLDER, KANBAN_FOLDER, isAgentAddress } from "@/lib/agent-mail";

interface UnreadCountsShape {
  domains: Record<string, number>;
  folders: Record<string, Record<string, number>>;
  totals: Record<string, number>;
}

interface FolderListProps {
  activeFolder: string;
  onFolderChange: (folder: string) => void;
  domains: EmailDomain[];
  selectedDomain: EmailDomain | null;
  onDomainChange: (domain: EmailDomain | null) => void;
  selectedAddress: string | null;
  onAddressChange: (addressId: string | null) => void;
  catchAllOnly?: boolean;
  onCatchAllToggle?: (domain: EmailDomain) => void;
  onAgentOpen?: (domain: EmailDomain, addressId: string | null) => void;
  unreadCount: number;
  draftsCount?: number;
  onCompose: () => void;
  onRefreshDomains: () => void;
  onOpenSettings: (target?: { tab?: SettingsTab; domainId?: string }) => void;
  /** Mobile: dismiss the hamburger-opened sidebar without picking anything. */
  onClose?: () => void;
  unreadCounts?: UnreadCountsShape;
}

const folderDefs = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: FileEdit },
  { id: "starred", label: "Flagged", icon: Star },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "spam", label: "Junk", icon: AlertOctagon },
  { id: "trash", label: "Trash", icon: Trash2 },
];

// Aggregate (cross-domain) favorite definitions
const aggregateDefs = [
  { id: "inbox", label: "All Inboxes", icon: Inbox },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: FileEdit },
  { id: "starred", label: "Flagged", icon: Star },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "spam", label: "Junk", icon: AlertOctagon },
  { id: "trash", label: "Trash", icon: Trash2 },
];

function getDomainHealthDot(d: EmailDomain): string {
  const status = d.status?.toLowerCase() || "";
  if (status === "failed" || status === "error") return "var(--mc-danger)";
  if (status === "pending" || status === "not_started") return "var(--mc-warning)";
  if (["active", "verified", "dns_configured"].includes(status)) return "var(--mc-success)";
  return "var(--mc-text-faint)";
}

function formatUpdated(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "Updated Just Now";
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    return m === 1 ? "Updated 1 min ago" : `Updated ${m} min ago`;
  }
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    return h === 1 ? "Updated 1 hour ago" : `Updated ${h} hours ago`;
  }
  return "Updated Earlier";
}

// ---------- Desktop sidebar row ----------

interface SidebarRowProps {
  icon: LucideIcon;
  label: string;
  count?: number;
  active?: boolean;
  depth?: 0 | 1;
  onClick?: () => void;
  title?: string;
  /** Rendered instead of the count (edit-mode pin/remove buttons). */
  trailing?: React.ReactNode;
  /** Small leading extra (drag handle in edit mode). */
  leading?: React.ReactNode;
  iconColor?: string;
}

function SidebarRow({
  icon: Icon,
  label,
  count,
  active = false,
  depth = 0,
  onClick,
  title,
  trailing,
  leading,
  iconColor,
}: SidebarRowProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-full flex items-center gap-2 h-7 rounded-md text-[13px] transition-colors group/row"
      style={{
        paddingLeft: depth === 1 ? "26px" : "8px",
        paddingRight: "8px",
        color: active ? "var(--mc-text)" : "var(--mc-text-secondary)",
        backgroundColor: active ? "var(--mc-sidebar-selected)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {leading}
      <Icon
        className="h-[15px] w-[15px] flex-shrink-0"
        style={{ color: iconColor || "var(--mc-accent)" }}
      />
      <span className="flex-1 text-left truncate">{label}</span>
      {trailing !== undefined
        ? trailing
        : typeof count === "number" && count > 0 && (
            <span
              className="text-[11px] font-semibold tabular-nums flex-shrink-0"
              style={{ color: "var(--mc-text-muted)" }}
            >
              {count}
            </span>
          )}
    </button>
  );
}

// ---------- iOS grouped list primitives (mobile) ----------

function IosGroup({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-[12px] overflow-hidden"
      style={{
        backgroundColor: "var(--mc-card)",
        boxShadow: "0 0.5px 0 rgba(0,0,0,0.04)",
      }}
    >
      {children}
    </div>
  );
}

interface IosRowProps {
  icon: LucideIcon;
  label: string;
  count?: number;
  active?: boolean;
  onClick?: () => void;
  showChevron?: boolean;
  /** Hide bottom hairline (last row) */
  last?: boolean;
  trailing?: React.ReactNode;
  iconColor?: string;
}

function IosRow({
  icon: Icon,
  label,
  count,
  active = false,
  onClick,
  showChevron = true,
  last = false,
  trailing,
  iconColor,
}: IosRowProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 pl-4 pr-3 relative active:opacity-70 transition-opacity"
      style={{
        minHeight: 48,
        backgroundColor: active ? "var(--mc-accent-bg)" : "transparent",
        color: "var(--mc-text)",
      }}
    >
      <Icon
        className="h-[22px] w-[22px] flex-shrink-0"
        strokeWidth={1.75}
        style={{ color: iconColor || "var(--mc-accent)" }}
      />
      <span className="flex-1 text-left text-[17px] truncate leading-tight">{label}</span>
      {trailing !== undefined ? (
        trailing
      ) : (
        <>
          {typeof count === "number" && count > 0 && (
            <span
              className="text-[17px] tabular-nums flex-shrink-0"
              style={{ color: "var(--mc-text-muted)" }}
            >
              {count}
            </span>
          )}
          {showChevron && (
            <ChevronRight
              className="h-[18px] w-[18px] flex-shrink-0 -mr-0.5"
              strokeWidth={2.25}
              style={{ color: "var(--mc-text-ghost)" }}
            />
          )}
        </>
      )}
      {/* Hairline inset separator */}
      {!last && (
        <span
          className="absolute bottom-0 right-0 pointer-events-none"
          style={{
            left: 50,
            height: "0.5px",
            backgroundColor: "var(--mc-border)",
          }}
        />
      )}
    </button>
  );
}

// ---------- Theme menu ----------

function ThemeMenu() {
  const { pref, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const options: { id: ThemePref; label: string; icon: LucideIcon }[] = [
    { id: "system", label: "System", icon: Monitor },
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
  ];

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-1.5 rounded-md transition-colors"
        style={{ color: open ? "var(--mc-accent)" : "var(--mc-text-muted)" }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
        title="Appearance"
      >
        <SunMoon className="h-4 w-4" />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-1 rounded-lg py-1 min-w-[130px] z-40"
          style={{
            backgroundColor: "var(--mc-bg-elevated)",
            border: "1px solid var(--mc-border)",
            boxShadow: "var(--mc-shadow)",
          }}
        >
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => { setPref(o.id); setOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] transition-colors"
              style={{ color: "var(--mc-text-secondary)" }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              <o.icon className="h-3.5 w-3.5" style={{ color: "var(--mc-text-muted)" }} />
              <span className="flex-1 text-left">{o.label}</span>
              {pref === o.id && <Check className="h-3.5 w-3.5" style={{ color: "var(--mc-accent)" }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Sidebar ----------

export function FolderList({
  activeFolder,
  onFolderChange,
  domains,
  selectedDomain,
  onDomainChange,
  selectedAddress,
  onAddressChange,
  catchAllOnly = false,
  onCatchAllToggle,
  onAgentOpen,
  unreadCount: _unreadCount,
  draftsCount = 0,
  onCompose,
  onRefreshDomains,
  onOpenSettings,
  onClose: _onClose,
  unreadCounts = { domains: {}, folders: {}, totals: {} },
}: FolderListProps) {
  const [refreshing, setRefreshing] = useState(false);
  const push = usePush();
  const [editing, setEditing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());
  const [expandedAgents, setExpandedAgents] = useState<string[]>([]);
  // Re-render periodically so "Updated Just Now" ages
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Roaming sidebar state (server-synced via the settings provider)
  const { settings, updateSetting, replaceSetting } = useSettings();
  const collapsedDomains = settings.sidebar.collapsedDomains;
  const favoritesVisible = settings.sidebar.favoritesVisible;
  const expandedAddresses = settings.sidebar.expandedAddresses;
  const favorites = settings.favorites.items;

  const updateFavorites = (next: FavoriteRef[]) => {
    replaceSetting("favorites", { v: 2, items: next });
  };

  // Prune favorites whose domain/address no longer exists (once domains load)
  useEffect(() => {
    if (domains.length === 0 || favorites.length === 0) return;
    const pruned = favorites.filter((ref) => {
      if (ref.kind === "folder") return true;
      const d = domains.find((x) => x.id === ref.domainId);
      if (!d) return false;
      if (ref.kind === "address") {
        return (d.addresses || []).some((a) => a.id === ref.addressId);
      }
      return true;
    });
    if (pruned.length !== favorites.length) {
      replaceSetting("favorites", { v: 2, items: pruned });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domains]);

  // Bump "Updated …" when counts refresh from parent
  useEffect(() => {
    setLastUpdated(Date.now());
  }, [unreadCounts]);

  const favoriteKeys = useMemo(() => new Set(favorites.map(favKey)), [favorites]);

  const isPinned = (ref: FavoriteRef) => favoriteKeys.has(favKey(ref));

  const togglePin = (ref: FavoriteRef) => {
    if (isPinned(ref)) {
      updateFavorites(favorites.filter((f) => favKey(f) !== favKey(ref)));
    } else {
      updateFavorites([...favorites, ref]);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    onRefreshDomains();
    setLastUpdated(Date.now());
    setTimeout(() => setRefreshing(false), 600);
  };

  const toggleDomainCollapse = (domainId: string) => {
    const next = collapsedDomains.includes(domainId)
      ? collapsedDomains.filter((id) => id !== domainId)
      : [...collapsedDomains, domainId];
    updateSetting("sidebar", { collapsedDomains: next });
  };

  // Addresses sub-list is collapsed by default (id absent from the set);
  // toggling adds/removes the domain id.
  const toggleAgents = (domainId: string) => {
    setExpandedAgents((prev) =>
      prev.includes(domainId) ? prev.filter((id) => id !== domainId) : [...prev, domainId]
    );
  };

  const toggleAddresses = (domainId: string) => {
    const next = expandedAddresses.includes(domainId)
      ? expandedAddresses.filter((id) => id !== domainId)
      : [...expandedAddresses, domainId];
    updateSetting("sidebar", { expandedAddresses: next });
  };

  const toggleFavorites = () => {
    updateSetting("sidebar", { favoritesVisible: !favoritesVisible });
  };

  // Collapse All / Expand All — "anything expanded" drives which action shows
  const anythingExpanded =
    favoritesVisible ||
    domains.some((d) => !collapsedDomains.includes(d.id)) ||
    expandedAddresses.length > 0;
  const collapseAll = () =>
    updateSetting("sidebar", {
      collapsedDomains: domains.map((d) => d.id),
      favoritesVisible: false,
      expandedAddresses: [],
    });
  const expandAll = () =>
    updateSetting("sidebar", {
      collapsedDomains: [],
      favoritesVisible: true,
      expandedAddresses: domains.map((d) => d.id),
    });

  const isAllSelected = selectedDomain === null;

  // Resolve one favorite ref into row props (null → skip: stale ref)
  const resolveFavorite = (ref: FavoriteRef): {
    icon: LucideIcon;
    label: string;
    count?: number;
    active: boolean;
    onClick: () => void;
  } | null => {
    switch (ref.kind) {
      case "folder": {
        const def = aggregateDefs.find((f) => f.id === ref.folder);
        if (!def) return null;
        const count = ref.folder === "drafts" ? draftsCount : unreadCounts.totals[ref.folder] ?? 0;
        return {
          icon: def.icon,
          label: def.label,
          count,
          active: isAllSelected && activeFolder === ref.folder && !catchAllOnly,
          onClick: () => {
            onDomainChange(null);
            onFolderChange(ref.folder);
          },
        };
      }
      case "domain-folder": {
        const d = domains.find((x) => x.id === ref.domainId);
        if (!d) return null;
        if (ref.folder === AGENT_FOLDER) {
          return {
            icon: Bot,
            label: ref.label?.trim() || `Agents — ${d.domain}`,
            active:
              selectedDomain?.id === d.id &&
              activeFolder === AGENT_FOLDER &&
              !selectedAddress &&
              !catchAllOnly,
            onClick: () => onAgentOpen?.(d, null),
          };
        }
        const def = folderDefs.find((f) => f.id === ref.folder);
        if (!def) return null;
        return {
          icon: def.icon,
          label: ref.label?.trim() || `${def.label} — ${d.domain}`,
          count: ref.folder === "drafts" ? 0 : unreadCounts.folders[d.id]?.[ref.folder] ?? 0,
          active:
            selectedDomain?.id === d.id &&
            activeFolder === ref.folder &&
            !selectedAddress &&
            !catchAllOnly,
          onClick: () => {
            if (selectedDomain?.id !== d.id) onDomainChange(d);
            onFolderChange(ref.folder);
          },
        };
      }
      case "address": {
        const d = domains.find((x) => x.id === ref.domainId);
        const addr = d?.addresses?.find((a) => a.id === ref.addressId);
        if (!d || !addr) return null;
        const agent = isAgentAddress(addr);
        return {
          icon: agent ? Bot : User,
          label: ref.label?.trim() || addr.display_name || `${addr.address}@${d.domain}`,
          active:
            selectedDomain?.id === d.id &&
            selectedAddress === addr.id &&
            !catchAllOnly &&
            (!agent || activeFolder === AGENT_FOLDER),
          onClick: () => {
            if (agent && onAgentOpen) {
              onAgentOpen(d, addr.id);
              return;
            }
            onDomainChange(d);
            onAddressChange(addr.id);
            onFolderChange("inbox");
          },
        };
      }
      case "catchall": {
        const d = domains.find((x) => x.id === ref.domainId);
        if (!d) return null;
        return {
          icon: Shield,
          label: ref.label?.trim() || `Catch-All — ${d.domain}`,
          count: unreadCounts.folders[d.id]?.catchall ?? 0,
          active: selectedDomain?.id === d.id && catchAllOnly,
          onClick: () => onCatchAllToggle?.(d),
        };
      }
    }
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const next = [...favorites];
    const [moved] = next.splice(result.source.index, 1);
    next.splice(result.destination.index, 0, moved);
    updateFavorites(next);
  };

  // Default (computed) name for a favorite — used as the rename placeholder.
  // The standard aggregates keep their fixed names and can't be renamed.
  const defaultFavoriteLabel = (ref: FavoriteRef): string => {
    switch (ref.kind) {
      case "folder":
        return aggregateDefs.find((f) => f.id === ref.folder)?.label ?? ref.folder;
      case "domain-folder": {
        const d = domains.find((x) => x.id === ref.domainId);
        if (ref.folder === AGENT_FOLDER) return d ? `Agents — ${d.domain}` : "";
        const def = folderDefs.find((f) => f.id === ref.folder);
        return d && def ? `${def.label} — ${d.domain}` : "";
      }
      case "address": {
        const d = domains.find((x) => x.id === ref.domainId);
        const addr = d?.addresses?.find((a) => a.id === ref.addressId);
        return d && addr ? `${addr.address}@${d.domain}` : "";
      }
      case "catchall": {
        const d = domains.find((x) => x.id === ref.domainId);
        return d ? `Catch-All — ${d.domain}` : "";
      }
    }
  };

  const renameFavorite = (key: string, rawLabel: string) => {
    updateFavorites(
      favorites.map((f) => {
        if (favKey(f) !== key || f.kind === "folder") return f;
        const label = rawLabel;
        if (!label.trim()) {
          // Cleared → back to the default name
          const { label: _drop, ...rest } = f as { label?: string } & FavoriteRef;
          return rest as FavoriteRef;
        }
        return { ...f, label };
      })
    );
  };

  // Small pin toggle used across domain sections while editing. The outer
  // span is a padded tap target (exempt from the mobile 44px stretch); the
  // inner circle is the small visual.
  const PinButton = ({ refItem }: { refItem: FavoriteRef }) => {
    const pinned = isPinned(refItem);
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          togglePin(refItem);
        }}
        className="mc-touch-exempt flex-shrink-0 p-1.5 -m-1.5 flex items-center justify-center cursor-pointer"
        title={pinned ? "Remove from Favorites" : "Add to Favorites"}
      >
        <span
          className="h-[18px] w-[18px] rounded-full flex items-center justify-center transition-colors"
          style={{
            backgroundColor: pinned ? "var(--mc-accent)" : "transparent",
            border: pinned ? "none" : "1px solid var(--mc-text-faint)",
            color: pinned ? "#fff" : "var(--mc-text-faint)",
          }}
        >
          {pinned ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
        </span>
      </span>
    );
  };

  const FooterIcons = ({ mobile = false }: { mobile?: boolean }) => (
    <div
      className={`flex items-center ${mobile ? "justify-around w-full px-2" : "justify-center gap-1"}`}
      style={
        mobile
          ? {
              borderTop: "1px solid var(--mc-border)",
              backgroundColor: "var(--mc-sidebar-solid)",
              paddingTop: 8,
              paddingBottom: "max(8px, env(safe-area-inset-bottom))",
              minHeight: 52,
            }
          : undefined
      }
    >
      <ThemeMenu />
      {push.supported && (
        <button
          onClick={() => push.toggle()}
          disabled={push.loading}
          className="p-1.5 rounded-md transition-colors"
          style={{ color: push.enabled ? "var(--mc-accent)" : "var(--mc-text-muted)" }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
          title={push.enabled ? "Notifications on — click to disable" : "Enable notifications"}
        >
          {push.loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : push.enabled ? (
            <Bell className="h-4 w-4" />
          ) : (
            <BellOff className="h-4 w-4" />
          )}
        </button>
      )}
      <button
        onClick={handleRefresh}
        disabled={refreshing}
        className="p-1.5 rounded-md transition-colors"
        style={{ color: refreshing ? "var(--mc-accent)" : "var(--mc-text-muted)" }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
        title="Refresh domains and counts"
      >
        <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
      </button>
      <button
        onClick={() => onOpenSettings()}
        className="p-1.5 rounded-md transition-colors"
        style={{ color: "var(--mc-text-muted)" }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
        title="Settings"
      >
        <Settings className="h-4 w-4" />
      </button>
    </div>
  );

  // ---------- Mobile: same tree as desktop, iOS chrome ----------
  // Favorites on top (edit/pin/reorder) → expandable domains (domain name,
  // not person names). No extra "account nickname" strip.
  const mobileView = (
    <div
      className="flex md:hidden flex-col h-full relative"
      style={{ backgroundColor: "var(--mc-sidebar-solid)" }}
    >
      {/* Header: Edit + large title + updated */}
      <div className="flex-shrink-0 px-4 pt-1">
        <div className="flex items-center justify-end h-10 gap-2">
          <button
            onClick={anythingExpanded ? collapseAll : expandAll}
            className="mc-touch-exempt p-2 rounded-full active:opacity-70"
            style={{ color: "var(--mc-accent)" }}
            title={anythingExpanded ? "Collapse all" : "Expand all"}
          >
            {anythingExpanded ? (
              <ChevronsDownUp className="h-5 w-5" />
            ) : (
              <ChevronsUpDown className="h-5 w-5" />
            )}
          </button>
          <button
            onClick={() => setEditing((v) => !v)}
            className="mc-touch-exempt px-3.5 py-1.5 rounded-full text-[15px] font-medium active:opacity-70"
            style={{
              color: "var(--mc-accent)",
              backgroundColor: "var(--mc-card)",
              boxShadow: "0 0.5px 1px rgba(0,0,0,0.06)",
            }}
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
        <h1
          className="text-[34px] font-bold tracking-tight leading-none"
          style={{ color: "var(--mc-text)" }}
        >
          Mailboxes
        </h1>
        <p className="text-[13px] mt-1.5 mb-1" style={{ color: "var(--mc-text-muted)" }}>
          {formatUpdated(lastUpdated)}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-28 space-y-5">
        {/* —— Favorites (same data as desktop) —— */}
        <div>
          <button
            onClick={toggleFavorites}
            className="w-full flex items-center gap-1.5 px-1 mb-1.5 active:opacity-70"
            style={{ minHeight: 28 }}
          >
            {favoritesVisible ? (
              <ChevronDown className="h-4 w-4 flex-shrink-0" style={{ color: "var(--mc-text-muted)" }} />
            ) : (
              <ChevronRight className="h-4 w-4 flex-shrink-0" style={{ color: "var(--mc-text-muted)" }} />
            )}
            <span
              className="flex-1 text-left text-[13px] font-semibold uppercase tracking-wide"
              style={{ color: "var(--mc-text-muted)" }}
            >
              Favorites
            </span>
          </button>

          {favoritesVisible && (
            <IosGroup>
              {editing ? (
                <>
                  {favorites.length === 0 ? (
                    <div className="px-4 py-3 text-[14px]" style={{ color: "var(--mc-text-muted)" }}>
                      Pin folders below with +.
                    </div>
                  ) : (
                    <DragDropContext onDragEnd={onDragEnd}>
                      <Droppable droppableId="favorites-mobile">
                        {(dropProvided) => (
                          <div ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
                            {favorites.map((ref, index) => {
                              const resolved = resolveFavorite(ref);
                              if (!resolved) return null;
                              const key = favKey(ref);
                              const renamable = ref.kind !== "folder";
                              const isLast =
                                index === favorites.length - 1 &&
                                aggregateDefs.every((f) => favoriteKeys.has(`folder:${f.id}`));
                              return (
                                <Draggable key={key} draggableId={key} index={index}>
                                  {(dragProvided, snapshot) => (
                                    <div
                                      ref={dragProvided.innerRef}
                                      {...dragProvided.draggableProps}
                                      className="flex items-center gap-2 pl-3 pr-3 relative"
                                      style={{
                                        ...dragProvided.draggableProps.style,
                                        minHeight: 48,
                                        opacity: snapshot.isDragging ? 0.9 : 1,
                                        backgroundColor: snapshot.isDragging
                                          ? "var(--mc-bg-hover)"
                                          : "transparent",
                                      }}
                                    >
                                      <span
                                        {...dragProvided.dragHandleProps}
                                        className="mc-touch-exempt flex-shrink-0 p-1"
                                        style={{ color: "var(--mc-text-faint)" }}
                                      >
                                        <GripVertical className="h-4 w-4" />
                                      </span>
                                      <resolved.icon
                                        className="h-[20px] w-[20px] flex-shrink-0"
                                        style={{ color: "var(--mc-accent)" }}
                                      />
                                      {renamable ? (
                                        <input
                                          type="text"
                                          value={(ref as { label?: string }).label ?? ""}
                                          placeholder={defaultFavoriteLabel(ref)}
                                          onChange={(e) => renameFavorite(key, e.target.value)}
                                          className="flex-1 min-w-0 bg-transparent text-[17px] focus:outline-none"
                                          style={{ color: "var(--mc-text)" }}
                                        />
                                      ) : (
                                        <span
                                          className="flex-1 min-w-0 truncate text-[17px]"
                                          style={{ color: "var(--mc-text)" }}
                                        >
                                          {resolved.label}
                                        </span>
                                      )}
                                      <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          updateFavorites(favorites.filter((f) => favKey(f) !== key));
                                        }}
                                        className="mc-touch-exempt flex-shrink-0 p-1.5 flex items-center justify-center"
                                        title="Remove"
                                      >
                                        <span
                                          className="h-[22px] w-[22px] rounded-full flex items-center justify-center"
                                          style={{ backgroundColor: "var(--mc-danger)", color: "#fff" }}
                                        >
                                          <Minus className="h-3.5 w-3.5" />
                                        </span>
                                      </span>
                                      {!isLast && (
                                        <span
                                          className="absolute bottom-0 right-0 pointer-events-none"
                                          style={{
                                            left: 44,
                                            height: "0.5px",
                                            backgroundColor: "var(--mc-border)",
                                          }}
                                        />
                                      )}
                                    </div>
                                  )}
                                </Draggable>
                              );
                            })}
                            {dropProvided.placeholder}
                          </div>
                        )}
                      </Droppable>
                    </DragDropContext>
                  )}
                  {/* Aggregates not yet pinned — same as desktop */}
                  {aggregateDefs.some((f) => !favoriteKeys.has(`folder:${f.id}`)) && (
                    <div style={{ borderTop: favorites.length ? "0.5px solid var(--mc-border)" : undefined }}>
                      {aggregateDefs
                        .filter((f) => !favoriteKeys.has(`folder:${f.id}`))
                        .map((f, i, arr) => (
                          <IosRow
                            key={`add-${f.id}`}
                            icon={f.icon}
                            label={f.label}
                            iconColor="var(--mc-text-faint)"
                            showChevron={false}
                            last={i === arr.length - 1}
                            onClick={() => togglePin({ kind: "folder", folder: f.id })}
                            trailing={<PinButton refItem={{ kind: "folder", folder: f.id }} />}
                          />
                        ))}
                    </div>
                  )}
                </>
              ) : favorites.length === 0 ? (
                <div className="px-4 py-3 text-[14px]" style={{ color: "var(--mc-text-muted)" }}>
                  Tap Edit to pin favorites.
                </div>
              ) : (
                favorites.map((ref, i) => {
                  const resolved = resolveFavorite(ref);
                  if (!resolved) return null;
                  return (
                    <IosRow
                      key={favKey(ref)}
                      icon={resolved.icon}
                      label={resolved.label}
                      count={resolved.count}
                      active={resolved.active}
                      onClick={resolved.onClick}
                      last={i === favorites.length - 1}
                    />
                  );
                })
              )}
            </IosGroup>
          )}
          {editing && favoritesVisible && (
            <div className="px-1 mt-2 text-[12px]" style={{ color: "var(--mc-text-faint)" }}>
              Tap + on any mailbox below to pin it here.
            </div>
          )}
        </div>

        {/* —— Domains (domain name, expand → same folders as desktop) —— */}
        {domains.map((d) => {
          const isThisDomain = selectedDomain?.id === d.id;
          const liveFolderCounts = unreadCounts.folders[d.id] || {};
          const isCollapsed = collapsedDomains.includes(d.id);
          const domainTotalUnread = unreadCounts.domains[d.id] ?? 0;
          const peopleAddrs = (d.addresses || []).filter((a) => a.is_active && !isAgentAddress(a));
          const agentAddrs = (d.addresses || []).filter((a) => a.is_active && isAgentAddress(a));
          const hasAddresses = peopleAddrs.length > 0;
          const hasAgents = agentAddrs.length > 0;
          const addrsExpanded = expandedAddresses.includes(d.id);
          const agentsExpanded = expandedAgents.includes(d.id);

          // Build folder rows — same set as desktop (folderDefs + catch-all)
          type RowSpec = {
            key: string;
            icon: LucideIcon;
            label: string;
            count: number;
            active: boolean;
            onClick: () => void;
            pinRef?: FavoriteRef;
          };
          const rows: RowSpec[] = [];
          for (const f of folderDefs) {
            const count =
              f.id === "drafts"
                ? isThisDomain
                  ? draftsCount
                  : 0
                : liveFolderCounts[f.id] ?? 0;
            rows.push({
              key: f.id,
              icon: f.icon,
              label: f.label,
              count,
              active:
                isThisDomain &&
                activeFolder === f.id &&
                !selectedAddress &&
                !catchAllOnly,
              onClick: () => {
                if (selectedDomain?.id !== d.id) onDomainChange(d);
                onFolderChange(f.id);
              },
              pinRef: { kind: "domain-folder", domainId: d.id, folder: f.id },
            });
            if (f.id === "inbox" && d.catch_all_enabled && onCatchAllToggle) {
              rows.push({
                key: "catchall",
                icon: Shield,
                label: "Catch-All",
                count: liveFolderCounts.catchall ?? 0,
                active: isThisDomain && catchAllOnly,
                onClick: () => onCatchAllToggle(d),
                pinRef: { kind: "catchall", domainId: d.id },
              });
            }
          }

          return (
            <div key={d.id}>
              <button
                onClick={() => toggleDomainCollapse(d.id)}
                className="w-full flex items-center gap-2 px-1 mb-1.5 active:opacity-70"
                style={{ minHeight: 28 }}
              >
                <div
                  className="h-2 w-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: getDomainHealthDot(d) }}
                />
                <span
                  className="flex-1 text-left text-[13px] font-semibold uppercase tracking-wide truncate"
                  style={{ color: "var(--mc-text-muted)" }}
                >
                  {d.domain}
                </span>
                {domainTotalUnread > 0 && (
                  <span
                    className="text-[15px] tabular-nums flex-shrink-0"
                    style={{ color: "var(--mc-text-muted)" }}
                  >
                    {domainTotalUnread}
                  </span>
                )}
                {isCollapsed ? (
                  <ChevronRight
                    className="h-5 w-5 flex-shrink-0"
                    strokeWidth={2.25}
                    style={{ color: "var(--mc-accent)" }}
                  />
                ) : (
                  <ChevronDown
                    className="h-5 w-5 flex-shrink-0"
                    strokeWidth={2.25}
                    style={{ color: "var(--mc-accent)" }}
                  />
                )}
              </button>

              {!isCollapsed && (
                <IosGroup>
                  {rows.map((row, i) => {
                    const isLastFolder = i === rows.length - 1 && !hasAddresses && !hasAgents;
                    return (
                      <IosRow
                        key={row.key}
                        icon={row.icon}
                        label={row.label}
                        count={row.count}
                        active={row.active}
                        onClick={row.onClick}
                        last={isLastFolder}
                        trailing={
                          editing && row.pinRef ? (
                            <PinButton refItem={row.pinRef} />
                          ) : undefined
                        }
                        showChevron={!editing}
                      />
                    );
                  })}

                  {hasAgents && (
                    <>
                      <button
                        onClick={() => toggleAgents(d.id)}
                        className="w-full flex items-center gap-2 pl-4 pr-3 text-[15px] active:opacity-70 relative"
                        style={{
                          minHeight: 44,
                          color: "var(--mc-text-muted)",
                        }}
                      >
                        <span className="flex-1 text-left">Agents ({agentAddrs.length})</span>
                        {agentsExpanded ? (
                          <ChevronDown className="h-4 w-4" style={{ color: "var(--mc-text-ghost)" }} />
                        ) : (
                          <ChevronRight className="h-4 w-4" style={{ color: "var(--mc-text-ghost)" }} />
                        )}
                        <span
                          className="absolute top-0 right-0 pointer-events-none"
                          style={{
                            left: 50,
                            height: "0.5px",
                            backgroundColor: "var(--mc-border)",
                          }}
                        />
                      </button>
                      <IosRow
                        icon={Bot}
                        label="All agents"
                        active={
                          isThisDomain &&
                          activeFolder === AGENT_FOLDER &&
                          !selectedAddress &&
                          !catchAllOnly
                        }
                        onClick={() => onAgentOpen?.(d, null)}
                        last={false}
                        trailing={
                          editing ? (
                            <PinButton
                              refItem={{ kind: "domain-folder", domainId: d.id, folder: AGENT_FOLDER }}
                            />
                          ) : undefined
                        }
                        showChevron={!editing}
                      />
                      <IosRow
                        icon={Columns3}
                        label="Kanban"
                        active={activeFolder === KANBAN_FOLDER}
                        onClick={() => onFolderChange(KANBAN_FOLDER)}
                        last={!agentsExpanded && !hasAddresses}
                        showChevron={!editing}
                      />
                      {agentsExpanded &&
                        agentAddrs.map((addr, i, arr) => (
                          <IosRow
                            key={addr.id}
                            icon={Bot}
                            label={addr.display_name || addr.address}
                            active={
                              isThisDomain &&
                              activeFolder === AGENT_FOLDER &&
                              selectedAddress === addr.id &&
                              !catchAllOnly
                            }
                            onClick={() => onAgentOpen?.(d, addr.id)}
                            last={i === arr.length - 1 && !hasAddresses}
                            trailing={
                              editing ? (
                                <PinButton
                                  refItem={{ kind: "address", domainId: d.id, addressId: addr.id }}
                                />
                              ) : undefined
                            }
                            showChevron={!editing}
                          />
                        ))}
                    </>
                  )}

                  {hasAddresses && (
                    <>
                      <button
                        onClick={() => toggleAddresses(d.id)}
                        className="w-full flex items-center gap-2 pl-4 pr-3 text-[15px] active:opacity-70 relative"
                        style={{
                          minHeight: 44,
                          color: "var(--mc-text-muted)",
                        }}
                      >
                        <span className="flex-1 text-left">
                          Addresses ({peopleAddrs.length})
                        </span>
                        {addrsExpanded ? (
                          <ChevronDown className="h-4 w-4" style={{ color: "var(--mc-text-ghost)" }} />
                        ) : (
                          <ChevronRight className="h-4 w-4" style={{ color: "var(--mc-text-ghost)" }} />
                        )}
                        <span
                          className="absolute top-0 right-0 pointer-events-none"
                          style={{
                            left: 50,
                            height: "0.5px",
                            backgroundColor: "var(--mc-border)",
                          }}
                        />
                      </button>
                      {addrsExpanded &&
                        peopleAddrs
                          .map((addr, i, arr) => (
                            <IosRow
                              key={addr.id}
                              icon={User}
                              label={addr.address}
                              active={isThisDomain && selectedAddress === addr.id && !catchAllOnly && activeFolder !== AGENT_FOLDER}
                              onClick={() => {
                                onDomainChange(d);
                                onAddressChange(addr.id);
                                onFolderChange("inbox");
                              }}
                              last={i === arr.length - 1}
                              trailing={
                                editing ? (
                                  <PinButton
                                    refItem={{ kind: "address", domainId: d.id, addressId: addr.id }}
                                  />
                                ) : undefined
                              }
                              showChevron={!editing}
                            />
                          ))}
                    </>
                  )}
                </IosGroup>
              )}
            </div>
          );
        })}

        {domains.length === 0 && (
          <IosGroup>
            <IosRow
              icon={Plus}
              label="Add a domain in Settings"
              showChevron={false}
              last
              onClick={() => onOpenSettings({ tab: "accounts" })}
            />
          </IosGroup>
        )}
      </div>

      {/* Compose FAB — Apple Mail style, above footer */}
      <button
        onClick={onCompose}
        className="absolute z-20 flex items-center justify-center rounded-full active:scale-95 transition-transform"
        style={{
          right: 16,
          bottom: "calc(60px + env(safe-area-inset-bottom, 0px))",
          width: 52,
          height: 52,
          backgroundColor: "var(--mc-card)",
          color: "var(--mc-accent)",
          boxShadow: "0 2px 12px rgba(0,0,0,0.14), 0 0.5px 1px rgba(0,0,0,0.08)",
        }}
        title="Compose"
        aria-label="Compose"
      >
        <Pencil className="h-5 w-5" strokeWidth={2} />
      </button>

      {/* Bottom utility row — keep theme / push / refresh / settings */}
      <div className="flex-shrink-0">
        <FooterIcons mobile />
      </div>
    </div>
  );

  // ---------- Desktop: denser sidebar (unchanged behavior) ----------
  const desktopView = (
    <div className="hidden md:flex flex-col h-full p-2.5">
      {/* Compose */}
      <button
        onClick={onCompose}
        className="w-full flex items-center justify-center gap-2 h-8 rounded-md font-medium text-[13px] transition-all mb-3 hover:brightness-110"
        style={{ backgroundColor: "var(--mc-accent)", color: "#fff" }}
      >
        <Pencil className="h-3.5 w-3.5" />
        Compose
      </button>

      {/* Mailboxes header — collapse/expand everything at once */}
      <div className="flex items-center px-1 mb-0.5">
        <span className="flex-1 text-[11px] font-semibold" style={{ color: "var(--mc-text-faint)" }}>
          Mailboxes
        </span>
        <button
          onClick={anythingExpanded ? collapseAll : expandAll}
          className="p-1 rounded transition-colors"
          style={{ color: "var(--mc-text-faint)" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--mc-accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--mc-text-faint)"; }}
          title={anythingExpanded ? "Collapse all" : "Expand all"}
        >
          {anythingExpanded ? (
            <ChevronsDownUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronsUpDown className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* One scroll container for the whole mailbox tree */}
      <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
        {/* Favorites */}
        <div className="mb-1.5">
          <div className="flex items-center px-1 mb-0.5">
            <button
              onClick={toggleFavorites}
              className="flex items-center gap-1 flex-1 py-0.5"
              style={{ color: "var(--mc-text-faint)" }}
            >
              {favoritesVisible ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <span className="text-[11px] font-semibold">Favorites</span>
            </button>
            <button
              onClick={() => setEditing((v) => !v)}
              className="text-[11px] px-1.5 py-0.5 rounded transition-colors"
              style={{ color: editing ? "var(--mc-accent)" : "var(--mc-text-faint)" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--mc-accent)"; }}
              onMouseLeave={(e) => { if (!editing) e.currentTarget.style.color = "var(--mc-text-faint)"; }}
            >
              {editing ? "Done" : "Edit"}
            </button>
          </div>

          {favoritesVisible && (
            <div className="space-y-px">
              {editing ? (
                <DragDropContext onDragEnd={onDragEnd}>
                  <Droppable droppableId="favorites">
                    {(dropProvided) => (
                      <div ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
                        {favorites.map((ref, index) => {
                          const resolved = resolveFavorite(ref);
                          if (!resolved) return null;
                          const key = favKey(ref);
                          const renamable = ref.kind !== "folder";
                          return (
                            <Draggable key={key} draggableId={key} index={index}>
                              {(dragProvided, snapshot) => (
                                <div
                                  ref={dragProvided.innerRef}
                                  {...dragProvided.draggableProps}
                                  className="flex items-center gap-2 h-8 rounded-md pl-2 pr-2"
                                  style={{
                                    ...dragProvided.draggableProps.style,
                                    opacity: snapshot.isDragging ? 0.85 : 1,
                                    backgroundColor: snapshot.isDragging ? "var(--mc-bg-hover)" : "transparent",
                                  }}
                                >
                                  <span
                                    {...dragProvided.dragHandleProps}
                                    className="flex-shrink-0 cursor-grab active:cursor-grabbing"
                                    style={{ color: "var(--mc-text-faint)" }}
                                  >
                                    <GripVertical className="h-3.5 w-3.5" />
                                  </span>
                                  <resolved.icon
                                    className="h-[15px] w-[15px] flex-shrink-0"
                                    style={{ color: "var(--mc-accent)" }}
                                  />
                                  {renamable ? (
                                    <input
                                      type="text"
                                      value={(ref as { label?: string }).label ?? ""}
                                      placeholder={defaultFavoriteLabel(ref)}
                                      onChange={(e) => renameFavorite(key, e.target.value)}
                                      className="flex-1 min-w-0 bg-transparent text-[13px] focus:outline-none rounded px-1 -mx-1 focus:bg-[var(--mc-bg-tertiary)]"
                                      style={{ color: "var(--mc-text)" }}
                                      title="Tap to rename"
                                    />
                                  ) : (
                                    <span
                                      className="flex-1 min-w-0 truncate text-[13px]"
                                      style={{ color: "var(--mc-text-secondary)" }}
                                    >
                                      {resolved.label}
                                    </span>
                                  )}
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      updateFavorites(favorites.filter((f) => favKey(f) !== key));
                                    }}
                                    className="mc-touch-exempt flex-shrink-0 p-1.5 -m-1.5 flex items-center justify-center cursor-pointer"
                                    title="Remove from Favorites"
                                  >
                                    <span
                                      className="h-[18px] w-[18px] rounded-full flex items-center justify-center"
                                      style={{ backgroundColor: "var(--mc-danger)", color: "#fff" }}
                                    >
                                      <Minus className="h-3 w-3" />
                                    </span>
                                  </span>
                                </div>
                              )}
                            </Draggable>
                          );
                        })}
                        {dropProvided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </DragDropContext>
              ) : (
                favorites.map((ref) => {
                  const resolved = resolveFavorite(ref);
                  if (!resolved) return null;
                  return (
                    <SidebarRow
                      key={favKey(ref)}
                      icon={resolved.icon}
                      label={resolved.label}
                      count={resolved.count}
                      active={resolved.active}
                      onClick={resolved.onClick}
                    />
                  );
                })
              )}

              {/* While editing: aggregates not yet pinned, one tap to add */}
              {editing && (
                <div className="mt-1 pt-1" style={{ borderTop: "1px solid var(--mc-border-subtle)" }}>
                  {aggregateDefs
                    .filter((f) => !favoriteKeys.has(`folder:${f.id}`))
                    .map((f) => (
                      <SidebarRow
                        key={`add-${f.id}`}
                        icon={f.icon}
                        label={f.label}
                        iconColor="var(--mc-text-faint)"
                        onClick={() => togglePin({ kind: "folder", folder: f.id })}
                        trailing={<PinButton refItem={{ kind: "folder", folder: f.id }} />}
                      />
                    ))}
                  <div className="px-2 py-1 text-[10px]" style={{ color: "var(--mc-text-faint)" }}>
                    Tip: use the + on any mailbox below to pin it here.
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mt-2" style={{ borderTop: "1px solid var(--mc-border)" }} />
        </div>

        {/* Domain accounts */}
        <div className="space-y-1.5">
          {domains.map((d) => {
            const isThisDomain = selectedDomain?.id === d.id;
            const dotColor = getDomainHealthDot(d);
            const liveFolderCounts = unreadCounts.folders[d.id] || {};
            const isCollapsed = collapsedDomains.includes(d.id);
            const domainTotalUnread = unreadCounts.domains[d.id] ?? 0;

            return (
              <div key={d.id}>
                {/* Section header */}
                <div className="flex items-center justify-between pl-1 pr-0.5 h-6 group/domain">
                  <button
                    onClick={() => toggleDomainCollapse(d.id)}
                    className="flex items-center gap-1.5 min-w-0 flex-1"
                    style={{ color: "var(--mc-text-faint)" }}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 flex-shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 flex-shrink-0" />
                    )}
                    <div
                      className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: dotColor }}
                    />
                    <span className="text-[11px] font-semibold truncate">{d.domain}</span>
                  </button>
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    {domainTotalUnread > 0 && (
                      <span
                        className="text-[11px] font-semibold tabular-nums"
                        style={{ color: "var(--mc-text-muted)" }}
                        title={`${domainTotalUnread} unread across all folders`}
                      >
                        {domainTotalUnread}
                      </span>
                    )}
                    <button
                      onClick={() => onOpenSettings({ tab: "accounts", domainId: d.id })}
                      className="p-1 rounded transition-all opacity-0 group-hover/domain:opacity-100"
                      style={{ color: "var(--mc-text-faint)" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-accent)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--mc-text-faint)"; }}
                      title="Domain settings"
                    >
                      <Settings className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Folders */}
                {!isCollapsed && (
                  <div className="space-y-px">
                    {folderDefs.flatMap((f) => {
                      const items: React.ReactNode[] = [];
                      const isActive =
                        isThisDomain && activeFolder === f.id && !selectedAddress && !catchAllOnly;
                      const count =
                        f.id === "drafts" ? (isThisDomain ? draftsCount : 0) : liveFolderCounts[f.id] ?? 0;
                      const dfRef: FavoriteRef = { kind: "domain-folder", domainId: d.id, folder: f.id };

                      items.push(
                        <SidebarRow
                          key={f.id}
                          icon={f.icon}
                          label={f.label}
                          count={count}
                          active={isActive}
                          depth={1}
                          onClick={() => {
                            if (selectedDomain?.id !== d.id) onDomainChange(d);
                            onFolderChange(f.id);
                          }}
                          trailing={editing ? <PinButton refItem={dfRef} /> : undefined}
                        />
                      );

                      if (f.id === "inbox" && d.catch_all_enabled && onCatchAllToggle) {
                        const caRef: FavoriteRef = { kind: "catchall", domainId: d.id };
                        items.push(
                          <SidebarRow
                            key={`${f.id}-catchall`}
                            icon={Shield}
                            label="Catch-All"
                            count={liveFolderCounts.catchall ?? 0}
                            active={isThisDomain && catchAllOnly}
                            depth={1}
                            onClick={() => onCatchAllToggle(d)}
                            title="Mail addressed to unknown local-parts on this domain"
                            trailing={editing ? <PinButton refItem={caRef} /> : undefined}
                          />
                        );
                      }

                      return items;
                    })}

                    {/* Agent mailboxes — hidden from inbox / catch-all */}
                    {(() => {
                      const agentAddrs = (d.addresses || []).filter((a) => a.is_active && isAgentAddress(a));
                      const peopleAddrs = (d.addresses || []).filter((a) => a.is_active && !isAgentAddress(a));
                      const agentsExpanded = expandedAgents.includes(d.id);
                      return (
                        <>
                          {agentAddrs.length > 0 && (
                            <>
                              <button
                                onClick={() => toggleAgents(d.id)}
                                className="mc-touch-exempt w-full flex items-center gap-1 pl-[12px] pr-1 pt-1.5 pb-0.5"
                                style={{ color: "var(--mc-text-faint)" }}
                                title={agentsExpanded ? "Hide agent folders" : "Show agent folders"}
                              >
                                {agentsExpanded ? (
                                  <ChevronDown className="h-3 w-3 flex-shrink-0" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 flex-shrink-0" />
                                )}
                                <span className="text-[10px] font-semibold">Agents</span>
                                <span className="text-[10px] font-semibold tabular-nums ml-1 opacity-70">
                                  {agentAddrs.length}
                                </span>
                              </button>
                              <SidebarRow
                                icon={Bot}
                                label="All agents"
                                active={
                                  isThisDomain &&
                                  activeFolder === AGENT_FOLDER &&
                                  !selectedAddress &&
                                  !catchAllOnly
                                }
                                depth={1}
                                onClick={() => onAgentOpen?.(d, null)}
                                trailing={
                                  editing ? (
                                    <PinButton
                                      refItem={{
                                        kind: "domain-folder",
                                        domainId: d.id,
                                        folder: AGENT_FOLDER,
                                      }}
                                    />
                                  ) : undefined
                                }
                              />
                              <SidebarRow
                                icon={Columns3}
                                label="Kanban"
                                active={activeFolder === KANBAN_FOLDER}
                                depth={1}
                                onClick={() => onFolderChange(KANBAN_FOLDER)}
                              />
                              {agentsExpanded &&
                                agentAddrs.map((addr) => {
                                  const aRef: FavoriteRef = {
                                    kind: "address",
                                    domainId: d.id,
                                    addressId: addr.id,
                                  };
                                  return (
                                    <SidebarRow
                                      key={addr.id}
                                      icon={Bot}
                                      label={addr.display_name || addr.address}
                                      active={
                                        isThisDomain &&
                                        activeFolder === AGENT_FOLDER &&
                                        selectedAddress === addr.id &&
                                        !catchAllOnly
                                      }
                                      depth={1}
                                      onClick={() => onAgentOpen?.(d, addr.id)}
                                      trailing={editing ? <PinButton refItem={aRef} /> : undefined}
                                    />
                                  );
                                })}
                            </>
                          )}

                          {peopleAddrs.length > 0 && (
                            <>
                              <button
                                onClick={() => toggleAddresses(d.id)}
                                className="mc-touch-exempt w-full flex items-center gap-1 pl-[12px] pr-1 pt-1.5 pb-0.5"
                                style={{ color: "var(--mc-text-faint)" }}
                                title={expandedAddresses.includes(d.id) ? "Hide addresses" : "Show addresses"}
                              >
                                {expandedAddresses.includes(d.id) ? (
                                  <ChevronDown className="h-3 w-3 flex-shrink-0" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 flex-shrink-0" />
                                )}
                                <span className="text-[10px] font-semibold">Addresses</span>
                                <span className="text-[10px] font-semibold tabular-nums ml-1 opacity-70">
                                  {peopleAddrs.length}
                                </span>
                              </button>
                              {expandedAddresses.includes(d.id) &&
                                peopleAddrs.map((addr) => {
                                  const aRef: FavoriteRef = { kind: "address", domainId: d.id, addressId: addr.id };
                                  return (
                                    <SidebarRow
                                      key={addr.id}
                                      icon={User}
                                      label={addr.address}
                                      active={
                                        isThisDomain &&
                                        selectedAddress === addr.id &&
                                        !catchAllOnly &&
                                        activeFolder !== AGENT_FOLDER
                                      }
                                      depth={1}
                                      onClick={() => {
                                        onDomainChange(d);
                                        onAddressChange(addr.id);
                                        onFolderChange("inbox");
                                      }}
                                      trailing={editing ? <PinButton refItem={aRef} /> : undefined}
                                    />
                                  );
                                })}
                            </>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}

          {domains.length === 0 && (
            <button
              onClick={() => onOpenSettings({ tab: "accounts" })}
              className="w-full flex items-center gap-2 h-7 px-2 rounded-md text-[12px] transition-all"
              style={{ color: "var(--mc-text-faint)" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--mc-accent)";
                e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--mc-text-faint)";
                e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              Add a domain in Settings
            </button>
          )}
        </div>
      </div>

      {/* Footer icon row */}
      <div
        className="mt-1.5 pt-1.5 flex items-center justify-center gap-1"
        style={{ borderTop: "1px solid var(--mc-border)" }}
      >
        <FooterIcons />
      </div>
    </div>
  );

  return (
    <>
      {mobileView}
      {desktopView}
    </>
  );
}
