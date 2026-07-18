"use client";

import {
  Inbox,
  Send,
  FileEdit,
  Star,
  Trash2,
  Archive,
  Plus,
  Mail,
  Pencil,
  RefreshCw,
  Settings,
  Bell,
  BellOff,
  Loader2,
  ChevronRight,
  ChevronDown,
  User,
  Shield,
  AlertOctagon,
} from "lucide-react";
import { useState, useEffect } from "react";
import type { EmailDomain } from "./email-layout";
import { DomainSettingsPanel } from "./domain-settings-panel";
import {
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  getCurrentSubscription,
  registerServiceWorker,
} from "@/lib/push-notifications";
import { apiFetch } from "@/lib/auth";

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
  unreadCount: number;
  draftsCount?: number;
  onAddDomain: () => void;
  onCompose: () => void;
  onRefreshDomains: () => void;
  unreadCounts?: UnreadCountsShape;
}

const folderDefs = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: FileEdit },
  { id: "starred", label: "Starred", icon: Star },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "spam", label: "Spam", icon: AlertOctagon },
  { id: "trash", label: "Trash", icon: Trash2 },
];

const allFavoriteDefs = [
  { id: "inbox", label: "Inboxes", icon: Inbox, countKey: "inbox" },
  { id: "sent", label: "Sent", icon: Send, countKey: "sent" },
  { id: "drafts", label: "Drafts", icon: FileEdit, countKey: "drafts" },
  { id: "starred", label: "Starred", icon: Star, countKey: "starred" },
  { id: "archive", label: "Archive", icon: Archive, countKey: "archive" },
  { id: "spam", label: "Spam", icon: AlertOctagon, countKey: "spam" },
  { id: "trash", label: "Trash", icon: Trash2, countKey: "trash" },
];

const DEFAULT_FAVORITE_IDS = ["inbox", "sent", "drafts", "starred"];

function getDomainHealthDot(d: EmailDomain): string {
  const status = d.status?.toLowerCase() || "";
  if (status === "failed" || status === "error") return "var(--mc-danger)";
  if (status === "pending" || status === "not_started") return "var(--mc-warning)";
  if (["active", "verified", "dns_configured"].includes(status)) return "var(--mc-success)";
  return "var(--mc-text-faint)";
}

const COLLAPSED_KEY = "email-collapsed-domains";
const FAVORITES_KEY = "email-favorites-visible";
const FAV_COLLAPSED_KEY = "email-favorites-collapsed";
const FAV_ITEMS_KEY = "email-favorite-items";

function loadCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCollapsed(ids: string[]) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(ids));
}

function loadFavoritesVisible(): boolean {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function loadFavCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FAV_COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveFavCollapsed(state: Record<string, boolean>) {
  localStorage.setItem(FAV_COLLAPSED_KEY, JSON.stringify(state));
}

function loadFavoriteItems(): string[] {
  try {
    const raw = localStorage.getItem(FAV_ITEMS_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_FAVORITE_IDS;
  } catch {
    return DEFAULT_FAVORITE_IDS;
  }
}

function saveFavoriteItems(ids: string[]) {
  localStorage.setItem(FAV_ITEMS_KEY, JSON.stringify(ids));
}

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
  unreadCount,
  draftsCount = 0,
  onAddDomain,
  onCompose,
  onRefreshDomains,
  unreadCounts = { domains: {}, folders: {}, totals: {} },
}: FolderListProps) {
  const [settingsDomain, setSettingsDomain] = useState<EmailDomain | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [collapsedDomains, setCollapsedDomains] = useState<string[]>([]);
  const [favoritesVisible, setFavoritesVisible] = useState(true);
  const [favCollapsed, setFavCollapsed] = useState<Record<string, boolean>>({});
  const [favoriteItems, setFavoriteItems] = useState<string[]>(DEFAULT_FAVORITE_IDS);
  const [editingFavorites, setEditingFavorites] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPushSupported(isPushSupported());
    registerServiceWorker().then(() => {
      getCurrentSubscription().then((sub) => {
        setPushEnabled(!!sub);
      });
    });
    setCollapsedDomains(loadCollapsed());
    setFavoritesVisible(loadFavoritesVisible());
    setFavCollapsed(loadFavCollapsed());
    setFavoriteItems(loadFavoriteItems());
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    onRefreshDomains();
    setTimeout(() => setRefreshing(false), 600);
  };

  const handleTogglePush = async () => {
    setPushLoading(true);
    if (pushEnabled) {
      const ok = await unsubscribeFromPush();
      if (ok) setPushEnabled(false);
    } else {
      const sub = await subscribeToPush();
      setPushEnabled(!!sub);
    }
    setPushLoading(false);
  };

  const toggleDomainCollapse = (domainId: string) => {
    setCollapsedDomains((prev) => {
      const next = prev.includes(domainId)
        ? prev.filter((id) => id !== domainId)
        : [...prev, domainId];
      saveCollapsed(next);
      return next;
    });
  };

  const toggleFavorites = () => {
    setFavoritesVisible((prev) => {
      const next = !prev;
      localStorage.setItem(FAVORITES_KEY, String(next));
      return next;
    });
  };

  const toggleFavCollapsed = (favId: string) => {
    setFavCollapsed((prev) => {
      const next = { ...prev, [favId]: !prev[favId] };
      saveFavCollapsed(next);
      return next;
    });
  };

  const toggleFavoriteItem = (favId: string) => {
    setFavoriteItems((prev) => {
      const next = prev.includes(favId)
        ? prev.filter((id) => id !== favId)
        : [...prev, favId];
      saveFavoriteItems(next);
      return next;
    });
  };

  const isAllSelected = selectedDomain === null;

  // Aggregate counts across all domains (live unread counts).
  const allCounts: Record<string, number> = {
    inbox: unreadCounts.totals.inbox ?? 0,
    sent: unreadCounts.totals.sent ?? 0,
    starred: unreadCounts.totals.starred ?? 0,
    archive: unreadCounts.totals.archive ?? 0,
    spam: unreadCounts.totals.spam ?? 0,
    trash: unreadCounts.totals.trash ?? 0,
  };

  const activeFavorites = allFavoriteDefs.filter((f) => favoriteItems.includes(f.id));

  return (
    <>
      <div className="flex flex-col h-full p-3">
        {/* Compose Button */}
        <button
          onClick={onCompose}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-[14px] transition-all mb-3"
          style={{
            backgroundColor: "var(--mc-accent)",
            color: "#fff",
          }}
        >
          <Pencil className="h-4 w-4" />
          Compose
        </button>

        {/* Favorites Section */}
        <div className="mb-2">
          <button
            onClick={toggleFavorites}
            className="w-full flex items-center gap-1.5 px-2 py-1 mb-1"
            style={{ color: "var(--mc-text-faint)" }}
          >
            {favoritesVisible ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span className="text-[10px] font-semibold uppercase tracking-widest">
              Favorites
            </span>
          </button>

          <div
            className="overflow-hidden transition-all duration-200"
            style={{
              maxHeight: favoritesVisible ? "600px" : "0px",
              opacity: favoritesVisible ? 1 : 0,
            }}
          >
            <div className="space-y-0.5">
              {activeFavorites.map((f) => {
                const isParentActive = isAllSelected && activeFolder === f.id;
                const count =
                  f.countKey === "drafts"
                    ? draftsCount
                    : allCounts[f.countKey] || 0;
                const isExpanded = !favCollapsed[f.id];

                return (
                  <div key={f.id}>
                    {/* Parent favorite item */}
                    <div className="flex items-center">
                      <button
                        onClick={() => toggleFavCollapsed(f.id)}
                        className="flex-shrink-0 p-1 rounded transition-all"
                        style={{ color: "var(--mc-text-faint)" }}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        onClick={() => {
                          // "All Inboxes" / cross-domain view: clear domain
                          // (which resets the active selectedAddress to null
                          // without touching each domain's saved choice in
                          // localStorage).
                          onDomainChange(null);
                          onFolderChange(f.id);
                        }}
                        className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13px] transition-all"
                        style={{
                          color: isParentActive ? "var(--mc-accent)" : "var(--mc-text-muted)",
                          backgroundColor: isParentActive ? "var(--mc-accent-bg)" : "transparent",
                          fontWeight: isParentActive ? 500 : 400,
                        }}
                        onMouseEnter={(e) => {
                          if (!isParentActive) {
                            e.currentTarget.style.color = "var(--mc-text-secondary)";
                            e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isParentActive) {
                            e.currentTarget.style.color = "var(--mc-text-muted)";
                            e.currentTarget.style.backgroundColor = "transparent";
                          }
                        }}
                      >
                        <f.icon className="h-4 w-4" />
                        <span className="flex-1 text-left">{f.label}</span>
                        <span
                          className="text-[11px] font-bold px-1.5 py-0.5 rounded-full"
                          style={{
                            color: count > 0 ? "var(--mc-accent)" : "var(--mc-text-faint)",
                            backgroundColor: "var(--mc-bg-hover)",
                          }}
                        >
                          ({count})
                        </span>
                      </button>
                    </div>

                    {/* Domain sub-items */}
                    <div
                      className="overflow-hidden transition-all duration-200"
                      style={{
                        maxHeight: isExpanded ? `${domains.length * 32}px` : "0px",
                        opacity: isExpanded ? 1 : 0,
                      }}
                    >
                      {domains.map((d) => {
                        const domainCount =
                          f.countKey === "drafts"
                            ? 0
                            : (unreadCounts.folders[d.id]?.[f.countKey] ?? 0);
                        const isSubActive =
                          selectedDomain?.id === d.id && activeFolder === f.id && !selectedAddress;

                        return (
                          <button
                            key={d.id}
                            onClick={() => {
                              // Same-domain folder change preserves the
                              // active recipient filter. Cross-domain jump
                              // restores that domain's saved choice (if any).
                              if (selectedDomain?.id !== d.id) {
                                onDomainChange(d);
                              }
                              onFolderChange(f.id);
                            }}
                            className="w-full flex items-center gap-2 pl-9 pr-3 py-1 rounded-lg text-[12px] transition-all"
                            style={{
                              color: isSubActive ? "var(--mc-accent)" : "var(--mc-text-faint)",
                              backgroundColor: isSubActive ? "var(--mc-accent-bg)" : "transparent",
                              fontWeight: isSubActive ? 500 : 400,
                            }}
                            onMouseEnter={(e) => {
                              if (!isSubActive) {
                                e.currentTarget.style.color = "var(--mc-text-secondary)";
                                e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isSubActive) {
                                e.currentTarget.style.color = "var(--mc-text-faint)";
                                e.currentTarget.style.backgroundColor = "transparent";
                              }
                            }}
                          >
                            <span className="flex-1 text-left truncate">{d.domain}</span>
                            <span
                              className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                              style={{
                                color: domainCount > 0 ? "var(--mc-accent)" : "var(--mc-text-faint)",
                                backgroundColor: "var(--mc-bg-hover)",
                              }}
                            >
                              ({domainCount})
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Edit Favorites */}
            <div className="mt-1.5">
              <button
                onClick={() => setEditingFavorites(!editingFavorites)}
                className="text-[11px] px-3 py-1 transition-all"
                style={{ color: "var(--mc-text-faint)" }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--mc-accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--mc-text-faint)";
                }}
              >
                {editingFavorites ? "Done" : "Edit Favorites"}
              </button>

              {editingFavorites && (
                <div className="mt-1 space-y-0.5 px-2">
                  {allFavoriteDefs.map((f) => {
                    const checked = favoriteItems.includes(f.id);
                    return (
                      <button
                        key={f.id}
                        onClick={() => toggleFavoriteItem(f.id)}
                        className="w-full flex items-center gap-2 px-2 py-1 rounded text-[12px] transition-all"
                        style={{ color: "var(--mc-text-muted)" }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "transparent";
                        }}
                      >
                        <div
                          className="h-3.5 w-3.5 rounded border flex items-center justify-center flex-shrink-0"
                          style={{
                            borderColor: checked ? "var(--mc-accent)" : "var(--mc-border)",
                            backgroundColor: checked ? "var(--mc-accent)" : "transparent",
                          }}
                        >
                          {checked && (
                            <svg className="h-2.5 w-2.5 text-white" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M2 6l3 3 5-5" />
                            </svg>
                          )}
                        </div>
                        <f.icon className="h-3.5 w-3.5" />
                        <span>{f.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="mt-2" style={{ borderTop: "1px solid var(--mc-border)" }} />
        </div>

        {/* Domain accounts — Apple Mail style collapsible sections */}
        <div className="flex-1 overflow-y-auto space-y-2">
          {domains.map((d) => {
            const isThisDomain = selectedDomain?.id === d.id;
            const dotColor = getDomainHealthDot(d);
            // Per-folder unread counts (live)
            const liveFolderCounts = unreadCounts.folders[d.id] || {};
            const counts: Record<string, number> = {
              inbox: liveFolderCounts.inbox ?? 0,
              sent: liveFolderCounts.sent ?? 0,
              drafts: 0,
              starred: liveFolderCounts.starred ?? 0,
              archive: liveFolderCounts.archive ?? 0,
              spam: liveFolderCounts.spam ?? 0,
              trash: liveFolderCounts.trash ?? 0,
            };
            const isCollapsed = collapsedDomains.includes(d.id);
            // Domain total unread = excludes trash (matches API semantics)
            const domainTotalUnread = unreadCounts.domains[d.id] ?? (liveFolderCounts.inbox ?? 0);

            return (
              <div key={d.id}>
                {/* Domain header — clickable chevron to collapse */}
                <div className="flex items-center justify-between px-2 mb-1">
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
                      className="h-2 w-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: dotColor }}
                    />
                    <span
                      className="text-[11px] font-semibold uppercase tracking-wider truncate"
                    >
                      {d.domain}
                    </span>
                  </button>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                      style={{
                        color: domainTotalUnread > 0 ? "var(--mc-accent)" : "var(--mc-text-faint)",
                        backgroundColor: "var(--mc-bg-hover)",
                      }}
                      title={domainTotalUnread > 0 ? `${domainTotalUnread} unread across all folders` : "No unread"}
                    >
                      ({domainTotalUnread})
                    </span>
                    <button
                      onClick={() => setSettingsDomain(d)}
                      className="p-1 rounded-lg transition-all flex-shrink-0"
                      style={{ color: "var(--mc-text-faint)" }}
                      onMouseEnter={(e) => {
                        (e.target as HTMLElement).style.color = "var(--mc-accent)";
                        (e.target as HTMLElement).style.backgroundColor = "var(--mc-accent-bg)";
                      }}
                      onMouseLeave={(e) => {
                        (e.target as HTMLElement).style.color = "var(--mc-text-faint)";
                        (e.target as HTMLElement).style.backgroundColor = "transparent";
                      }}
                      title="Domain settings"
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Folder tree + addresses — collapsible */}
                <div
                  className="overflow-hidden transition-all duration-200"
                  style={{
                    maxHeight: isCollapsed ? "0px" : "500px",
                    opacity: isCollapsed ? 0 : 1,
                  }}
                >
                  <div className="space-y-0.5">
                    {folderDefs.flatMap((f) => {
                      // Inject the per-domain Catch-All "virtual folder"
                      // right after Inbox, when the domain has catch-all
                      // enabled. It queries is_catch_all=true and reuses
                      // the existing catchAllOnly state in the parent.
                      const items: React.ReactNode[] = [];
                      const isActive = isThisDomain && activeFolder === f.id && !selectedAddress && !catchAllOnly;
                      const count = f.id === "drafts" ? (isThisDomain ? draftsCount : 0) : (counts[f.id] || 0);

                      items.push(
                        <button
                          key={f.id}
                          onClick={() => {
                            // Switching to a different domain restores that
                            // domain's saved recipient filter via onDomainChange.
                            // Staying on the same domain preserves the active
                            // recipient filter across folder switches.
                            if (selectedDomain?.id !== d.id) {
                              onDomainChange(d);
                            }
                            onFolderChange(f.id);
                          }}
                          className="w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-[13px] transition-all"
                          style={{
                            color: isActive ? "var(--mc-accent)" : "var(--mc-text-muted)",
                            backgroundColor: isActive ? "var(--mc-accent-bg)" : "transparent",
                            fontWeight: isActive ? 500 : 400,
                          }}
                          onMouseEnter={(e) => {
                            if (!isActive) {
                              e.currentTarget.style.color = "var(--mc-text-secondary)";
                              e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isActive) {
                              e.currentTarget.style.color = "var(--mc-text-muted)";
                              e.currentTarget.style.backgroundColor = "transparent";
                            }
                          }}
                        >
                          <f.icon className="h-4 w-4" />
                          <span className="flex-1 text-left">{f.label}</span>
                          <span
                            className="text-[11px] font-bold px-1.5 py-0.5 rounded-full"
                            style={{
                              color: count > 0 ? "var(--mc-accent)" : "var(--mc-text-faint)",
                              backgroundColor: "var(--mc-bg-hover)",
                            }}
                          >
                            ({count})
                          </span>
                        </button>
                      );

                      // Catch-All virtual folder appears right after Inbox
                      if (f.id === "inbox" && d.catch_all_enabled && onCatchAllToggle) {
                        const isCatchActive = isThisDomain && catchAllOnly;
                        const catchAllCount = liveFolderCounts.catchall ?? 0;
                        items.push(
                          <button
                            key={`${f.id}-catchall`}
                            onClick={() => onCatchAllToggle(d)}
                            className="w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-[13px] transition-all"
                            style={{
                              color: isCatchActive ? "var(--mc-accent)" : "var(--mc-text-muted)",
                              backgroundColor: isCatchActive ? "var(--mc-accent-bg)" : "transparent",
                              fontWeight: isCatchActive ? 500 : 400,
                            }}
                            onMouseEnter={(e) => {
                              if (!isCatchActive) {
                                e.currentTarget.style.color = "var(--mc-text-secondary)";
                                e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isCatchActive) {
                                e.currentTarget.style.color = "var(--mc-text-muted)";
                                e.currentTarget.style.backgroundColor = "transparent";
                              }
                            }}
                            title="Mail addressed to unknown local-parts on this domain"
                          >
                            <Shield className="h-4 w-4" />
                            <span className="flex-1 text-left">Catch-All</span>
                            <span
                              className="text-[11px] font-bold px-1.5 py-0.5 rounded-full"
                              style={{
                                color: catchAllCount > 0 ? "var(--mc-accent)" : "var(--mc-text-faint)",
                                backgroundColor: "var(--mc-bg-hover)",
                              }}
                            >
                              ({catchAllCount})
                            </span>
                          </button>
                        );
                      }

                      return items;
                    })}
                  </div>

                  {/* Address sub-items + Catch-All filter */}
                  {((d.addresses && d.addresses.some((a) => a.is_active)) || d.catch_all_enabled) && (
                    <div className="mt-1.5 ml-3 space-y-0.5">
                      <div
                        className="text-[10px] font-semibold uppercase tracking-widest px-3 py-1"
                        style={{ color: "var(--mc-text-faint)" }}
                      >
                        Filter
                      </div>
                      {d.addresses
                        .filter((addr) => addr.is_active)
                        .map((addr) => {
                          const isAddrActive = isThisDomain && selectedAddress === addr.id && !catchAllOnly;
                          return (
                            <button
                              key={addr.id}
                              onClick={() => {
                                onDomainChange(d);
                                onAddressChange(addr.id);
                                onFolderChange("inbox");
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1 rounded-lg text-[12px] transition-all"
                              style={{
                                color: isAddrActive ? "var(--mc-accent)" : "var(--mc-text-faint)",
                                backgroundColor: isAddrActive ? "var(--mc-accent-bg)" : "transparent",
                                fontWeight: isAddrActive ? 500 : 400,
                              }}
                              onMouseEnter={(e) => {
                                if (!isAddrActive) {
                                  e.currentTarget.style.color = "var(--mc-text-secondary)";
                                  e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (!isAddrActive) {
                                  e.currentTarget.style.color = "var(--mc-text-faint)";
                                  e.currentTarget.style.backgroundColor = "transparent";
                                }
                              }}
                            >
                              <User className="h-3 w-3" />
                              <span className="flex-1 text-left truncate">{addr.address}</span>
                            </button>
                          );
                        })}
                      {d.catch_all_enabled && onCatchAllToggle && (
                        (() => {
                          const isCatchActive = isThisDomain && catchAllOnly;
                          return (
                            <button
                              onClick={() => onCatchAllToggle(d)}
                              className="w-full flex items-center gap-2 px-3 py-1 rounded-lg text-[12px] transition-all"
                              style={{
                                color: isCatchActive ? "var(--mc-accent)" : "var(--mc-text-faint)",
                                backgroundColor: isCatchActive ? "var(--mc-accent-bg)" : "transparent",
                                fontWeight: isCatchActive ? 500 : 400,
                              }}
                              onMouseEnter={(e) => {
                                if (!isCatchActive) {
                                  e.currentTarget.style.color = "var(--mc-text-secondary)";
                                  e.currentTarget.style.backgroundColor = "var(--mc-bg-hover)";
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (!isCatchActive) {
                                  e.currentTarget.style.color = "var(--mc-text-faint)";
                                  e.currentTarget.style.backgroundColor = "transparent";
                                }
                              }}
                              title="Show only catch-all mail (no matching local-part)"
                            >
                              <Shield className="h-3 w-3" />
                              <span className="flex-1 text-left truncate">Catch-all only</span>
                            </button>
                          );
                        })()
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Add Domain */}
          <button
            onClick={onAddDomain}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] transition-all"
            style={{ color: "var(--mc-text-faint)" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--mc-accent)";
              e.currentTarget.style.backgroundColor = "var(--mc-accent-bg)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--mc-text-faint)";
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Add Domain
          </button>
        </div>

        {/* Bottom — Push Notifications */}
        <div className="mt-2 pt-2 space-y-1" style={{ borderTop: "1px solid var(--mc-border)" }}>
          {pushSupported && (
            <button
              onClick={handleTogglePush}
              disabled={pushLoading}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] transition-all"
              style={{
                color: pushEnabled ? "var(--mc-success)" : "var(--mc-text-faint)",
                backgroundColor: pushEnabled ? "rgba(52, 199, 89, 0.12)" : "transparent",
              }}
            >
              {pushLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : pushEnabled ? (
                <Bell className="h-3.5 w-3.5" />
              ) : (
                <BellOff className="h-3.5 w-3.5" />
              )}
              <span className="flex-1 text-left">
                {pushLoading
                  ? "Loading..."
                  : pushEnabled
                  ? "Notifications ON"
                  : "Enable Notifications"}
              </span>
              {pushEnabled && (
                <span
                  className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{
                    backgroundColor: "rgba(52, 199, 89, 0.12)",
                    color: "var(--mc-success)",
                  }}
                >
                  LIVE
                </span>
              )}
            </button>
          )}

          {pushEnabled && (
            <button
              onClick={async () => {
                try {
                  const res = await apiFetch("/api/email/push-test", { method: "POST" });
                  const data = await res.json();
                  if (data.success) {
                    alert("✅ Test push sent! Check your notifications.");
                  } else {
                    alert(`❌ Push test failed: ${data.error || JSON.stringify(data.results)}`);
                  }
                } catch (e: any) {
                  alert(`❌ Error: ${e.message}`);
                }
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] transition-all hover:opacity-80"
              style={{ color: "var(--mc-text-faint)" }}
            >
              <span>🧪</span>
              <span>Test Push</span>
            </button>
          )}

          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] transition-colors"
            style={{ color: "var(--mc-text-faint)" }}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 transition-transform duration-500 ${
                refreshing ? "animate-spin" : ""
              }`}
              style={{ color: refreshing ? "var(--mc-accent)" : undefined }}
            />
            <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* Settings Panel (popup modal) */}
      {settingsDomain && (
        <DomainSettingsPanel
          domain={settingsDomain}
          onClose={() => setSettingsDomain(null)}
          onRefresh={() => {
            onRefreshDomains();
          }}
        />
      )}
    </>
  );
}
