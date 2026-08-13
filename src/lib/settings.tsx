"use client";

// Roaming preferences: server-synced key/value settings with a localStorage
// cache for instant boot and full offline/pre-migration fallback.
//
// Flow: defaults → cache (or legacy localStorage keys, first run) → server
// fetch (server wins per key, except keys with pending local writes) →
// one-time push-up of keys the server doesn't have yet. Writes are
// optimistic with a per-key debounce; dirty keys flush on pagehide.

import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, useAuth } from "@/lib/auth";
import { type FavoriteRef, isValidRef, loadFavorites } from "@/components/email/favorites";
import { isValidNotificationSound, type NotificationSoundName } from "@/lib/notification-sound";

const API = "/api/email/settings";
const CACHE_KEY = "email.settings.cache";
const WRITE_DEBOUNCE_MS = 800;
const REFRESH_STALE_MS = 60_000;

export type SettingsTab =
  | "general"
  | "accounts"
  | "junk"
  | "appearance"
  | "viewing"
  | "composing"
  | "signatures"
  | "rules"
  | "privacy";

export interface SidebarSettings {
  collapsedDomains: string[];
  favoritesVisible: boolean;
  /** Domain ids whose "Addresses" sub-list is expanded. Empty = all collapsed
   *  (the default — the address list is hidden until the user opens it). */
  expandedAddresses: string[];
}
export interface FavoritesSettings {
  v: 2;
  items: FavoriteRef[];
}
export interface ViewingSettings {
  desktopView: "stacked" | "columns";
  showCatchAllInInbox: boolean;
  /** null = never auto-mark read; 0 = immediately; else seconds */
  markReadDelaySeconds: number | null;
  previewLines: 1 | 2;
  /** Group messages into conversations (Apple Mail style). Default on. */
  threadConversations: boolean;
  /** Per-domain overrides for threading. Missing key = use threadConversations. */
  threadDomainOverrides: Record<string, boolean>;
}
export interface ComposingSettings {
  defaultAddressId: string | null;
  signaturePlacement: "above" | "below";
}
export interface JunkSettings {
  llmAssist: boolean;
  threshold: number;
}
export interface PrivacySettings {
  blockRemoteContent: boolean;
}
export interface NotificationsSettings {
  /** Play an in-app alert tone when new mail arrives while the app is open. */
  soundOnNewEmail: boolean;
  /** Which tone to play. */
  sound: NotificationSoundName;
  /** When false, catch-all mail does not trigger a push notification. */
  pushCatchAll: boolean;
}
export interface SignaturesSettings {
  byAddressId: Record<string, { html: string; enabled: boolean }>;
}

export interface EmailSettings {
  sidebar: SidebarSettings;
  favorites: FavoritesSettings;
  viewing: ViewingSettings;
  composing: ComposingSettings;
  junk: JunkSettings;
  privacy: PrivacySettings;
  signatures: SignaturesSettings;
  notifications: NotificationsSettings;
}

export const SETTINGS_DEFAULTS: EmailSettings = {
  sidebar: { collapsedDomains: [], favoritesVisible: true, expandedAddresses: [] },
  favorites: { v: 2, items: [] },
  viewing: {
    desktopView: "stacked",
    showCatchAllInInbox: false,
    markReadDelaySeconds: 0,
    previewLines: 2,
    threadConversations: true,
    threadDomainOverrides: {},
  },
  composing: { defaultAddressId: null, signaturePlacement: "above" },
  junk: { llmAssist: true, threshold: 0.7 },
  privacy: { blockRemoteContent: false },
  signatures: { byAddressId: {} },
  notifications: { soundOnNewEmail: true, sound: "chime", pushCatchAll: true },
};

const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS) as Array<keyof EmailSettings>;

// ---------- Normalizers: unknown JSON → trusted shapes (unknown fields survive) ----------

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function normalize<K extends keyof EmailSettings>(key: K, raw: unknown): EmailSettings[K] {
  const d = SETTINGS_DEFAULTS[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  switch (key) {
    case "sidebar": {
      const out: SidebarSettings = {
        ...(r as object),
        collapsedDomains: Array.isArray(r.collapsedDomains)
          ? r.collapsedDomains.filter((x): x is string => typeof x === "string")
          : [],
        favoritesVisible: bool(r.favoritesVisible, true),
        expandedAddresses: Array.isArray(r.expandedAddresses)
          ? r.expandedAddresses.filter((x): x is string => typeof x === "string")
          : [],
      };
      return out as EmailSettings[K];
    }
    case "favorites": {
      const items = Array.isArray(r.items) ? r.items.filter(isValidRef) : [];
      return { ...(r as object), v: 2, items } as EmailSettings[K];
    }
    case "viewing": {
      const overridesRaw = r.threadDomainOverrides;
      const overrides: Record<string, boolean> = {};
      if (overridesRaw && typeof overridesRaw === "object" && !Array.isArray(overridesRaw)) {
        for (const [k, v] of Object.entries(overridesRaw as Record<string, unknown>)) {
          if (typeof v === "boolean") overrides[k] = v;
        }
      }
      const out: ViewingSettings = {
        ...(r as object),
        desktopView: r.desktopView === "columns" ? "columns" : "stacked",
        showCatchAllInInbox: bool(r.showCatchAllInInbox, false),
        markReadDelaySeconds:
          r.markReadDelaySeconds === null
            ? null
            : r.markReadDelaySeconds === 1.5
              ? 0 // old default → instant (John: speed is key)
              : num(r.markReadDelaySeconds, 0),
        previewLines: r.previewLines === 1 ? 1 : 2,
        // Default ON (Apple Mail). Only false when explicitly set.
        threadConversations: r.threadConversations === false ? false : true,
        threadDomainOverrides: overrides,
      };
      return out as EmailSettings[K];
    }
    case "composing": {
      const out: ComposingSettings = {
        ...(r as object),
        defaultAddressId: typeof r.defaultAddressId === "string" ? r.defaultAddressId : null,
        signaturePlacement: r.signaturePlacement === "below" ? "below" : "above",
      };
      return out as EmailSettings[K];
    }
    case "junk": {
      const out: JunkSettings = {
        ...(r as object),
        llmAssist: bool(r.llmAssist, true),
        threshold: Math.min(0.95, Math.max(0.3, num(r.threshold, 0.7))),
      };
      return out as EmailSettings[K];
    }
    case "privacy": {
      const out: PrivacySettings = {
        ...(r as object),
        blockRemoteContent: bool(r.blockRemoteContent, false),
      };
      return out as EmailSettings[K];
    }
    case "notifications": {
      const out: NotificationsSettings = {
        ...(r as object),
        soundOnNewEmail: bool(r.soundOnNewEmail, true),
        sound: isValidNotificationSound(r.sound) ? r.sound : "chime",
        pushCatchAll: bool(r.pushCatchAll, true),
      };
      return out as EmailSettings[K];
    }
    case "signatures": {
      const by = r.byAddressId;
      const clean: SignaturesSettings["byAddressId"] = {};
      if (by && typeof by === "object" && !Array.isArray(by)) {
        for (const [id, sig] of Object.entries(by as Record<string, unknown>)) {
          if (sig && typeof sig === "object") {
            const s = sig as Record<string, unknown>;
            clean[id] = { html: typeof s.html === "string" ? s.html : "", enabled: bool(s.enabled, true) };
          }
        }
      }
      return { ...(r as object), byAddressId: clean } as EmailSettings[K];
    }
    default:
      return d;
  }
}

function normalizeAll(raw: Partial<Record<string, unknown>>): EmailSettings {
  const out = { ...SETTINGS_DEFAULTS };
  for (const key of SETTINGS_KEYS) {
    if (key in raw) (out as Record<string, unknown>)[key] = normalize(key, raw[key]);
  }
  return out;
}

// ---------- Legacy localStorage → first-run settings ----------

function readLegacy(): Partial<EmailSettings> {
  const out: Partial<EmailSettings> = {};
  try {
    const collapsedRaw = localStorage.getItem("email-collapsed-domains");
    const favVisRaw = localStorage.getItem("email-favorites-visible");
    out.sidebar = {
      collapsedDomains: collapsedRaw ? (JSON.parse(collapsedRaw) as string[]).filter((x) => typeof x === "string") : [],
      favoritesVisible: favVisRaw === null ? true : favVisRaw === "true",
      expandedAddresses: [],
    };
  } catch {}
  try {
    out.favorites = { v: 2, items: loadFavorites() };
  } catch {}
  try {
    out.viewing = {
      ...SETTINGS_DEFAULTS.viewing,
      showCatchAllInInbox: localStorage.getItem("mc.email.showCatchAll") === "true",
    };
  } catch {}
  return out;
}

// ---------- Context ----------

interface SettingsContextType {
  settings: EmailSettings;
  /** localStorage cache/legacy applied — gate sidebar first paint on this */
  hydrated: boolean;
  /** null = fetch in flight; false = needs migration or fetch failed */
  serverAvailable: boolean | null;
  needsMigration: boolean;
  updateSetting: <K extends keyof EmailSettings>(key: K, patch: Partial<EmailSettings[K]>) => void;
  replaceSetting: <K extends keyof EmailSettings>(key: K, value: EmailSettings[K]) => void;
  refetch: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType>({
  settings: SETTINGS_DEFAULTS,
  hydrated: false,
  serverAvailable: null,
  needsMigration: false,
  updateSetting: () => {},
  replaceSetting: () => {},
  refetch: async () => {},
});

export function useSettings() {
  return useContext(SettingsContext);
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [settings, setSettings] = useState<EmailSettings>(SETTINGS_DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);
  const [needsMigration, setNeedsMigration] = useState(false);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const dirtyKeys = useRef<Set<keyof EmailSettings>>(new Set());
  const writeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastFetchAt = useRef(0);
  const migrationBlocked = useRef(false);

  const recache = useCallback((s: EmailSettings) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, settings: s }));
    } catch {}
  }, []);

  // 1. Hydrate from cache / legacy keys
  useEffect(() => {
    let base: EmailSettings | null = null;
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.v === 1 && parsed.settings) base = normalizeAll(parsed.settings);
      }
    } catch {}
    if (!base) {
      base = normalizeAll(readLegacy() as Record<string, unknown>);
      // favorites default seeding happens in readLegacy via loadFavorites
    }
    setSettings(base);
    recache(base);
    setHydrated(true);
  }, [recache]);

  const sendPatch = useCallback(
    async (key: keyof EmailSettings, keepalive = false) => {
      if (migrationBlocked.current) return;
      const value = settingsRef.current[key];
      try {
        const res = await apiFetch(API, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
          keepalive,
        });
        if (res.ok) {
          dirtyKeys.current.delete(key);
        } else if (res.status === 503) {
          const body = await res.json().catch(() => null);
          if (body?.needs_migration) {
            migrationBlocked.current = true;
            setNeedsMigration(true);
            setServerAvailable(false);
          }
        }
        // other failures: key stays dirty; retried on next flush/refetch cycle
      } catch {
        // network error — stays dirty
      }
    },
    []
  );

  const scheduleWrite = useCallback(
    (key: keyof EmailSettings) => {
      dirtyKeys.current.add(key);
      const existing = writeTimers.current.get(key);
      if (existing) clearTimeout(existing);
      writeTimers.current.set(
        key,
        setTimeout(() => {
          writeTimers.current.delete(key);
          sendPatch(key);
        }, WRITE_DEBOUNCE_MS)
      );
    },
    [sendPatch]
  );

  const applyLocal = useCallback(
    (key: keyof EmailSettings, value: EmailSettings[keyof EmailSettings]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        settingsRef.current = next;
        recache(next);
        return next;
      });
      scheduleWrite(key);
    },
    [recache, scheduleWrite]
  );

  const updateSetting = useCallback(
    <K extends keyof EmailSettings>(key: K, patch: Partial<EmailSettings[K]>) => {
      applyLocal(key, { ...settingsRef.current[key], ...patch });
    },
    [applyLocal]
  );

  const replaceSetting = useCallback(
    <K extends keyof EmailSettings>(key: K, value: EmailSettings[K]) => {
      applyLocal(key, normalize(key, value));
    },
    [applyLocal]
  );

  // 2. Server fetch + merge + one-time push-up
  const refetch = useCallback(async () => {
    try {
      const res = await apiFetch(API);
      if (!res.ok) {
        setServerAvailable(false);
        return;
      }
      lastFetchAt.current = Date.now();
      const body = (await res.json()) as {
        settings: Record<string, unknown> | null;
        needs_migration: boolean;
      };
      if (body.needs_migration || body.settings === null) {
        migrationBlocked.current = true;
        setNeedsMigration(true);
        setServerAvailable(false);
        return;
      }
      migrationBlocked.current = false;
      setNeedsMigration(false);
      setServerAvailable(true);

      const server = body.settings;
      // Merge: server wins per key, except keys with pending local writes.
      setSettings((prev) => {
        const next = { ...prev };
        for (const key of SETTINGS_KEYS) {
          if (key in server && !dirtyKeys.current.has(key)) {
            (next as Record<string, unknown>)[key] = normalize(key, server[key]);
          }
        }
        settingsRef.current = next;
        recache(next);
        return next;
      });

      // Push up keys the server doesn't have (first sync from this device)
      const missing = SETTINGS_KEYS.filter((k) => !(k in server));
      if (missing.length > 0) {
        const payload: Record<string, unknown> = {};
        for (const k of missing) payload[k] = settingsRef.current[k];
        await apiFetch(API, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: payload }),
        }).catch(() => {});
      }
    } catch {
      setServerAvailable(false);
    }
  }, [recache]);

  useEffect(() => {
    if (!token || !hydrated) return;
    refetch();
  }, [token, hydrated, refetch]);

  // 3. Flush dirty keys on hide; refetch on refocus when stale
  useEffect(() => {
    const flush = () => {
      for (const key of Array.from(dirtyKeys.current)) {
        const t = writeTimers.current.get(key);
        if (t) {
          clearTimeout(t);
          writeTimers.current.delete(key);
        }
        sendPatch(key, true);
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        flush();
      } else if (token && Date.now() - lastFetchAt.current > REFRESH_STALE_MS && !migrationBlocked.current) {
        refetch();
      }
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sendPatch, refetch, token]);

  return (
    <SettingsContext.Provider
      value={{ settings, hydrated, serverAvailable, needsMigration, updateSetting, replaceSetting, refetch }}
    >
      {children}
    </SettingsContext.Provider>
  );
}
