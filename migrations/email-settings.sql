-- ============================================================
-- Email settings — single-tenant key/value store for roaming
-- preferences. One row per namespaced settings document.
--
-- The app degrades gracefully until this is applied:
-- GET /api/email/settings returns { needs_migration: true } and
-- the client keeps everything in localStorage.
-- ============================================================

CREATE TABLE IF NOT EXISTS email_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Canonical keys and value shapes (documented, not enforced —
-- shapes version by additive fields; never repurpose a field,
-- add a new one and let client normalizers default it).
--
-- 'sidebar'    {"collapsedDomains": ["<domain uuid>", ...],
--               "favoritesVisible": true}
--
-- 'favorites'  {"v": 2, "items": [FavoriteRef, ...]}
--              FavoriteRef (matches src/components/email/favorites.ts):
--                {"kind":"folder","folder":"inbox"}
--                {"kind":"domain-folder","domainId":"…","folder":"sent"}
--                {"kind":"address","domainId":"…","addressId":"…"}
--                {"kind":"catchall","domainId":"…"}
--
-- 'viewing'    {"desktopView": "stacked" | "columns",
--               "showCatchAllInInbox": false,
--               "markReadDelaySeconds": 1.5,   -- null = never, 0 = instant
--               "previewLines": 2}             -- 1 | 2
--
-- 'composing'  {"defaultAddressId": null,      -- email_addresses.id or null
--               "signaturePlacement": "above"} -- "above" | "below" the quote
--
-- 'junk'       {"llmAssist": true,
--               "threshold": 0.7}              -- 0.5..0.9, spam at/above
--
-- 'privacy'    {"blockRemoteContent": false}
--
-- 'signatures' {"byAddressId": {"<address uuid>":
--                 {"html": "<p>…</p>", "enabled": true}}}
--
-- Rules live in their own email_rules table (migrations/email-rules.sql);
-- the Settings → Rules tab only hosts that UI.
-- ------------------------------------------------------------
