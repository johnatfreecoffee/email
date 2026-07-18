// Favorites v2 — pinnable mailboxes with persistent order.
// Stored as { v: 2, items: FavoriteRef[] } under "email.favorites.v2";
// migrates the legacy folder-type list ("email-favorite-items") in place.

export type FavoriteRef =
  | { kind: "folder"; folder: string } // aggregate across domains (All Inboxes, Sent, …) — fixed names
  | { kind: "domain-folder"; domainId: string; folder: string; label?: string }
  | { kind: "address"; domainId: string; addressId: string; label?: string }
  | { kind: "catchall"; domainId: string; label?: string };

const V2_KEY = "email.favorites.v2";
const LEGACY_KEY = "email-favorite-items";
const DEFAULT_LEGACY = ["inbox", "sent", "drafts", "starred"];

const FOLDER_IDS = ["inbox", "sent", "drafts", "starred", "archive", "spam", "trash"];

export function favKey(ref: FavoriteRef): string {
  switch (ref.kind) {
    case "folder":
      return `folder:${ref.folder}`;
    case "domain-folder":
      return `dfolder:${ref.domainId}:${ref.folder}`;
    case "address":
      return `addr:${ref.domainId}:${ref.addressId}`;
    case "catchall":
      return `catchall:${ref.domainId}`;
  }
}

export function isValidRef(r: unknown): r is FavoriteRef {
  if (!r || typeof r !== "object") return false;
  const ref = r as Record<string, unknown>;
  switch (ref.kind) {
    case "folder":
      return typeof ref.folder === "string" && FOLDER_IDS.includes(ref.folder);
    case "domain-folder":
      return typeof ref.domainId === "string" && typeof ref.folder === "string" && FOLDER_IDS.includes(ref.folder as string);
    case "address":
      return typeof ref.domainId === "string" && typeof ref.addressId === "string";
    case "catchall":
      return typeof ref.domainId === "string";
    default:
      return false;
  }
}

export function loadFavorites(): FavoriteRef[] {
  try {
    const raw = localStorage.getItem(V2_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 2 && Array.isArray(parsed.items)) {
        return parsed.items.filter(isValidRef);
      }
    }
  } catch {}

  // First run on v2: migrate the legacy folder-type list, preserving order.
  let legacy: string[] = DEFAULT_LEGACY;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const strings = parsed.filter((x): x is string => typeof x === "string" && FOLDER_IDS.includes(x));
        if (strings.length > 0) legacy = strings;
      }
    }
  } catch {}
  const items: FavoriteRef[] = legacy.map((folder) => ({ kind: "folder", folder }));
  saveFavorites(items);
  return items;
}

export function saveFavorites(items: FavoriteRef[]) {
  try {
    localStorage.setItem(V2_KEY, JSON.stringify({ v: 2, items }));
  } catch {}
}
