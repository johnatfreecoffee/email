# Mission Control Email — System Brain (fork reference)

> The complete, standalone knowledge required to rebuild and iterate the Mission Control (MC) email application as its own app. This is a **Resend-only** email client: inbound mail arrives via a Resend webhook → Cloudflare Pages Function → Supabase; a static Next.js UI reads/writes via `/api/email/*` Pages Functions; outbound goes through the Resend send API. Everything server-side is a Cloudflare Pages Function; all secrets live there.

---

## 1. TL;DR

- **What it is:** a single-tenant, Resend-backed webmail client. Inbound mail → Resend receives on AWS SES infra → Resend POSTs a thin webhook to `POST /api/email/inbound` → the function fetches full message detail from Resend, classifies spam, stores into Supabase `email_messages`, uploads attachments to Supabase Storage, and fires a Web Push. Outbound → `POST /api/email/send` → Resend `POST /emails`.
- **Frontend:** Next.js 16 App Router, **static export** (`output: "export"` → `out/`). There are **no Next API routes / server components at request time** — 100% of server logic is Cloudflare Pages Functions under `functions/api/**`, served at `/api/**`.
- **Backend:** Cloudflare Pages Functions (TypeScript/JS, Web Crypto + `fetch` only, no Node deps). All Supabase access is PostgREST over `${SUPABASE_URL}/rest/v1` using the **service-role key** (bypasses RLS). No RLS policies exist on any email table — access control is entirely app-layer via `checkAuth()`.
- **Auth:** a custom `X-MC-Auth` request header carrying an opaque token, validated against the Supabase `mc_sessions` table, with a static legacy back-door token `[redacted]` (= `legacyHashPassword("[redacted]")`). The inbound webhook is **unauthenticated and unsigned**.
- **Storage:** one central `email_messages` table + `email_domains`, `email_addresses`, `email_attachments`, `email_sender_reputation`, `email_drafts`, `email_contacts`, `mc_sessions`, `mc_push_subscriptions`. Attachment bytes go to the private Supabase Storage bucket `email-attachments`.
- **Push:** self-contained RFC 8291 (aes128gcm) + RFC 8292 (VAPID) Web Push implemented in `_web-push.ts` — no external push service; pushes go straight to the browser vendor endpoint stored per-subscription. Spam mail never pushes.
- **Spam:** heuristic + optional OpenRouter free-LLM classifier (`_spam.ts`), memoized per-sender in `email_sender_reputation`. Threshold `0.7`. Fully degradable if `OPENROUTER_KEY` is unset.
- **History to respect:** the system was Migadu + IMAP until the **2026-05-16 Resend-only cutover**. All Migadu/IMAP code, env vars, and DNS mirror subdomains were removed; some vestigial DB columns and a dead `/api/email/sync` cron remain. **Do not revive the Migadu stack.**

---

## 2. Architecture & data flow

### Inbound path
1. Mail is sent to `<local>@<domain>` where the domain's apex `MX` points at `inbound-smtp.us-east-1.amazonaws.com` (Resend on AWS SES `us-east-1`).
2. Resend accepts mail for **any** local-part on a verified domain and POSTs a **thin** webhook to `POST /api/email/inbound` (`payload.type` = `email.received`). The webhook contains only ids/addresses/subject, often with a **bare `from` address (display name stripped)**.
3. `inbound.ts` fetches the **full email** from Resend (`GET /emails/receiving/{email_id}`) to obtain `html`, `text`, and raw `headers`.
4. It reconstructs the sender display name from the raw `From:` header (see §11 `from_name` gotcha), decodes RFC 2047 encoded-words, resolves the recipient domain/mailbox (with catch-all handling), classifies spam, and inserts one `email_messages` row (`direction=inbound`).
5. Attachments are fetched from Resend, uploaded to Supabase Storage bucket `email-attachments`, and recorded in `email_attachments`.
6. Contacts are auto-learned (fire-and-forget `POST /api/email/contacts`).
7. If not spam, a Web Push is broadcast to all active `mc_push_subscriptions`.
8. A separate `email.sent` webhook event captures outbound mail Resend delivered that did **not** go through `send.ts` (e.g. an external SMTP client), deduped by `resend_email_id`, into the Sent folder.

### Outbound path
1. UI `POST /api/email/send` (auth-gated) → `send.ts` validates, builds a Resend payload, calls `POST https://api.resend.com/emails`.
2. On success, inserts an `email_messages` row (`direction=outbound`, `folder=sent`, `is_read=true`) — this row is what dedupes the later `email.sent` webhook.
3. Outbound attachments (base64 in the request) are decoded, uploaded to Storage, recorded in `email_attachments`. Contacts auto-learned.

### Storage / push
- All rows in Supabase (PostgREST, service-role key). Attachment bytes in Storage bucket `email-attachments` (private). Sessions in `mc_sessions`. Push subs in `mc_push_subscriptions`.

### ASCII flow diagram
```
                         ┌───────────────────────────────────────────────┐
   Sender ──SMTP──►  Resend (AWS SES us-east-1, MX inbound-smtp...)       │
                         │  POST webhook (thin payload)                   │
                         ▼                                                │
             POST /api/email/inbound  (Cloudflare Pages Function)         │
                 │  GET /emails/receiving/{id}  (full email) ◄───────────┘
                 │  resolveFrom() + decodeMimeWords()
                 │  domain/address/catch-all resolution
                 │  classifySpam() ── OpenRouter (optional)
                 ├──► INSERT email_messages (direction=inbound)
                 ├──► Storage: email-attachments/{domain}/{msg_id}/{file}
                 ├──► POST /api/email/contacts  (auto-learn)
                 └──► broadcastPush() ──► browser push endpoints (if !spam)

   Static UI (out/) ──apiFetch(X-MC-Auth)──► /api/email/*  (Pages Functions)
        │  GET messages/unread-counts/drafts/contacts/domains
        │  POST /api/email/send ──► Resend POST /emails ──► INSERT (outbound)
        │                                     ▲
        └── external SMTP client ──► Resend ──┘  email.sent webhook
                                              └► dedupe by resend_email_id → INSERT (sent)

                 All DB access: {SUPABASE_URL}/rest/v1/*  (service-role key, no RLS)
```

---

## 3. External services

The email subsystem talks to exactly **four** external services (confirmed by grepping `functions/api/email/`: only outbound hosts are `api.resend.com`, `api.cloudflare.com`, `openrouter.ai`, `${SUPABASE_URL}/rest/v1`, plus self-referential `mission-control-806.pages.dev`).

### 3.1 Resend (email provider — inbound + outbound + webhooks)
- **API base:** `https://api.resend.com`. Auth: `Authorization: Bearer ${RESEND_API_KEY}` (helper `resendAPI()`).
- **Inbound MX host:** every managed domain's apex `MX → inbound-smtp.us-east-1.amazonaws.com` (priority `10`). Return-path/DKIM/SPF use `*.amazonses.com`.
- **Inbound webhook target:** `https://mission-control-806.pages.dev/api/email/inbound`, event `email.received` (and `email.sent` is handled). **Must be re-pointed to the fork's hostname.** No Svix/Resend signature verification is performed — authenticated only by URL obscurity + re-fetch by id.
- **Endpoints called:**
  - `GET /emails/receiving/{id}` — full received email (`html`, `text`, `headers`, `reply_to`, `raw.download_url`, attachments).
  - `GET /emails/receiving/{id}/attachments` — signed attachment download URLs.
  - `GET /emails/{id}` — full **sent** email (used by the `email.sent` handler).
  - `POST /emails` — outbound send.
  - `POST /domains` — create (`{ name, capabilities: { sending:"enabled"|"disabled", receiving:"enabled"|"disabled" } }`).
  - `GET /domains`, `GET /domains/{id}`, `PATCH /domains/{id}`, `POST /domains/{id}/verify`, `DELETE /domains/{id}`.
- **Domain verification statuses (stored verbatim):** `pending, verifying, verified, failed, temporary_failure, not_started`. Local `email_domains.status` is set to `active` only when Resend reports `verified`.

### 3.2 Supabase (database + storage + session auth)
- **Project ref:** `YOUR_PROJECT_REF`. **Region:** West US / Oregon (`us-west-2`).
- **Project URL:** `https://YOUR_PROJECT_REF.supabase.co` (= `SUPABASE_URL` = `NEXT_PUBLIC_SUPABASE_URL`).
- **Direct Postgres pooler:** `aws-0-us-west-2.pooler.supabase.com:6543`.
- **Access:** Pages Functions hit PostgREST at `${SUPABASE_URL}/rest/v1{path}` using the **service-role key** as both `apikey` and `Authorization: Bearer` (bypasses RLS). `Prefer: return=representation` always set, so all mutations echo rows. The static frontend uses the **anon key** via `@supabase/supabase-js` (only for the unrelated `/inbox` feed; the `/email` app does not use it).
- **Storage:** private bucket `email-attachments`, path pattern `{domain}/{message_id}/{filename}`. Object I/O via `${SUPABASE_URL}/storage/v1/object/email-attachments/{path}` (Bearer = service key). Public read URL form: `${SUPABASE_URL}/storage/v1/object/public/email-attachments/{storage_path}`.
- **Role keys:** service-role key = `SUPABASE_SERVICE_KEY` (most sensitive value in the stack); anon key = `NEXT_PUBLIC_SUPABASE_ANON_KEY`. A `SUPABASE_ANON_KEY` runtime var is listed for CF Pages but email code paths use only the service key.
- **Shared-project caveat:** this Supabase project is shared with the noknok ops app; `noknok-*.sql` migrations belong to a different scope. The email fork owns `email_*`, `mc_sessions`, `mc_push_subscriptions`, and the `email-attachments` bucket.

### 3.3 Cloudflare (Pages + Functions + DNS)
- **Pages** hosts the static `out/` site and the Functions.
  - Primary project name: **`mission-control`**. Production URL: **`https://mission-control-806.pages.dev`**.
  - Secondary mirror project: **`branson-snap`** (`branson-snap.pages.dev`) — deploy pushes the same `out/` build; **not email-relevant, drop in the fork.**
  - **Account ID:** `YOUR_CF_ACCOUNT_ID`. SSL auto for `*.pages.dev`.
- **DNS API base:** `https://api.cloudflare.com/client/v4`. Auth: `Authorization: Bearer ${CLOUDFLARE_API_TOKEN}` (helper `cloudflareDNS()`).
  - `GET /zones?name=<domain>` (zone lookup, walks subdomain suffixes so `mail.example.com` finds `example.com`).
  - `GET /zones/{zoneId}/dns_records?type=&name=`, `POST /zones/{zoneId}/dns_records`, `DELETE /zones/{zoneId}/dns_records/{recordId}`.
  - DNS writes are idempotent (skip when content matches), always `ttl: 1` (auto), `proxied: false` for TXT/MX/CNAME; MX carries `priority`.
  - Token must carry **Pages:Edit + Zone DNS:Edit + Zone:Read** across all 8 zones.

### 3.4 OpenRouter (spam classification — optional)
- Endpoint: `POST https://openrouter.ai/api/v1/chat/completions`. Auth: `Authorization: Bearer ${OPENROUTER_KEY}`. Extra headers: `HTTP-Referer: https://mission-control-806.pages.dev`, `X-Title: Mission Control Email Spam Filter`.
- Guarded by `if (!env.OPENROUTER_KEY) return null;` — entirely optional. Models: `FREE_MODELS = ["google/gemini-2.0-flash-exp:free", "meta-llama/llama-3.3-70b-instruct:free"]`.

### 3.5 VAPID / Web Push
- No external service — RFC 8291 (aes128gcm) encryption + RFC 8292 (VAPID) signing done in `_web-push.ts` with Web Crypto; POSTs directly to each subscription's browser push endpoint (e.g. `https://fcm.googleapis.com`). Audience derived per-endpoint as `${protocol}//${host}`. Default VAPID subject `mailto:admin@cleanenergyexperts.pro` (change for the fork). Keys `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are base64url raw P-256 (public = 65-byte uncompressed point, private = raw 32-byte scalar).

---

## 4. The 8 managed domains

All eight have apex `MX → inbound-smtp.us-east-1.amazonaws.com`, are verified for sending+receiving in Resend, and have DNS in the single Cloudflare account. Rows live in `email_domains`. New domains are onboarded programmatically via `POST /api/email/domains` (Resend + Cloudflare DNS, no dashboard steps).

1. **cleanenergyexperts.pro** — primary/default (hardcoded example `from`, default VAPID subject, CEE marketing account).
2. **mycart.cloud**
3. **enrollme.us**
4. **gcliar.com**
5. **meetjack.online**
6. **worships.love**
7. **clearhome.pro**
8. **noknok.pro**

---

## 5. Backend API reference

All routes are Cloudflare Pages Functions under `functions/api/email/` (route path = file path minus `functions` prefix and extension). Each handler exports `onRequest(context: { request, env })`. Every handler short-circuits `OPTIONS` → `optionsResponse(origin)` (204), then (except the inbound webhook) calls `checkAuth`. Inputs come from query string (`?id=`, `?domain_id=`, `?q=`) or JSON body — no dynamic path params.

### 5.1 Core mail flow

#### `POST /api/email/inbound` (`inbound.ts`) — **UNAUTHENTICATED, unsigned**
Resend's single webhook for all events; multiplexes on `payload.type`.
- Non-POST → `200 "OK"` (bare text). Invalid JSON → `400 {"error":"Invalid JSON"}`.
- `email.delivered` / `email.bounced` / `email.complained` → `console.log` + `200 "OK"`, **no DB write** (a `delivery_status` column does not exist yet — TODO at inbound.ts:284; deliverability is currently dropped).
- `email.sent` → `handleEmailSent` (dedupe by `resend_email_id`; fetches `GET /emails/{id}`; inserts `direction=outbound, folder=sent, is_read=true` only if from one of our domains and not already logged).
- `email.received` → main inbound path: fetch full email, resolve from/domain/address/catch-all, spam-classify, insert `email_messages` (direction=inbound), store attachments, auto-learn contacts, push (if not spam). On insert failure → `500 {"error":"Failed to store email"}` (Resend retries). Mail to unknown domains → `200 "OK"` and silently dropped. Success → `200 {received:true, message_id}` (spam → `{received:true, message_id, spam:true}`).

#### `POST /api/email/send` (`send.ts`) — **auth-gated**
- `OPTIONS` → 204; `checkAuth`; non-POST → `405 {"error":"Method not allowed"}`.
- Body: `{ from, to[], cc?, bcc?, subject, html?, text?, reply_to?, in_reply_to?, domain_id?, address_id?, attachments?[{filename, content(base64), content_type}] }`. Required: `from, to, subject`.
- Calls `resendAPI POST /emails`. On `!ok` → `400 "Send failed: <json>"`. Inserts `email_messages` (outbound). Uploads attachments to Storage. Auto-learns contacts. **Gotcha:** `in_reply_to` is persisted to DB (send.ts:114) but **not** forwarded to Resend (no wire-level `In-Reply-To`/`References`).
- Success → `200 {sent:true, resend_id, message}`.

### 5.2 Messages / drafts / counts

#### `GET|PATCH|DELETE /api/email/messages` (`messages.ts`) — auth-gated
- **GET single** (`?id=<uuid>`): `email_messages?id=eq.&select=*`; 404 if none; attaches `attachments` array (from `email_attachments?message_id=eq.&order=filename.asc`). Returns full row incl. body/headers/threading/spam fields.
- **GET list** (no id): query params below. Returns array of trimmed rows; **`body_text` is stripped** and a 120-char `preview` added. Sorted `received_at DESC`. Failure → `500`.
  | Param | Default | Meaning |
  |---|---|---|
  | `folder` | `inbox` | special: `starred`, `trash`, `all`; else literal (`inbox/sent/spam/archive/…`) |
  | `domain_id` | — | `domain_id=eq.` |
  | `address_id` | — | `address_id=eq.` |
  | `is_starred` | — | `"true"`→`is_starred=eq.true` |
  | `is_read` | — | `"true"/"false"` |
  | `is_spam` | — | `"true"/"false"` |
  | `is_catch_all` | — | `"true"/"false"` |
  | `show_catchall` | `false` | `"true"` blends catch-alls into inbox |
  | `search` | — | ILIKE over subject/from_address/body_text (value sanitized: `,()"'\` stripped + URL-encoded before interpolation) |
  | `limit` | `50` | capped at **500** |
  | `offset` | `0` | offset pagination (ignored when `cursor` present) |
  | `count_only` | `false` | `"true"` → `{count}` via `Prefer: count=exact`, `Range: 0-0`, `content-range` header (legacy; app no longer calls it) |
  | `cursor` | — | **keyset cursor** (opaque base64url of last row's `{ts: received_at, id}`); switches response to the envelope |
  | `with_total` | `false` | `"true"` → envelope response with `total` for the filter set (rides the list query via `Prefer: count=exact`; **always `null` when `search` present** — counting an ilike scan trips the statement timeout) |
  | `has_attachments` | `false` | `"true"` → only messages with ≥1 attachment (`email_attachments!inner` embed; rows arrive with a populated `attachments` array) |
  - Sort is `received_at.desc,id.desc` (stable tiebreak for bulk-imported rows sharing timestamps).
  - **Envelope mode** (when `cursor` or `with_total` sent): `{ messages, total: number|null, next_cursor: string|null, has_more: boolean }`. Without those params the response stays the legacy bare array — old clients/open tabs unaffected. `next_cursor` is built server-side from the last row; echo it back verbatim for the next page. Malformed cursors → `400`.
  - Folder→filter: `starred`→`is_starred=eq.true&is_trash=eq.false`; `trash`→`is_trash=eq.true`; `all`→`is_trash=eq.false`; else→`folder=eq.<f>&is_trash=eq.false&is_archived=eq.false`.
  - Catch-all default: if `is_catch_all` param absent, defaults to `"false"` **only when** `folder==="inbox"` and `show_catchall!=="true"`; otherwise no filter. So plain inbox hides catch-alls.
  - Address + show_catchall + inbox → OR filter `or=(address_id.eq.<id>,is_catch_all.eq.true)`. The keyset filter uses a top-level `and=(or(received_at.lt.…,and(received_at.eq.…,id.lt.…)))` wrapper so it can't collide with these `or=` params; the timestamp is percent-encoded (timestamptz contains `+`).
- **PATCH**: body `{ id? | ids?: string[], is_read?, is_starred?, is_archived?, is_trash?, is_spam?, folder? }`. One of `id`/`ids` required; `ids` (bulk, ≤500 UUID-validated entries) updates every row via `id=in.(…)` and returns the updated **array** (single `id` keeps returning the object). `is_spam=true` forces `folder="spam"`; `is_spam=false` with no explicit folder forces `folder="inbox"`. **Side effect** when `is_spam` present: upserts `email_sender_reputation` once per **distinct** sender in the result (PATCH-then-POST) with `verdict=spam|trusted`, `spam_score=1.0|0.0`, `user_override=true`. This is the mark-read mechanism (`{id, is_read:true}`).
- **DELETE** (`?id=`): **hard permanent delete** (`DELETE email_messages?id=eq.`; cascades attachments). Soft-delete = PATCH `is_trash:true`. Any other method → `405`.

#### `GET|POST|PATCH|DELETE /api/email/drafts` (`drafts.ts`) — auth-gated
CRUD over `email_drafts` (a table with **no migration** — dashboard-created).
- **GET** `?id=` → single row or 404; no id → `order=updated_at.desc&limit=50` (fixed cap, no pagination).
- **POST** (create): short client field names mapped to DB columns:
  `from→from_address`, `to→to_addresses`, `cc→cc_addresses`, `bcc→bcc_addresses`, `subject→subject`, `html→body_html`, `text→body_text`, `domain_id→domain_id`, `reply_to_message_id→reply_to_message_id`, `compose_mode→compose_mode`(default `"new"`). Returns `201` with row; failure → `500`.
- **PATCH** (`{id(req), ...}`): always sets `updated_at`. Only maps `from/to/cc/bcc/subject/html/text`. **Not updatable:** `domain_id`, `reply_to_message_id`, `compose_mode`. **Bug:** always returns `200 {updated:true}` without checking `res.ok`.
- **DELETE** (`?id=`): always `200 {deleted:true}` (also unchecked).

#### `GET /api/email/unread-counts` (`unread-counts.ts`) — auth-gated, GET only
Computes per-domain/per-folder unread badges with **3 total queries** (deliberately avoids per-domain queries to stay under CF's 50-subrequest limit; `MAX_ROWS=5000`):
1. `email_domains?select=id` (seed zeros).
2. All non-trash unread rows (`is_read=eq.false&is_trash=eq.false&limit=5000`).
3. Unread trash rows.
Tally: `domains[id]+=1`; folder bucket (mutually exclusive): `is_archived`→archive; `folder==="spam"||is_spam`→spam; `folder==="sent"`→sent; `folder==="inbox"`→`catchall` if `is_catch_all` else `inbox`; else `is_catch_all`→catchall. Separately, `is_starred`→also `starred+=1` (double-counts). Trash rows → domain `trash` bucket.
Response: `{domains:{[id]:n}, folders:{[id]:{inbox,sent,starred,archive,trash,spam,catchall}}, totals:{…}}`.

### 5.3 Domains / addresses / contacts

#### `GET|POST|DELETE /api/email/domains` (`domains.ts`) — auth-gated
- **GET**: `email_domains?order=created_at.desc`, then N+1 enrichment — per domain `email_addresses?domain_id=eq.&select=id,address,display_name,is_active,mc_user_id` attached as `domain.addresses` (domains.ts:144). (Note: `mc_user_id` in this select must be removed in the fork — see §7 legacy.)
- **POST** (onboard): body `{ domain, force_replace_mx?, check_only? }`. Normalizes `domain` lowercase/trim.
  - Zone discovery walks subdomain suffixes. Existing-MX lookup if zone found.
  - `check_only:true` → `200 {has_conflict, existing_mx[], provider, suggested_subdomain, zone_found, zone_name}`. `provider` inferred from MX substrings (google/gmail→"Google Workspace", outlook/microsoft→"Microsoft 365", zoho→"Zoho Mail", proton→"ProtonMail", icloud→"iCloud Mail", else heuristic / "Unknown").
  - MX conflict (not check-only, existing MX, no force) → `409 {conflict:true, provider, existing_mx[], suggested_subdomain, message}`.
  - `force_replace_mx:true` → deletes each existing MX whose content lacks `amazonaws.com`/`amazonses.com`.
  - Calls `setupResendDomain(env, domain, zoneId, undefined, zoneName)`. On failure → `502`. Success → `201 {domain(row), dns_auto_configured, resend_domain_id, records, mx_replaced}`.
  - **`setupResendDomain`:** create in Resend (or find existing + PATCH receiving) → push each returned DNS record to Cloudflare (name resolved relative to zone apex; idempotent; ttl 1; proxied false; MX priority) → `POST /domains/{id}/verify` → upsert `email_domains` (`status = zoneId ? "dns_configured" : "pending"`). Record contents are **provider-shape-driven** (code iterates whatever Resend returns, hardcodes nothing except the amazon MX-conflict check).
- **DELETE** (`?id=`): fetch row; if `resend_domain_id`, `DELETE api.resend.com/domains/{id}`; then FK-safe: `email_addresses` → `email_messages` → `email_domains` by `domain_id`/`id`. Returns `{deleted:true, domain}`. **Leaves Cloudflare DNS in place.**

#### `POST /api/email/domains-verify` (`domains-verify.ts`) — auth-gated, POST only
Client-polled verification. Body `{ domain_id?, resend_domain_id(req) }`. Triggers `POST /domains/{id}/verify`, then `GET /domains/{id}` → `{status, records}` (500 if fetch fails). If `domain_id`, PATCH `email_domains` `{status: verified→"active" else verbatim, dns_records, updated_at}`. Returns `200 {status, records}`.

#### `PATCH|POST /api/email/domains-settings` (`domains-settings.ts`) — auth-gated
Catch-all metadata only. Body `{ domain_id(req), catch_all_enabled?, catch_all_subject_prefix?, catchall_destination_address_id? }`. Verifies domain exists (else 404). `catchall_destination_address_id` non-null is validated to belong to this domain (else `400`); `null` clears it. No updatable field → `400 {"error":"No fields to update"}`. Returns updated row.

#### `GET|POST|PATCH|DELETE /api/email/addresses` (`addresses.ts`) — auth-gated
Sending addresses / aliases (local-part rows). No Resend provisioning call (Migadu mailbox provisioning retired).
- **GET** `?domain_id=` (req) → `order=address.asc`.
- **POST** `{domain_id, address, display_name?}`. Normalizes `localPart = address.toLowerCase().trim().replace(/@.*$/,"")`; rejects empty or `/[^a-z0-9._-]/` → `400`. Uniqueness enforced by index `(domain_id,address)`. Returns `201`.
- **PATCH** `?id=` `{display_name?, address?}`. Same normalization; collision check on rename → `409`. Neither field → `400`.
- **DELETE** `?id=` → `{deleted:true}`.

#### `GET|POST /api/email/contacts` (`contacts.ts`) — auth-gated
Auto-built address book (compose autocomplete + most-contacted).
- **GET** `?q=&limit=` (limit default 10): with `q` → `or=(email.ilike.%q%,display_name.ilike.%q%)&order=send_count.desc,receive_count.desc&limit=`; without `q` → most-contacted. Returns array (never surfaces DB errors as 500 — returns `data || []`).
- **POST** (upsert, called internally by send/inbound): body `{ contacts:[{email, display_name?, direction:"sent"|"received"}] }`. Per contact: lowercase/trim email, skip if empty or no `@`. Exists → PATCH increment `send_count`+`last_sent_at` or `receive_count`+`last_received_at`; sets `display_name` only if incoming present AND stored empty (**never overwrites a name**). New → POST insert. Returns `200 {processed, results:[{email, action}]}`.

### 5.3b Settings / senders / rules (added 2026-07-18)

#### `GET|PATCH|PUT /api/email/settings` (`settings.ts`) — auth-gated
Roaming preferences over the `email_settings` KV table (`migrations/email-settings.sql` — **must be pasted in the Supabase SQL editor**; until then GET returns `{settings: null, needs_migration: true}` (200) and writes 503, and the client stays on localStorage).
- **GET** → `{settings: {key: value}, needs_migration}`. Keys: `sidebar, favorites, viewing, composing, junk, privacy, signatures` (shapes documented in the migration file).
- **PATCH** `{key, value}` — whole-document upsert per key (PATCH-then-POST idiom; 100KB cap; unknown key → 400).
- **PUT** `{settings: {…}}` — bulk upsert (one-time first-sync push-up from a device).
- Server-side reader for Functions: `_settings.ts` `readSetting(env, key, fallback)` — never throws; used by inbound.ts for junk settings.
- Client: `src/lib/settings.tsx` `SettingsProvider`/`useSettings()` — localStorage cache (`email.settings.cache`), legacy-key migration, optimistic writes with per-key 800ms debounce, keepalive flush on hide, refocus refetch (>60s). Device-local by design: theme, pane/column widths, per-domain address stickiness.

#### `GET|PATCH|DELETE /api/email/senders` (`senders.ts`) — auth-gated
Sender-reputation management for Settings → Junk Mail (existing `email_sender_reputation` table, no migration).
- **GET** `?verdict=spam|trusted&search=&limit=&offset=` → rows ordered `last_seen_at desc`.
- **PATCH** `{from_address, verdict}` → flip with `user_override=true`. **DELETE** `?from_address=` → forget (classified fresh next time).

#### `GET|POST|PATCH|DELETE /api/email/rules` (`rules.ts`) — auth-gated
Delivery rules over `email_rules` (`migrations/email-rules.sql`; GET returns `[]` pre-migration, writes 503).
- Row: `{name, is_active, priority, match_type: all|any, conditions: [{field: from|to|subject, op: contains|equals|ends_with, value}], actions: [{type: move_folder|mark_read|flag|junk|trash, folder?: inbox|archive}], domain_id|null}`.
- **POST** validates (≤20 conditions, ≤10 actions, enums, UUIDs) and appends at `max(priority)+1`. **PATCH** `{id, …partial}` or `{reorder: [ids]}` (rewrites priorities). **DELETE** `?id=`.
- **Delivery integration** (`inbound.ts` + `_rules.ts`): after spam classify, active rules (global + matching domain) evaluate against `{from, to[], subject}` in priority order; ALL matching rules apply, later wins. Actions mirror messages.ts PATCH semantics — `move_folder inbox` rescues from a spam verdict (clears is_spam/archived/trash), `archive`→`is_archived`, `junk`→`is_spam`+folder spam, `trash`→`is_trash`. A bad rule never fails the webhook. **Push gating**: notifications fire only when the final delivery state is inbox + unread + not spam/trash/archived.
- **Junk settings** thread into `classifySpam(input, env, junk)`: `threshold` replaces the 0.7 const at all 3 decision points; `llmAssist=false` skips the OpenRouter loop (reason `llm_disabled`).

### 5.4 Push

#### `GET|POST|DELETE /api/email/push` (`push.ts`) — auth-gated (non-OPTIONS)
- **GET** → `{vapidPublicKey: env.VAPID_PUBLIC_KEY || ""}` (push.ts:22-23) (note: frontend does NOT call this — it hardcodes the key).
- **POST** `{subscription, label?}` (requires `subscription.endpoint`, else 400). Upsert on `endpoint`: exists → PATCH (`subscription_json`, `label`, `is_active:true`, `updated_at`) → `{subscribed:true, updated:true}`; else POST insert → `201 {subscribed:true}`.
- **DELETE** `{endpoint}` → hard row delete → `{unsubscribed:true}`. Other method → 405.

#### `POST /api/email/push-test` (`push-test.ts`) — auth-gated, POST only
Fetches active subs; none → `{success:false, error:"No active push subscriptions found…", subscriptionCount:0}`. Requires both VAPID keys (else 500). Broadcasts a fixed test payload. 404/410 results → `is_active:false`. Returns `{success, results:[{id,success,status,error}], subscriptionCount}`.

### 5.5 NOT an email endpoint — `functions/api/inbox.js` → `/api/inbox`
Legacy JS Pages Function for MC's **issue tracker** (`mc_issues`, `mc_issue_read_states`, `mc_issue_comments`), not mail. Different auth (no `X-MC-Auth`; `SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY`), different CORS, hardcoded `userId='john'`. **Do not carry into the fork.** It never touches `email_*` and does not overlap any email endpoint.

### 5.6 External non-email endpoint the UI calls
- `POST /api/notifications` (`functions/api/notifications.ts`, out of scope) — fired best-effort when new inbox mail appears on page 1 (max 3). Not under `/api/email/*`.

---

## 6. Auth model

- **Header:** custom **`X-MC-Auth: <token>`** (NOT `Authorization`). The frontend `apiFetch` injects it from `localStorage["mc-auth-token"]`.
- **`checkAuth(request, env): Promise<Response|null>`** — returns `null` on pass, a 401 `Response` on fail. Callers: `const err = await checkAuth(...); if (err) return err;`.
  1. No token → `401 {"error":"Unauthorized"}`.
  2. If `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` present, validate against `mc_sessions`:
     `GET {SUPABASE_URL}/rest/v1/mc_sessions?token=eq.{urlenc(token)}&expires_at=gte.{now ISO}&limit=1` (headers `apikey` + `Bearer` = service key). Non-empty → pass.
  3. **Legacy fallback:** if empty, `token === legacyHashPassword("[redacted]")` → pass; else `401 {"error":"Invalid or expired session"}`.
  4. **If env URL/key absent → validation skipped, any non-empty token accepted.** Never deploy without those set.
- **`legacyHashPassword(password)`** — DJB-ish 32-bit string hash (`hash = ((hash<<5)-hash)+char; hash|=0`), returned as `"mc_" + Math.abs(hash).toString(16)`. For `"[redacted]"` it produces the literal token **`[redacted]`** — a static shared-secret back door. Decide deliberately whether to keep/rotate/remove; removing it 401s any client still sending it.
  - (Note: an alternate slice mentions an `mc_5ff3c6`-style value as illustrative; the verified constant for `"[redacted]"` is `[redacted]`.)
- **`MC_API_SECRET`** is referenced by the original prompt/onboarding but is **NOT read anywhere** in the email functions (grep-confirmed absent from `functions/api/email/`). The live auth is session-token-based. `NEXT_PUBLIC_MC_API_SECRET` is a build-time public var (baked into JS, low security). If the fork wants a simpler `X-MC-Auth: <MC_API_SECRET>` model, it must be added.
- **Service-role usage:** every Supabase call from the functions uses `SUPABASE_SERVICE_KEY` as both `apikey` and `Bearer` — bypasses RLS. Single-tenant; no per-user row scoping. The inbound webhook is **unauthenticated and unsigned** (Resend cannot send `X-MC-Auth`); consider adding Resend/Svix signature verification when hardening.
- **CORS** (`corsHeaders`): `Access-Control-Allow-Origin` = request `Origin` or `*`; Methods `GET, POST, PATCH, DELETE, OPTIONS`; Headers `Content-Type, Authorization, X-MC-Auth`; Max-Age `86400`. `optionsResponse` → 204.
- **Fork guidance:** replace `mc_sessions` + the hardcoded password, but keep the `X-MC-Auth` header name and the `checkAuth → Response|null` contract every endpoint depends on. Front-end token obtained via `POST /api/auth/login` → `{token, user}`, validated on mount via `GET /api/auth/me`.

---

## 7. Database schema

Shared Supabase project `YOUR_PROJECT_REF`. **No RLS / GRANT / policies on any email table** — access control is app-layer only. Six migration files exist; two tables (`email_drafts`, `email_contacts`) have **no migration** (dashboard-created) and must be authored by the fork.

### 7.1 CURRENT tables (adopt these)

#### `email_domains` (`email-tables.sql` + `email-catchall-destination.sql`)
| Column | Type | Default / Constraints |
|---|---|---|
| `id` | UUID | PK `gen_random_uuid()` |
| `domain` | TEXT | NOT NULL, **UNIQUE** (lowercase/trim) |
| `resend_domain_id` | TEXT | nullable |
| `status` | TEXT | NOT NULL default `'pending'`; free-text values `pending, dns_configured, verifying, verified, active, failed` (no CHECK) |
| `dns_records` | JSONB | nullable |
| `cloudflare_zone_id` | TEXT | nullable |
| `capabilities` | JSONB | default `'{"sending":true,"receiving":true}'` |
| `catch_all_enabled` | BOOLEAN | NOT NULL default `false` |
| `catch_all_subject_prefix` | TEXT | NOT NULL default `'[Catch-All]'` |
| `catchall_destination_address_id` | UUID | nullable, **FK → email_addresses(id) ON DELETE SET NULL** |
| `created_at`, `updated_at` | TIMESTAMPTZ | NOT NULL `now()` |

Index: `idx_email_domains_catchall_dest` on `(catchall_destination_address_id) WHERE … IS NOT NULL` (partial).

#### `email_addresses` (`email-tables.sql`; base columns only for the fork)
| Column | Type | Default / Constraints |
|---|---|---|
| `id` | UUID | PK `gen_random_uuid()` |
| `domain_id` | UUID | NOT NULL, **FK → email_domains(id) ON DELETE CASCADE** |
| `address` | TEXT | NOT NULL — **local part only**, no `@` |
| `display_name` | TEXT | nullable |
| `is_active` | BOOLEAN | NOT NULL default `true` |
| `created_at` | TIMESTAMPTZ | NOT NULL `now()` |

Index: `idx_email_addresses_unique` UNIQUE on `(domain_id, address)`.

#### `email_messages` (`email-tables.sql` + `email-spam.sql`) — the mail store
| Column | Type | Default / Constraints |
|---|---|---|
| `id` | UUID | PK `gen_random_uuid()` |
| `domain_id` | UUID | FK → email_domains(id) |
| `address_id` | UUID | FK → email_addresses(id) |
| `resend_email_id` | TEXT | nullable — **inbound dedupe key** |
| `direction` | TEXT | NOT NULL, **CHECK IN ('inbound','outbound')** |
| `from_address` | TEXT | NOT NULL |
| `from_name` | TEXT | nullable |
| `to_addresses` | JSONB | NOT NULL default `'[]'` |
| `cc_addresses` | JSONB | default `'[]'` |
| `bcc_addresses` | JSONB | default `'[]'` |
| `reply_to` | TEXT | nullable |
| `subject` | TEXT | nullable |
| `body_text` | TEXT | nullable |
| `body_html` | TEXT | nullable |
| `headers` | JSONB | nullable (inbound / email.sent only) |
| `in_reply_to` | TEXT | nullable (set by send.ts only) |
| `thread_id` | UUID | nullable (**never populated** — no server threading) |
| `is_read` | BOOLEAN | NOT NULL default `false` |
| `is_starred` | BOOLEAN | NOT NULL default `false` |
| `is_archived` | BOOLEAN | NOT NULL default `false` |
| `is_trash` | BOOLEAN | NOT NULL default `false` |
| `is_draft` | BOOLEAN | NOT NULL default `false` (unused by drafts endpoint) |
| `is_catch_all` | BOOLEAN | NOT NULL default `false` (inbound only) |
| `folder` | TEXT | NOT NULL default `'inbox'`; values `inbox/sent/spam` (trash/archive are flags) |
| `received_at` | TIMESTAMPTZ | NOT NULL `now()` — sort key |
| `created_at` | TIMESTAMPTZ | NOT NULL `now()` |
| `is_spam` | BOOLEAN | NOT NULL default `false` (`email-spam.sql`) |
| `spam_score` | REAL | nullable (0.0–1.0) |
| `spam_reason` | TEXT | nullable (snake_case / `heuristic:…` / `cached_spam` / `classifier_error`) |
| `spam_checked_at` | TIMESTAMPTZ | nullable |

Indexes: `idx_email_messages_domain(domain_id)`, `_address(address_id)`, `_folder(folder,is_trash,is_archived)`, `_thread(thread_id)`, `_received(received_at DESC)`, `_spam(is_spam,folder)`.
Consider adding `delivery_status TEXT` (TODO at inbound.ts:284) to capture Resend delivery/bounce/complaint events.

#### `email_attachments` (`email-tables.sql`)
| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK `gen_random_uuid()` |
| `message_id` | UUID | NOT NULL, **FK → email_messages(id) ON DELETE CASCADE** |
| `filename` | TEXT | NOT NULL |
| `content_type` | TEXT | nullable |
| `size_bytes` | INTEGER | nullable |
| `storage_path` | TEXT | nullable — `{domain}/{message_id}/{filename}` or `pending/{emailId}/{filename}` on download failure |
| `created_at` | TIMESTAMPTZ | NOT NULL `now()` |

Index: `idx_email_attachments_message(message_id)`. Storage bucket `email-attachments` (private) created out-of-band: `INSERT INTO storage.buckets (id,name,public) VALUES ('email-attachments','email-attachments',false);`.

#### `email_sender_reputation` (`email-spam.sql`)
| Column | Type | Constraints |
|---|---|---|
| `from_address` | TEXT | **PRIMARY KEY** (lowercased sender; the natural key) |
| `verdict` | TEXT | NOT NULL, **CHECK IN ('spam','trusted','unknown')** |
| `spam_score` | REAL | nullable |
| `last_seen_at` | TIMESTAMPTZ | NOT NULL `now()` |
| `sample_count` | INT | NOT NULL default `1` (read, not written by current code) |
| `user_override` | BOOLEAN | NOT NULL default `false` |
| `updated_at` | TIMESTAMPTZ | NOT NULL `now()` |

Index: `idx_email_sender_reputation_verdict(verdict)`. (No `created_at` column — the migration defines exactly the seven columns above.)

#### `mc_push_subscriptions` (push storage)
| Column | Type | Notes |
|---|---|---|
| `id` | UUID/PK | PATCH target `?id=eq.` |
| `endpoint` | TEXT | push service URL; **upsert key** — add a UNIQUE index |
| `subscription_json` | JSONB | full `PushSubscriptionJSON` `{endpoint, expirationTime, keys:{p256dh,auth}}` |
| `label` | TEXT | device label; default `"Unknown Device"` |
| `is_active` | BOOLEAN | set `false` on 404/410 from push service |
| `created_at` | TIMESTAMPTZ | default |
| `updated_at` | TIMESTAMPTZ | set on PATCH |

#### `mc_sessions` (auth)
At minimum `token` (TEXT), `expires_at` (TIMESTAMPTZ). Validated by `checkAuth`.

#### `email_drafts` — **NO MIGRATION** (author it)
| Column | Type (inferred) | Notes |
|---|---|---|
| `id` | UUID | PK `gen_random_uuid()` |
| `from_address` | TEXT | nullable |
| `to_addresses` | JSONB | default `'[]'` |
| `cc_addresses` | JSONB | default `'[]'` |
| `bcc_addresses` | JSONB | default `'[]'` |
| `subject` | TEXT | default `''` |
| `body_html` | TEXT | default `''` |
| `body_text` | TEXT | default `''` |
| `domain_id` | UUID | nullable, FK → email_domains(id) |
| `reply_to_message_id` | UUID | nullable, FK → email_messages(id) |
| `compose_mode` | TEXT | default `'new'` (also reply/forward) |
| `created_at` | TIMESTAMPTZ | default `now()` |
| `updated_at` | TIMESTAMPTZ | default `now()`, auto-update on PATCH (list orders by it) |

#### `email_contacts` — **NO MIGRATION** (author it)
```sql
CREATE TABLE email_contacts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,          -- lowercased/trimmed natural key
  display_name text,
  send_count int not null default 0,
  receive_count int not null default 0,
  last_sent_at timestamptz,
  last_received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```
Recommend a composite index on `(send_count DESC, receive_count DESC)` to back autocomplete ordering.

**Fork DDL ordering note:** `email_domains.catchall_destination_address_id → email_addresses(id)` and `email_addresses.domain_id → email_domains(id)` are mutually referential — create both tables without that one FK, then `ALTER TABLE email_domains ADD` the `catchall_destination_address_id` FK afterward (as the current two migrations do). No RLS needed to match current behavior.

### 7.2 Legacy / do not carry over (Migadu + IMAP)
All add columns to `email_addresses`; grep confirms **zero reads/writes** in `functions/api/email/*.ts`. In the fork, `email_addresses` collapses to exactly its `email-tables.sql` definition.
- From `email-mailboxes.sql`: `is_mailbox BOOLEAN`, `migadu_provisioned_at TIMESTAMPTZ`, `mc_user_id UUID FK → mc_users(id) ON DELETE SET NULL`. **`mc_user_id` is still named in a `select` in `domains.ts` (~line 144) — drop the column AND remove it from that select, or the query errors** (`mc_users` won't exist standalone). Drop indexes `idx_email_addresses_mc_user`, `idx_email_addresses_mailbox`.
- From `email-imap-credentials.sql`: `imap_credential_encrypted JSONB`, `imap_backfill_status TEXT`, `imap_backfill_at`, `imap_last_polled_at`.
- From `email-imap-backfill-progress.sql`: `imap_backfill_progress JSONB`, index `idx_email_addresses_backfill_in_progress`.

---

## 8. Frontend architecture

Framework: Next.js **16.1.6** App Router, React **19.2.3**, Tailwind **v4**, shadcn/ui. Every email component is `"use client"`.

### Routes
- **`/email`** (`src/app/email/page.tsx`) — the real client. Trivial shell: `<Sidebar/>` + `<TopNav/>` + `<main className="pt-14 mc-content-offset"><EmailLayout/></main>`. Owns no state.
- **`/inbox`** (`src/app/inbox/page.tsx`) — **NOT email.** A Linear-style unified activity feed reading Supabase directly (`mc_issues`, `mc_issue_read_states`, `mc_issue_comments`, `mc_approvals`, `mc_notifications`, `mc_agent_runs`+`mc_agents`). Shares no components with email. Do not port.

### Settings window (added 2026-07-18)
`src/components/email/settings/` — Apple Mail-style Settings modal (gear in the sidebar footer; per-domain gear deep-links to Accounts). Tabs: **General** (push toggle/test via shared `usePush()` hook, banner reset) · **Accounts** (domain rail + `domain-account-detail.tsx`: Account Information/Addresses/Catch-All/Danger; "+" embeds `DomainSetupCard`; replaces the deleted DomainSettingsPanel) · **Junk Mail** (AI toggle, threshold slider, sender lists via /senders) · **Appearance** (theme, device-local) · **Viewing** (stacked|columns desktop list, preview lines, mark-read delay, catch-alls-in-inbox) · **Composing** (default From, signature placement) · **Signatures** (per-address RichEditor) · **Rules** (full manager, dnd reorder) · **Privacy** (block remote content). `MigrationNotice` shows copy-paste SQL while `needs_migration`. Sidebar: "Mailboxes" header with one smart Collapse All/Expand All toggle; collapse state + favorites roam via settings.

### Desktop list views
`viewing.desktopView` picks **MessageListVirtual** (stacked preview rows, previewLines 1|2 → 68/84px) or **MessageTable** (column layout, resurrected: sortable From/Subject/Date over loaded rows with a display↔parent index mapping so clicks/j/k/ranges/auto-read always act on the visible row; publishes display order via `onDisplayOrderChange` so the layout's global j/k follows the sort). Mobile always uses cards. Reader honors `privacy.blockRemoteContent` via `remote-content.ts` (attribute-rename neutralization + per-message session reveal banner). Compose honors `composing.defaultAddressId` + per-address signatures (pristine-swap on From change; drafts untouched).

### Component tree (email) — post Apple Mail revamp (2026-07-18)
```
/email (page.tsx)
└─ EmailLayout (email-layout.tsx)          ← owns ALL data + state
   ├─ [push banner]                        ← inline JSX
   ├─ FolderList (folder-list.tsx)         ← SidebarRow-based; Favorites v2 (favorites.ts), ThemeMenu, push, refresh
   │   └─ DomainSettingsPanel (domain-settings-panel.tsx)  ← addresses / catch-all / danger
   ├─ MessageList (message-list.tsx)       ← search, filter chips, bulk bar, "N new" chip
   │   ├─ MessageListVirtual (message-list-virtual.tsx) ← DESKTOP (md+): stacked 84px preview rows, virtualized
   │   └─ MessageRow (inline in message-list.tsx) ← MOBILE: swipeable cards + IntersectionObserver load-more
   ├─ MessageReader (message-reader.tsx)   ← right column / mobile bottom sheet
   │   └─ MobileReaderSheet (inline in email-layout.tsx)
   ├─ ComposeModal (compose-modal.tsx)     ← new/reply/reply-all/forward + drafts
   │   ├─ AddressAutocomplete (address-autocomplete.tsx)
   │   └─ RichEditor (rich-editor.tsx)     ← Tiptap WYSIWYG
   ├─ DomainSetup (domain-setup.tsx)       ← add-domain wizard (MX-conflict flow)
   └─ [keyboard shortcuts help modal]      ← inline JSX
```
Shared interfaces `EmailDomain`, `EmailAddress`, `EmailMessage` are **exported from `email-layout.tsx`**; date helpers live in `format.ts`. `message-table.tsx` (old column grid) is deleted.

### Who owns what
- **EmailLayout** — single source of truth: the `loadPage("reset"|"more"|"poll")` fetch pipeline, request guards (generation counter + AbortController), optimistic unread accounting (`applyUnreadTransitions` + `primaryBucket`, an exact mirror of unread-counts.ts bucket rules), debounced 1.5s count reconcile (seq-guarded), polling, keyboard shortcuts, resizable panes, mobile view switching.
- **FolderList** — Favorites v2 (typed refs in `localStorage["email.favorites.v2"]`, dnd reorder via @hello-pangea/dnd in Edit mode, legacy `email-favorite-items` migrates on first load), theme menu (`useTheme`), push toggle/test, refresh.
- **MessageListVirtual** — virtualization + multi-select/keyboard; renders in server order (no client sort).
- **AddressAutocomplete / RichEditor / ComposeModal / DomainSettingsPanel / DomainSetup** — make their own `/api/email/*` calls for local concerns.

### Theme system
- Tokens: `src/styles/theme.css` (`--mc-*`) + shadcn block in `globals.css` — `:root` = light, `.dark` = dark. Apple palette (accent `#007AFF`/`#0A84FF`; success/warning/danger/star = Apple system colors). System font stack; `--radius: 0.5rem`; touch rules (44px/16px) scoped to `@media (pointer: coarse)`.
- `src/lib/theme.tsx`: pref `system|light|dark` in `localStorage["mc-theme"]` (legacy values parse); matchMedia tracking while `system`; applied class = `.dark` + `data-theme`. **No-flash inline script in `layout.tsx` head** (static export) sets the class pre-paint. Never remove a `--mc-*` name — inline styles depend on them.

### Auth surface (`src/lib/auth.tsx`)
- `apiFetch(url, init?)` — the ONLY way email talks to the backend; merges `authHeaders()` = `{ "X-MC-Auth": localStorage["mc-auth-token"] }`; `init.signal` passes through (list resets abort in-flight requests). Single-tenant login gate (hardcoded email/password) seeds the token from `NEXT_PUBLIC_MC_API_SECRET`.

### EmailLayout data flow (all via `apiFetch`, `API_BASE="/api/email"`)
- **`loadPage(kind)`** is the single list pipeline consuming the envelope API:
  - `reset` — any filter/folder/domain/address/search change or manual refresh: `limit=50&with_total=true`, bumps a generation counter and aborts in-flight; replaces the accumulated list; stores `next_cursor`/`has_more`. Stale responses (older generation) are dropped.
  - `more` — infinite scroll: `cursor=<next_cursor>`, appends with id-dedup.
  - `poll` — 30s/visibility: first page + total, **merged in place** (flag-field refresh only; tail rows never removed). New arrivals prepend when scrolled to top, else buffer into `pendingNew` → "N new messages" chip.
- `totalCount` is `null` during search (server skips the count); the list header shows `N+ results` instead.
- Search input debounces 300ms before committing to the fetch-driving query.
- **Counts**: every mutation reports `(before, after)` unread-flag pairs to `applyUnreadTransitions` — correct buckets incl. catch-all, starred-additive, trash; bulk ops = one `ids[]` PATCH + one batched count update; then a debounced 1.5s `fetchUnreadCounts()` reconciles (seq guard prevents older responses clobbering newer).
- Other calls: `fetchDomains`, `fetchUnreadCounts`, `fetchFullMessage` (GET ?id → PATCH is_read), `fetchDrafts`, `bulkPatch(ids, updates)`.

### Polling & lifecycle
- On mount: `fetchDomains()` + SW `"message"` listener (notification-click → `loadPage("poll")` + open message via `loadPageRef`).
- **30s** `loadPage("poll")` + **60s** `fetchUnreadCounts`, both gated on `!document.hidden && !isMobileReaderOpen`; `visibilitychange` runs both.
- List-header refresh = `loadPage("reset")` + `fetchUnreadCounts` (+drafts in drafts); sidebar refresh = `fetchDomains` + `fetchUnreadCounts`.

### Keyboard shortcuts (global keydown, ignored in inputs)
`j/↓`,`k/↑` navigate; `Enter` open; `u` read; `s` star; `c` compose; `r` reply; `Shift+R` reply-all; `f` forward; `a` archive; `Delete/Backspace` trash; `Space`/`Shift+Space` scroll reader; `Esc` close; `?` help. Auto-mark-read after 1500ms focus. (Page-turn shortcuts removed with the pager.)

### MessageList / MessageRow
Responsive via `useIsDesktop()` (`matchMedia("(min-width:768px)")`). Desktop → MessageListVirtual; mobile → date-grouped swipeable MessageRow (`Today/Yesterday/This Week/Earlier`) with an IntersectionObserver sentinel (`rootMargin: 400px`) for load-more. Owns `selectedIds:Set` (cleared on `scrollResetSignal` only — NOT on every messages change), `selectMode`, recipient dropdown. Quick filters All/Unread/Starred/Files are all server-side (`is_read`/`is_starred`/`has_attachments`). Catch-all toggle is icon-only (Shield + Eye/EyeOff). MessageRow swipe: right→toggle read, left→archive/star/trash panel.

### MessageListVirtual (desktop list)
`@tanstack/react-virtual` with per-index sizes (28px date-group headers / 84px rows), `overscan: 8`. Row = sender (semibold when unread) + flag/clip/date, subject, two-line preview, 9px blue unread dot in a 24px gutter (click toggles read). **Active row = solid `--mc-selected-bg` with white text**; multi-selected = accent tint; keyboard-focused = hover gray. Renders in parent (server) order; keyboard order always matches visual order. Multi-select: Cmd/Ctrl+click toggle, Shift+click/Shift+↑↓ range, Delete trashes. Load-more fires from the scroll handler (<800px from bottom) and a virtual-items tail effect.

### MessageReader
Toolbar (monochrome, Mail order): Reply/ReplyAll/Forward | Archive/Junk/Trash | Flag/Read. Flat gray monogram avatar; collapsed `To: … Details` line expands to full To/Cc with click-to-copy. Attachments link to `${supabaseUrl}/storage/v1/object/public/email-attachments/${storage_path}`; images thumbnail. **Body HTML rendered in a sandboxed `<iframe srcDoc>`** on a forced-white sheet (`color-scheme: light`, Apple-blue links, hairline border in dark mode) with the link-hijack that opens everything in a new tab — the security boundary for untrusted email HTML; **preserve it**. Plain text renders themed in `<pre>`. Mobile → `MobileReaderSheet` (swipe-down dismiss).

### ComposeModal / RichEditor / AddressAutocomplete
- **ComposeModal**: `fromOptions` from `domains×addresses`; fallback `John Romano <john@{domain}>`. reply-all strips own addresses; forward builds quoted block. Send → `POST /api/email/send` `{from,to[],cc?,bcc?,subject,text,html,in_reply_to?(=replyTo.resend_email_id),domain_id,address_id,attachments?}`; attachments via `FileReader.readAsDataURL` → base64. Drafts: `POST/PATCH/DELETE /api/email/drafts`; ⌘S + 30s autosave. Requires from+to+subject.
- **RichEditor**: Tiptap v3 `useEditor`+`EditorContent`. Extensions: `StarterKit({heading:false})`, Underline, TextStyle, FontSize (`@tiptap/extension-text-style/font-size` subpath), Color, Highlight(multicolor), TextAlign(paragraph), Link(openOnClick:false), Placeholder. Editor class `prose … text-[13px]`. `onUpdate` → `onHtmlChange(getHTML())`+`onTextChange(getText())`. Toolbar buttons `tabIndex=-1` + `onMouseDown preventDefault`. `@tiptap/pm` required peer dep.
- **AddressAutocomplete**: chip input, debounced 150ms → `GET /api/email/contacts?limit=5` (empty) / `?q=&limit=8`. Enter/Tab/`,` commit (needs `@`).

### FolderList (localStorage-heavy)
Keys: `email-collapsed-domains`, `email-favorites-visible`, **`email.favorites.v2`** (`{v:2, items: FavoriteRef[]}` — kinds `folder | domain-folder | address | catchall`; legacy `email-favorite-items` migrates on first load; stale refs prune once domains load), per-domain address stickiness `mc.email.address.{domainId}`, theme `mc-theme`. Rows via shared `SidebarRow` (28px, blue icon, plain right-aligned unread number, gray-pill selection). Favorites Edit mode: dnd reorder (@hello-pangea/dnd), remove buttons, `+` pins on every folder/catch-all/address row. Domain sections: health dot (red failed/error, amber pending, green active/verified), hover Settings gear → DomainSettingsPanel, Catch-All virtual folder (Shield) when `catch_all_enabled`, Addresses sublist. Folder labels are Mail-style (`Flagged`, `Junk`). Footer icon row: ThemeMenu (System/Light/Dark) · push toggle · test-push (`POST /api/email/push-test`, shown when enabled) · Refresh.

### DomainSetup / DomainSettingsPanel
- **DomainSetup**: state machine `input|checking|conflict|configuring|done|error`. `POST /api/email/domains {check_only:true}` → conflict UI or create → `POST {force_replace_mx?}` (409 re-enters conflict) → `POST /api/email/domains-verify {domain_id, resend_domain_id}`.
- **DomainSettingsPanel**: 3 tabs — Addresses (`POST/PATCH/DELETE /api/email/addresses`), Catch-All (`PATCH /api/email/domains-settings`), Danger (`DELETE /api/email/domains?id=`). Uses inline `style` objects, not Tailwind.

### Push UI (`src/lib/push-notifications.ts`)
- **Hardcoded** client `VAPID_PUBLIC_KEY = "BGPBcDA1d-bXrIIIVdERHbDHjg9-nMfwFrm7vAMm7LPs70KhR_Xg39uxaFowLYP1YeJkyKwFUyuK7WJmQKL8FjU"` (must match server key). `registerServiceWorker()` → `/sw.js` scope `/`. `subscribeToPush()` → permission + `pushManager.subscribe` → `POST /api/email/push {subscription, label}`. `unsubscribeFromPush()` → `DELETE /api/email/push {endpoint}`.
- **`public/sw.js`** (`CACHE_NAME='mc-v3'`): `push` handler shows notification (icon/badge `/mc-icon-192.png`, `tag: 'email-'+messageId`, actions Read/Dismiss); `notificationclick` → `/email?msg=<id>`, focuses/opens window and posts `{type:'notification-click', data}`.
- **UI surfaces:** dismissible blue push banner in EmailLayout (7-day dismiss via `localStorage["mc-push-banner-dismissed"]`), FolderList push toggle, Test Push.

### Shared chrome (`Sidebar`, `TopNav`) — replace for the fork
`/email/page.tsx` imports `@/components/layout/sidebar` + `top-nav` — MC's global nav (module-registry sidebar, `useAuth`, `BalanceBar`, `VoiceHeaderButton`, `NotificationBell`, theme toggle). **Replace with a minimal email-only shell.** Email module registers in `src/lib/module-registry.ts`: `{ key:"email", label:"Email", href:"/email", icon:"Mail", color:"#FB923C", defaultParent:"nightshift", defaultDashboard:true, dashboard:{…, statusKey:"email"} }`.
- **Required global CSS vars:** `--mc-bg, --mc-bg-secondary, --mc-bg-hover, --mc-bg-active, --mc-bg-panel, --mc-bg-card, --mc-border, --mc-text, --mc-text-secondary, --mc-text-muted, --mc-text-faint, --mc-accent (cyan #06B6D4), --mc-accent-bg, --mc-success, --mc-warning, --mc-danger`, plus `--mc-sidebar-w`. Utility classes `mc-content-offset`, `mc-bg-glow`. App assumes dark theme (hardcoded rgba fallbacks).

### `@/lib/supabase`
`createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY)`. **The `/email` tree does NOT use it** — only `/inbox` and (indirectly, as a string) MessageReader's attachment URL. Drop it unless porting `/inbox`.

### Dependencies to install
`next@16.1.6`, `@tanstack/react-virtual@^3.13`, `@tiptap/react@^3.20`, `@tiptap/pm@^3.20`, `@tiptap/starter-kit@^3.20`, Tiptap extensions `extension-underline/-text-style(+/font-size)/-color/-highlight/-text-align/-link/-placeholder` (all `^3.20.1`), `lucide-react@^0.577`, `@supabase/supabase-js@^2.98` (only if keeping `/inbox` or a direct client). `next/navigation` used by `/inbox` only.

### Forkable email UI files (absolute paths)
```
/Users/johnromano/Projects/mission-control/src/app/email/page.tsx
/Users/johnromano/Projects/mission-control/src/components/email/email-layout.tsx
/Users/johnromano/Projects/mission-control/src/components/email/folder-list.tsx
/Users/johnromano/Projects/mission-control/src/components/email/message-list.tsx
/Users/johnromano/Projects/mission-control/src/components/email/message-table.tsx
/Users/johnromano/Projects/mission-control/src/components/email/message-reader.tsx
/Users/johnromano/Projects/mission-control/src/components/email/compose-modal.tsx
/Users/johnromano/Projects/mission-control/src/components/email/rich-editor.tsx
/Users/johnromano/Projects/mission-control/src/components/email/domain-setup.tsx
/Users/johnromano/Projects/mission-control/src/components/email/domain-settings-panel.tsx
/Users/johnromano/Projects/mission-control/src/components/email/address-autocomplete.tsx
/Users/johnromano/Projects/mission-control/src/lib/auth.tsx          (need apiFetch + X-MC-Auth)
/Users/johnromano/Projects/mission-control/src/lib/push-notifications.ts
/Users/johnromano/Projects/mission-control/src/lib/supabase.ts        (optional)
/Users/johnromano/Projects/mission-control/public/sw.js
Replace: src/components/layout/sidebar.tsx, top-nav.tsx
NOT email (do not port): src/app/inbox/page.tsx, functions/api/inbox.js
```

---

## 9. Environment variables

Runtime vars are declared in the `Env` interface in `functions/api/email/_shared.ts` (read via `context.env`). The `Env` interface declares exactly seven: `RESEND_API_KEY`, `CLOUDFLARE_API_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `VAPID_PUBLIC_KEY?`, `VAPID_PRIVATE_KEY?`, `OPENROUTER_KEY?`. CF Pages secret/encrypted vars are **write-only — you cannot read them back**; plan rotations with plaintext in hand. `?` = optional in `Env`.

| Name | Purpose | Public/Secret | Where it lives | Known value / notes |
|---|---|---|---|---|
| `RESEND_API_KEY` | Auth for all Resend calls (send, domain create/verify, fetch detail) | Secret | CF Pages runtime | write-only in CF; required |
| `SUPABASE_URL` | PostgREST + Storage base; `mc_sessions` auth lookups | Secret-ish (runtime) | CF Pages runtime | `https://YOUR_PROJECT_REF.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Service-role key — `apikey` + `Bearer` for all email DB access; **bypasses RLS** | Secret (most sensitive) | CF Pages runtime | never expose |
| `SUPABASE_ANON_KEY` | Anon key for server-side anon reads | Secret | CF Pages runtime | listed for CF, but **not read by email code** (email uses service key) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare DNS API (onboarding) + `wrangler` deploy auth | Secret | CF Pages runtime **and** GitHub secret | needs Pages:Edit + Zone DNS:Edit + Zone:Read on all 8 zones |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler pages deploy` targeting | Not secret | GitHub secret | `YOUR_CF_ACCOUNT_ID` |
| `VAPID_PUBLIC_KEY` | Web Push public key (returned by GET /api/email/push) | Public (safe) | CF Pages runtime | optional; push disabled if unset; base64url raw P-256 |
| `VAPID_PRIVATE_KEY` | Signs Web Push VAPID JWT | Secret | CF Pages runtime | optional; base64url raw 32-byte scalar |
| `OPENROUTER_KEY` | Bearer for OpenRouter spam LLM | Secret | CF Pages runtime | optional; spam LLM skipped if unset |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL inlined into static bundle | Public (baked into JS) | GitHub build secret + `.env.local` | `https://YOUR_PROJECT_REF.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key inlined for browser reads | Public (baked into JS) | GitHub build secret + `.env.local` | JWT anon key (unknown/quoted value — pull from Secrets Vault / `~/Documents/noknok.pro/.env`) |
| `NEXT_PUBLIC_MC_API_SECRET` | Shared secret inlined so frontend can send an auth header (misleadingly `NEXT_PUBLIC_` yet onboarding says checked server-side) | Public (baked into JS) | GitHub build secret + Secrets Vault | low-security (readable from shipped JS); **not read by email functions** |
| `MC_API_SECRET` | Shared-secret concept | Secret (if used) | not referenced by email code | **not read anywhere in email functions** (grep-confirmed); live auth is session-token based |
| `MC_CRON_TOKEN` | `X-MC-Auth` token for the (dead) email-sync cron; long-lived `mc_sessions` token | Secret | GitHub secret (cron workflow) | falls back to `[redacted]` when unset; drop with the cron |

The 11 required/known env names above appear in this table; the `Env` interface in `_shared.ts` declares only the seven runtime vars listed at the top of this section. `MC_API_SECRET`, `SUPABASE_ANON_KEY`, and the `NEXT_PUBLIC_*` vars are **not read by email code** (grep-confirmed absent from `functions/api/email/`).

**Retired vars — deleted from CF Pages, do not reintroduce:** `MIGADU_API_KEY`, `MIGADU_ACCOUNT_EMAIL`, `MIGADU_MIRROR_ADDRESS`, `MAILBOX_ENC_KEY`.

Env-var usage matrix (the 3 core-flow files):
| Var | inbound.ts | send.ts | _shared.ts |
|---|---|---|---|
| `RESEND_API_KEY` | ✅ | ✅ | ✅ (decl) |
| `SUPABASE_URL` | ✅ | ✅ | ✅ |
| `SUPABASE_SERVICE_KEY` | ✅ | ✅ | ✅ |
| `VAPID_PUBLIC_KEY` | ✅ | — | decl only |
| `VAPID_PRIVATE_KEY` | ✅ | — | decl only |
| `OPENROUTER_KEY` | ✅ (via `_spam`) | — | decl only |
| `CLOUDFLARE_API_TOKEN` | — | — | ✅ (cloudflareDNS, unused by mail flow) |
| `MC_API_SECRET` / `SUPABASE_ANON_KEY` / `NEXT_PUBLIC_*` | — | — | — |

---

## 10. Deployment

### Build shape
- Next.js 16 App Router, **static export**. `next.config.ts`:
  ```ts
  const nextConfig: NextConfig = { output: "export", images: { unoptimized: true } };
  ```
  `next build` emits static site to **`out/`**. **No API routes at request time** — all server logic is CF Pages Functions at `/api/**`.
- `tsconfig.json`: `moduleResolution:"bundler"`, alias `@/* → ./src/*`, **`"exclude":["node_modules","functions"]`** — Functions are compiled by Cloudflare's Pages pipeline (esbuild), not `tsc`. Functions may be `.ts` or `.js`.
- **Node version:** `.node-version` = `20` (deploy workflow pins Node 20). `.npmrc` only a comment (does not set `optional=true`).

### Cloudflare Pages
- Primary project `mission-control` → `https://mission-control-806.pages.dev`. Mirror `branson-snap` (drop in fork). Account `YOUR_CF_ACCOUNT_ID`.

### Deploy workflow — `.github/workflows/deploy-cloudflare.yml`
Trigger: push to `main` (+ `workflow_dispatch`). No PRs — commits go straight to `main`.
1. `actions/checkout@v4`.
2. `actions/setup-node@v4` node 20.
3. Install:
   ```bash
   npm ci
   npm install --no-save lightningcss-linux-x64-gnu @tailwindcss/oxide-linux-x64-gnu
   ```
   **lightningcss/oxide linux-binary gotcha — do not remove line 2.** Tailwind v4 uses `lightningcss` + `@tailwindcss/oxide` native binaries, pinned in `optionalDependencies` (`lightningcss-linux-x64-gnu@1.31.1`, `@tailwindcss/oxide-linux-x64-gnu@4.2.1`), but `npm ci` on Ubuntu doesn't reliably pull the linux glibc build → "cannot find native binding". Force-install `--no-save`, keeping versions matched to Tailwind/lightningcss.
4. `npm run build` with build-time secrets injected (become `NEXT_PUBLIC_*` inlined): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_MC_API_SECRET`.
5. `cloudflare/wrangler-action@v3` (wranglerVersion 4): `pages deploy out --project-name=mission-control --commit-dirty=true`. Auth `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_RETRIES:"3"`.
6. Retry deploy on `if: failure()`.
7. Mirror to `branson-snap` (drop in fork).

**Deploy rule:** never `wrangler pages deploy` by hand — only `git push origin main` triggers deploys. Watch: `gh run list --repo johnatfreecoffee/mission-control --limit 3` then `gh run watch <run-id>`. Repo: `https://github.com/johnatfreecoffee/mission-control`, branch `main`; `gh` auth as `johnatfreecoffee`.

**Two env locations:** GitHub repo secrets (build-time: `NEXT_PUBLIC_*`, `CLOUDFLARE_*`, `MC_CRON_TOKEN`) vs. Cloudflare Pages env (runtime, read by Functions). **CF Pages secrets are write-only.** Global gotcha: never null-PATCH multiple CF Pages env vars in one request — it has silently wiped unrelated siblings; PATCH one var, one environment, then GET-diff.

### Cron jobs
- **`.github/workflows/email-sync-cron.yml` — VESTIGIAL/DEAD.** Schedule `*/5 * * * *` + `workflow_dispatch`; `curl -X POST https://mission-control-806.pages.dev/api/email/sync` with `X-MC-Auth: ${MC_CRON_TOKEN}` (fallback `[redacted]`); `exit 0` always. `/api/email/sync` (`sync.ts`) was deleted in the Migadu cutover → returns **405**; the cron is a harmless every-5-min no-op. **Delete this workflow and drop `MC_CRON_TOKEN` in the fork.** Do not re-implement `/api/email/sync`.

---

## 11. Gotchas & history

- **`from_name` / raw-header bug (critical, preserve the fix):** Resend's parsed `from` is frequently the **bare address** with display name stripped; the raw `From:` MIME header (in `fullEmail.headers`) retains `"Name <addr>"`. `resolveFrom(parsedFrom, getHeader(headers,"from"))` uses regex `^(.*?)\s*<([^>]+)>\s*$`, strips quotes, falls back to the raw header for the name, and runs it through `decodeMimeWords` (RFC 2047; handles `=?UTF-8?B?…?=` Base64 and `=?…?Q?…?=` Quoted-Printable, defensively never throws). **Skip the raw-header fallback → display names missing on most inbound mail; skip MIME decode → CJK/accented names render as `=?UTF-8?…?=` garbage.**
- **Historical data scar (not a bug to fix):** inbound `from_name` was NULL for messages ~2026-03-22 → 2026-05-31 (webhook parsed bare `.from`). Fixed via `resolveFrom`; ~593 rows backfilled. ~5,833 older NULLs are pre-2026-03-20 Migadu/IMAP imports with no stored headers — permanently unrecoverable; UI falls back to `from_name || from_address`.
- **`in_reply_to` not sent to Resend:** `send.ts` accepts `in_reply_to` and persists it (send.ts:114), but does **not** forward it to Resend — outbound replies are threaded only in MC's DB, not on the wire. For real RFC threading add `headers: { "In-Reply-To": … }` / `references` to the Resend payload.
- **No server-side threading:** `thread_id`/`in_reply_to`/`conversation_id` columns exist but are never populated/grouped server-side. The inbound path does not set `in_reply_to`; raw `headers` jsonb retains `In-Reply-To`/`References` if a client wants to derive threads. `messages.ts` returns a flat `received_at`-ordered list.
- **Inbound webhook is unauthenticated & unsigned:** no `checkAuth`, no Svix/Resend signature verification — authenticated only by URL obscurity + re-fetch by id. Add signature verification when hardening.
- **`checkAuth` open-fail:** if `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` are unset, any non-empty token is accepted. Never deploy without them.
- **Static back-door token `[redacted]`** (= `legacyHashPassword("[redacted]")`) authenticates as a valid legacy session regardless of `mc_sessions`. Decide keep/rotate/remove deliberately.
- **`search` param interpolated unescaped** into PostgREST `ilike` filters (`or=(…ilike…)` at messages.ts:99/145) — injection/escaping risk to fix.
- **Drafts PATCH/DELETE always report success** without checking `res.ok`.
- **Messages DELETE is a hard permanent delete** (cascades attachments); trashing is `PATCH is_trash:true`.
- **List responses strip `body_text`** and add a 120-char `preview`; full body only via single-message GET (also attaches `attachments`).
- **Inbox default hides catch-alls** (`is_catch_all=false`) unless `show_catchall=true`; `unread-counts.ts` buckets catch-alls separately so counts/views stay consistent.
- **Spam is stateful:** toggling `is_spam` moves the folder AND writes a `user_override=true` sender-reputation row so future mail from that sender skips the LLM and honors the user's verdict forever.
- **Spam never pushes.** Deliverability events (`delivered`/`bounced`/`complained`) are currently dropped (no `delivery_status` column) — TODO at inbound.ts:284 to add it.
- **Mail to unknown domains is silently accepted-and-discarded** (returns 200 so Resend won't retry).
- **`mc_user_id` in `domains.ts` select** (domains.ts:144) references the dead Migadu column + `mc_users` table — must be removed or the query errors against a standalone schema.
- **Migadu retirement (2026-05-16):** deleted the Migadu account, per-domain mailbox provisioning, `inbox.<domain>` mirror subdomains (DNS + Resend + `email_domains`), IMAP polling/backfill, encrypted-credential storage. Deleted files: `_imap.ts`, `sync.ts`, `mailboxes.ts`, `mobileconfig.ts`, `MIGADU-SETUP.md`, `/settings/mailboxes` UI. Deleted env vars: `MIGADU_*`, `MAILBOX_ENC_KEY`. **No mailboxes, no IMAP, no Apple Mail integration.** Do not revive.
- **Vestigial cron** (`email-sync-cron.yml`) — see §10.
- **CF Pages multi-null-PATCH env wipe** — see §10.

---

## 12. What to carry over vs. leave behind when forking

### Carry over (files that came over)
Backend (`functions/api/email/`) — all 15 files: `_shared.ts`, `_spam.ts`, `_web-push.ts`, `addresses.ts`, `contacts.ts`, `domains-settings.ts`, `domains-verify.ts`, `domains.ts`, `drafts.ts`, `inbound.ts`, `messages.ts`, `push-test.ts`, `push.ts`, `send.ts`, `unread-counts.ts`. Every request-handling file exports a single `onRequest` const (no `onRequestGet/Post/…` method splits); `_shared.ts`, `_spam.ts`, `_web-push.ts` are shared helper modules (underscore-prefixed, not routes).
Frontend: the 11 email components + `page.tsx`, `src/lib/auth.tsx` (for `apiFetch`+`X-MC-Auth`), `src/lib/push-notifications.ts`, `public/sw.js`.
DB: create in order — `email_domains` (with `catchall_destination_address_id` folded in via ALTER after `email_addresses`), `email_addresses` (base columns only), `email_messages` (spam columns folded in; consider `delivery_status TEXT`), `email_attachments`, `email_sender_reputation` (7 columns; no `created_at`), plus the two **unmigrated** tables `email_drafts` and `email_contacts` (author real migrations). Recreate all indexes. Create private Storage bucket `email-attachments`. Create `mc_sessions` (or your auth store) and `mc_push_subscriptions` (UNIQUE `endpoint`).

### Replace (shared MC chrome → minimal email-only shell)
- `src/components/layout/sidebar.tsx`, `top-nav.tsx` — rebuild as a plain email shell; define the required `--mc-*` CSS vars and `mc-content-offset`/`mc-bg-glow`/`--mc-sidebar-w` globally (cyan accent `#06B6D4`, dark theme).
- Auth: replace `mc_sessions` + the `[redacted]`/`[redacted]` fallback with real auth **before public exposure**, keeping the `X-MC-Auth` header and `checkAuth → Response|null` contract. Optionally stub `apiFetch` to plain `fetch`/static token.
- Drop `@/lib/supabase` unless porting `/inbox` (email app doesn't use it; MessageReader builds the attachment URL as a plain string).
- Re-point the Resend webhook from `mission-control-806.pages.dev/api/email/inbound` to the fork's hostname; keep event `email.received` and handle `email.sent`.
- Change hardcoded strings: client `VAPID_PUBLIC_KEY` in `push-notifications.ts` (must match a **newly generated** server keypair), `vapidSubject` default `mailto:admin@cleanenergyexperts.pro` in `_web-push.ts` (line 328), OpenRouter `HTTP-Referer`/`X-Title` in `_spam.ts`, SW icons `/mc-icon-192.png`, module-registry entry, CORS/self-URL references.
- Rename the CF Pages project from `mission-control`; drop the `branson-snap` mirror step.

### Drop (dead code / do not port)
- `functions/api/inbox.js` (issue tracker, not email) and `src/app/inbox/page.tsx` (activity feed).
- `.github/workflows/email-sync-cron.yml` + the `/api/email/sync` route (deleted, 405) + `MC_CRON_TOKEN`.
- All Migadu/IMAP env vars (`MIGADU_*`, `MAILBOX_ENC_KEY`) and legacy `email_addresses` columns (`is_mailbox`, `migadu_provisioned_at`, `mc_user_id`, `imap_*`) + their indexes. **Remove `mc_user_id` from the `select` in `domains.ts` (~line 144)** or the query errors.
- `MC_API_SECRET` (not read by email code) — only the session-token auth is live.

### Fork bring-up checklist
1. Build: Next.js 16 `output:"export"` → `out/`, Node 20, keep the `npm install --no-save lightningcss-linux-x64-gnu @tailwindcss/oxide-linux-x64-gnu` step (versions matched to Tailwind v4).
2. Host: a CF Pages project with `functions/api/email/**` intact; `wrangler pages deploy out --project-name=<new> --commit-dirty=true`.
3. Set CF Pages runtime env: `RESEND_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CLOUDFLARE_API_TOKEN`, optionally `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`OPENROUTER_KEY` (PATCH one secret at a time).
4. Set GitHub build secrets: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_MC_API_SECRET`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
5. Generate a fresh VAPID keypair; sync client key.
6. DB: reuse Supabase `YOUR_PROJECT_REF` (us-west-2) or a new project; create the `email_*` tables + auth store + `mc_push_subscriptions` + private `email-attachments` bucket. No RLS needed to match current behavior.
7. Re-point the Resend inbound webhook; verify domains via `POST /api/email/domains`.
