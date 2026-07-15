# Mission Control — Email Module Spec

## Overview
Add a full email system to Mission Control. Users can add a domain, and everything auto-configures: Resend domain setup, DNS records pushed to Cloudflare, inbound email via webhooks, outbound sending, and a clean inbox UI.

## Architecture

### Stack
- **Frontend:** Next.js (static export) — new `/email` page + components
- **API Layer:** Cloudflare Pages Functions (`/functions/api/email/...`)
- **Email Provider:** Resend API (sending + receiving)
- **DNS:** Cloudflare DNS API (auto-configure SPF, DKIM, MX records)
- **Database:** Supabase (PostgreSQL)
- **File Storage:** Supabase Storage (for attachments)

### Important Constraints
- MC uses `output: "export"` — NO Next.js API routes. All server-side logic goes in `/functions/` (Cloudflare Pages Functions)
- **NEVER put API keys in client-side code** — all keys go in CF Pages env vars
- Public GitHub repo — nothing sensitive in source
- Match existing MC design system: dark theme (#0D0F13 bg), cyan accents (#06B6D4), Inter + Montserrat fonts

## Database Schema

### `email_domains`
```sql
CREATE TABLE email_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL UNIQUE,
  resend_domain_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  -- statuses: pending, dns_configured, verifying, verified, active, failed
  dns_records JSONB,
  -- Array of records from Resend: [{type, name, value, priority?, ttl?}]
  cloudflare_zone_id TEXT,
  capabilities JSONB DEFAULT '{"sending": true, "receiving": true}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `email_addresses`
```sql
CREATE TABLE email_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES email_domains(id) ON DELETE CASCADE,
  address TEXT NOT NULL, -- local part only (e.g. "john", "brandon", "support")
  display_name TEXT, -- friendly name (e.g. "John Romano")
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_email_addresses_unique ON email_addresses(domain_id, address);
```

### `email_domains` additional columns
```sql
-- Add to email_domains:
catch_all_enabled BOOLEAN NOT NULL DEFAULT false,
catch_all_subject_prefix TEXT NOT NULL DEFAULT '[Catch-All]',
```

### `email_messages`
```sql
CREATE TABLE email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID REFERENCES email_domains(id),
  resend_email_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses JSONB DEFAULT '[]'::jsonb,
  bcc_addresses JSONB DEFAULT '[]'::jsonb,
  reply_to TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  headers JSONB,
  -- Threading
  in_reply_to TEXT,
  thread_id UUID,
  -- Status flags
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_starred BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  is_trash BOOLEAN NOT NULL DEFAULT false,
  is_draft BOOLEAN NOT NULL DEFAULT false,
  -- Folder/label
  folder TEXT NOT NULL DEFAULT 'inbox',
  -- Timestamps
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_messages_domain ON email_messages(domain_id);
CREATE INDEX idx_email_messages_folder ON email_messages(folder, is_trash, is_archived);
CREATE INDEX idx_email_messages_thread ON email_messages(thread_id);
CREATE INDEX idx_email_messages_received ON email_messages(received_at DESC);
```

### `email_attachments`
```sql
CREATE TABLE email_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  storage_path TEXT,
  -- Path in Supabase Storage bucket "email-attachments"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_attachments_message ON email_attachments(message_id);
```

## Cloudflare Pages Functions (API Routes)

All functions go in `/functions/api/email/`. They receive env vars via `context.env`:
- `RESEND_API_KEY` — Resend API key
- `CLOUDFLARE_API_TOKEN` — CF API token for DNS management
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key (for server-side writes)

### POST `/api/email/domains` — Add Domain
1. Call `POST https://api.resend.com/domains` with `{ name: domain, capabilities: { sending: "enabled", receiving: "enabled" } }`
2. Get back `id`, `records[]` (DNS records needed)
3. Look up Cloudflare zone for the domain (GET /zones?name=domain)
4. Push each DNS record to Cloudflare DNS API (POST /zones/{zone_id}/dns_records)
5. Call `POST https://api.resend.com/domains/{id}/verify` to trigger verification
6. Store domain in Supabase `email_domains` table
7. Return domain info + status

### GET `/api/email/domains` — List Domains
- Query Supabase `email_domains`
- For each, optionally re-check Resend status

### POST `/api/email/domains/verify` — Re-verify Domain
- Call Resend verify endpoint
- Update status in Supabase

### POST `/api/email/domains/status` — Check Domain Status
- Call Resend GET domain endpoint
- Update local status

### POST `/api/email/inbound` — Resend Webhook (Inbound Email)
This is the webhook endpoint Resend POSTs to when an email arrives.

Resend inbound webhook payload:
```json
{
  "type": "email.received",
  "data": {
    "from": "sender@example.com",
    "to": ["recipient@yourdomain.com"],
    "cc": [],
    "bcc": [],
    "subject": "Hello",
    "text": "Plain text body",
    "html": "<p>HTML body</p>",
    "headers": [...],
    "attachments": [
      {
        "filename": "doc.pdf",
        "content_type": "application/pdf",
        "content": "base64-encoded-content"
      }
    ]
  }
}
```

Handler:
1. Parse webhook payload
2. Match domain from `to` address
3. Insert into `email_messages` (direction='inbound')
4. For each attachment: upload to Supabase Storage, insert into `email_attachments`
5. Return 200 OK

### POST `/api/email/send` — Send Email
1. Receive: `{ from, to, cc, bcc, subject, html, text, reply_to, attachments }`
2. Call Resend send API
3. Store in `email_messages` (direction='outbound')
4. Return success + message ID

### GET `/api/email/messages` — List Messages
- Query params: `folder`, `domain_id`, `is_read`, `is_starred`, `limit`, `offset`, `search`
- Query Supabase with filters
- Include attachment count

### GET `/api/email/messages/[id]` — Get Single Message
- Fetch message + attachments from Supabase

### PATCH `/api/email/messages/[id]` — Update Message
- Toggle read, starred, archived, trash, folder

### DELETE `/api/email/messages/[id]` — Delete Message
- Permanent delete (or move to trash)

## Frontend Components

### Sidebar Update (`sidebar.tsx`)
Add "Email" nav item with `Mail` icon from lucide-react, href="/email", enabled: true.
Position it after "Bill Analyzer" in the nav.

### Page: `/email` (`src/app/email/page.tsx`)
Three-panel layout (responsive):
1. **Left panel** — Folder list (Inbox, Sent, Drafts, Starred, Trash) + domain selector
2. **Center panel** — Message list (sender, subject, preview, date, read/unread indicator, star toggle)
3. **Right panel** — Email reader (full message view with HTML rendering, attachments list, reply/forward buttons)

On mobile: single panel with back navigation.

### Components needed:
- `src/components/email/email-layout.tsx` — Three-panel container
- `src/components/email/folder-list.tsx` — Inbox/Sent/Drafts/Starred/Trash + unread counts
- `src/components/email/message-list.tsx` — Scrollable message list with search
- `src/components/email/message-reader.tsx` — Full email view with HTML iframe/sandbox, attachments
- `src/components/email/compose-modal.tsx` — Modal for composing new email (from, to, cc, bcc, subject, rich text body, attach files)
- `src/components/email/domain-setup.tsx` — Modal/page for adding a domain (input domain → shows progress → DNS auto-config → verification status)
- `src/components/email/attachment-list.tsx` — Download links for attachments

### Design System
- Background: #0D0F13 (main), #111318 (panels), #1A1D24 (cards/items)
- Text: white (#FFFFFF) primary, #9CA3AF secondary, #6B7280 tertiary
- Accent: #06B6D4 (cyan) for active states, unread indicators
- Borders: rgba(255,255,255,0.06)
- Read messages: slightly dimmer text
- Unread messages: white text + cyan dot indicator
- Selected message: subtle highlight bg
- Starred: yellow star icon (#EAB308)
- Compose button: cyan gradient, prominent position

### Email HTML Rendering
Use a sandboxed iframe for HTML emails to prevent style bleeding:
```tsx
<iframe
  srcDoc={sanitizedHtml}
  sandbox="allow-same-origin"
  style={{ width: '100%', border: 'none', background: 'white' }}
/>
```

## Supabase Storage
Create bucket: `email-attachments` (public: false)
Path pattern: `{domain}/{message_id}/{filename}`

## Webhook Setup
After domain verification, the webhook URL needs to be configured in Resend:
- URL: `https://mission-control-806.pages.dev/api/email/inbound`
- Event: `email.received`

Note: Webhook setup must be done via Resend dashboard or API. The domain setup flow should include instructions or auto-configure via API if available.

## Environment Variables (Cloudflare Pages)
Set these in Cloudflare Pages dashboard (encrypted):
- `RESEND_API_KEY`
- `CLOUDFLARE_API_TOKEN` (already exists for bill analyzer)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

## File Structure
```
mc-repo/
├── functions/
│   └── api/
│       └── email/
│           ├── domains.ts          (POST/GET)
│           ├── domains-verify.ts   (POST)
│           ├── domains-status.ts   (POST)
│           ├── inbound.ts          (POST - webhook)
│           ├── send.ts             (POST)
│           ├── messages.ts         (GET)
│           ├── message.ts          (GET/PATCH/DELETE by id query param)
│           └── _shared.ts          (Supabase client helper, CORS headers)
├── src/
│   ├── app/
│   │   └── email/
│   │       └── page.tsx
│   └── components/
│       └── email/
│           ├── email-layout.tsx
│           ├── folder-list.tsx
│           ├── message-list.tsx
│           ├── message-reader.tsx
│           ├── compose-modal.tsx
│           ├── domain-setup.tsx
│           └── attachment-list.tsx
```
