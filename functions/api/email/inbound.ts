import { Env, jsonResponse, errorResponse, supabaseQuery } from "./_shared";
import { broadcastPush } from "./_web-push";
import { classifySpam, SPAM_FOLDER } from "./_spam";
import { readSetting, SETTINGS_DEFAULTS } from "./_settings";
import { fetchActiveRules, applyRuleActions, type DeliveryState } from "./_rules";
import { resolveThreadId } from "./_thread";

interface CFContext {
  request: Request;
  env: Env;
}

// Resend webhook payload for email.received
interface WebhookPayload {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    created_at: string;
    message_id?: string;
    attachments?: Array<{
      id: string;
      filename: string;
      content_type: string;
      content_disposition?: string;
      content_id?: string;
    }>;
  };
}

// Full email from GET /emails/receiving/{id}
interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  created_at: string;
  message_id?: string;
  reply_to?: string[];
  raw?: {
    download_url: string;
    expires_at: string;
  };
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    content_disposition?: string;
    content_id?: string;
  }>;
}

// Attachment from GET /emails/receiving/{id}/attachments
interface AttachmentWithUrl {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  download_url: string;
  expires_at: string;
}

async function resendGet(env: Env, path: string): Promise<any> {
  const res = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  if (!res.ok) {
    console.error(`Resend GET ${path} failed: ${res.status} ${await res.text()}`);
    return null;
  }
  return res.json();
}

// Pull every email-shaped token out of an RFC 5322 address-list header value.
// Tolerates "Name <foo@bar>", quoted display names, and comma-separated lists.
function parseAddressList(headerValue: string | null | undefined): string[] {
  if (!headerValue) return [];
  const matches = headerValue.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);
  return matches ? matches.map((s) => s.toLowerCase()) : [];
}

function getHeader(
  headers: Record<string, string> | null | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return null;
}

// Decode RFC 2047 "encoded-word" runs (=?UTF-8?B?...?= / =?UTF-8?Q?...?=) used
// for non-ASCII display names. Defensive: any failure returns the input as-is.
function decodeMimeWords(input: string): string {
  if (!input || input.indexOf("=?") === -1) return input;
  try {
    return input.replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_m, charset: string, enc: string, text: string) => {
        let bytes: Uint8Array;
        if (enc.toUpperCase() === "B") {
          const bin = atob(text);
          bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        } else {
          const q = text.replace(/_/g, " ");
          const out: number[] = [];
          for (let i = 0; i < q.length; i++) {
            if (q[i] === "=" && i + 2 < q.length) {
              out.push(parseInt(q.substr(i + 1, 2), 16));
              i += 2;
            } else {
              out.push(q.charCodeAt(i));
            }
          }
          bytes = Uint8Array.from(out);
        }
        try {
          return new TextDecoder(charset).decode(bytes);
        } catch {
          return new TextDecoder("utf-8").decode(bytes);
        }
      }
    );
  } catch {
    return input;
  }
}

// Split a "Display Name <addr@host>" value into its name + address parts.
function splitNameAddr(value: string): { name: string | null; address: string } {
  const v = (value || "").trim();
  const m = v.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].trim().replace(/^["']|["']$/g, "").trim();
    return { name: name || null, address: m[2].trim() };
  }
  return { name: null, address: v };
}

// Resolve the sender's display name + address. Resend's parsed `from` field is
// frequently just the bare address, so when it carries no display name we fall
// back to the raw `From:` header, which preserves it.
function resolveFrom(
  parsedFrom: string | null | undefined,
  rawFromHeader: string | null | undefined
): { name: string | null; address: string } {
  const primary = splitNameAddr(parsedFrom || "");
  let name = primary.name;
  let address = primary.address;
  if (!name && rawFromHeader) {
    const fallback = splitNameAddr(rawFromHeader);
    if (fallback.name) name = fallback.name;
    if (!address && fallback.address) address = fallback.address;
  }
  if (name) name = decodeMimeWords(name).trim() || null;
  return { name, address };
}

// Handle email.sent webhook: outbound mail Resend just delivered. Could be
// from MC's compose UI (already pre-logged in send.ts) or from a client
// (Apple Mail) using Resend SMTP. Dedupes by resend_email_id so the
// pre-logged path doesn't double-write.
async function handleEmailSent(
  env: Env,
  payload: { type: string; data: { email_id: string; from?: string; to?: string[]; subject?: string; created_at?: string } }
): Promise<Response> {
  const emailId = payload.data?.email_id;
  if (!emailId) return new Response("OK", { status: 200 });

  // Already logged by send.ts? Skip.
  const existing = await supabaseQuery(
    env,
    `/email_messages?resend_email_id=eq.${emailId}&select=id&limit=1`
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    return new Response("OK", { status: 200 });
  }

  // Fetch full email from Resend so we have body + headers
  const fullEmail = await resendGet(env, `/emails/${emailId}`) as
    | {
        from?: string;
        to?: string[];
        cc?: string[];
        bcc?: string[];
        subject?: string;
        html?: string | null;
        text?: string | null;
        headers?: Record<string, string>;
        created_at?: string;
        reply_to?: string[];
      }
    | null;

  const fromRaw = fullEmail?.from || payload.data.from || "";
  const toAddresses = fullEmail?.to || payload.data.to || [];
  const ccAddresses = fullEmail?.cc || [];
  const bccAddresses = fullEmail?.bcc || [];
  const subject = fullEmail?.subject || payload.data.subject || "(no subject)";
  const bodyHtml = fullEmail?.html || null;
  const bodyText = fullEmail?.text || null;
  const headers = fullEmail?.headers || null;
  const createdAt = fullEmail?.created_at || payload.data.created_at || new Date().toISOString();

  // Parse from. Prefer the raw `From:` header for the display name.
  const fromParsed = resolveFrom(fromRaw, getHeader(headers, "from"));
  const fromAddress = fromParsed.address.toLowerCase().trim();
  const fromName = fromParsed.name;

  // Match domain + address by from
  const fromDomain = fromAddress.split("@")[1];
  const fromLocal = fromAddress.split("@")[0];
  if (!fromDomain || !fromLocal) {
    console.error(`email.sent: unparseable from address ${fromRaw}`);
    return new Response("OK", { status: 200 });
  }

  const domainRes = await supabaseQuery(env, `/email_domains?domain=eq.${fromDomain}&limit=1`);
  if (!domainRes.ok || !Array.isArray(domainRes.data) || domainRes.data.length === 0) {
    // Not one of our domains — ignore (this might be a Resend-key for
    // another tenant on the same Resend account).
    return new Response("OK", { status: 200 });
  }
  const domain = domainRes.data[0];

  let addressId: string | null = null;
  const addrRes = await supabaseQuery(
    env,
    `/email_addresses?domain_id=eq.${domain.id}&address=eq.${fromLocal}&limit=1`
  );
  if (addrRes.ok && Array.isArray(addrRes.data) && addrRes.data.length > 0) {
    addressId = addrRes.data[0].id;
  }

  let threadId: string | null = null;
  try {
    threadId = await resolveThreadId(env, {
      domainId: domain.id,
      subject,
      inReplyTo: getHeader(headers, "in-reply-to"),
      headers,
    });
  } catch {
    threadId = crypto.randomUUID();
  }

  await supabaseQuery(env, "/email_messages", {
    method: "POST",
    body: {
      domain_id: domain.id,
      address_id: addressId,
      resend_email_id: emailId,
      direction: "outbound",
      from_address: fromAddress,
      from_name: fromName,
      to_addresses: toAddresses,
      cc_addresses: ccAddresses,
      bcc_addresses: bccAddresses,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      headers,
      in_reply_to: getHeader(headers, "in-reply-to"),
      thread_id: threadId,
      is_read: true,
      folder: "sent",
      received_at: createdAt,
    },
  });

  return new Response("OK", { status: 200 });
}

// POST: Resend inbound webhook
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;

  if (request.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  let payload: WebhookPayload;
  try {
    payload = await request.json() as WebhookPayload;
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  // Handle delivery status events (TODO: add delivery_status column to email_messages table first)
  if (payload.type === "email.delivered" || payload.type === "email.bounced" || payload.type === "email.complained") {
    // For now, just acknowledge — column migration needed
    console.log(`Email ${payload.type}: ${(payload.data as any).email_id}`);
    return new Response("OK", { status: 200 });
  }

  // email.sent: outbound mail submitted via Resend (either MC's compose UI or
  // a client like Apple Mail using Resend's SMTP relay). Captures into
  // Supabase as direction='outbound' so MC's Sent folder stays canonical.
  if (payload.type === "email.sent") {
    return await handleEmailSent(env, payload as any);
  }

  // Only process email.received events for inbound
  if (payload.type !== "email.received") {
    return new Response("OK", { status: 200 });
  }

  const webhookData = payload.data;
  const emailId = webhookData.email_id;

  if (!emailId) {
    console.error("No email_id in webhook payload");
    return errorResponse("Missing email_id", 400);
  }

  // 1. Fetch full email content from Resend API
  const fullEmail = await resendGet(env, `/emails/receiving/${emailId}`) as ReceivedEmail | null;
  if (!fullEmail) {
    console.error(`Failed to fetch full email ${emailId}`);
    // Still store what we have from the webhook
  }

  const envelopeTo = fullEmail?.to || webhookData.to || [];
  const ccAddresses = fullEmail?.cc || webhookData.cc || [];
  const bccAddresses = fullEmail?.bcc || webhookData.bcc || [];
  const subject = fullEmail?.subject || webhookData.subject || "(no subject)";
  const fromRaw = fullEmail?.from || webhookData.from || "";
  const bodyHtml = fullEmail?.html || null;
  const bodyText = fullEmail?.text || null;
  const headers = fullEmail?.headers || null;
  const createdAt = fullEmail?.created_at || webhookData.created_at || new Date().toISOString();

  const toAddresses = envelopeTo;

  // Find which domain this is for
  let matchedDomain: any = null;
  let matchedAddress: any = null;
  let isCatchAll = false;

  for (const toAddr of toAddresses) {
    const [localPart, domainPart] = toAddr.toLowerCase().split("@");
    if (!domainPart) continue;

    const domainRes = await supabaseQuery(env, `/email_domains?domain=eq.${domainPart}&limit=1`);
    if (!domainRes.ok || !Array.isArray(domainRes.data) || domainRes.data.length === 0) continue;
    matchedDomain = domainRes.data[0];

    const addrRes = await supabaseQuery(
      env,
      `/email_addresses?domain_id=eq.${matchedDomain.id}&address=eq.${localPart}&is_active=eq.true&limit=1`
    );

    if (addrRes.ok && Array.isArray(addrRes.data) && addrRes.data.length > 0) {
      matchedAddress = addrRes.data[0];
      isCatchAll = false;
    } else if (matchedDomain.catch_all_enabled) {
      isCatchAll = true;
    } else {
      continue;
    }
    break;
  }

  if (!matchedDomain) {
    return new Response("OK", { status: 200 });
  }

  // Prepend catch-all prefix
  let finalSubject = subject;
  if (isCatchAll && matchedDomain.catch_all_subject_prefix) {
    finalSubject = `${matchedDomain.catch_all_subject_prefix} ${subject}`;
  }

  // Parse from name/address. Resend's parsed `from` is often the bare address,
  // so fall back to the raw `From:` header (which retains the display name).
  const fromParsed = resolveFrom(fromRaw, getHeader(headers, "from"));
  const fromAddress = fromParsed.address;
  const fromName = fromParsed.name;

  // When a catch-all message arrives on a domain that has a configured
  // destination address, attribute the message to that address so it shows
  // up in the chosen recipient's inbox view.
  const catchAllAddressId =
    isCatchAll && matchedDomain.catchall_destination_address_id
      ? matchedDomain.catchall_destination_address_id
      : null;

  // User-tunable junk settings + delivery rules — both tolerate missing
  // tables (pre-migration) and never fail the webhook.
  const [junkSettings, activeRules] = await Promise.all([
    readSetting(env, "junk", SETTINGS_DEFAULTS.junk),
    fetchActiveRules(env),
  ]);

  // Spam classification — heuristics + free LLM. Falls back gracefully if
  // OpenRouter is unavailable; never fails the webhook.
  let spamVerdict;
  try {
    spamVerdict = await classifySpam(
      {
        subject: finalSubject,
        body_text: bodyText,
        from_address: fromAddress.toLowerCase().trim(),
        headers,
        is_catch_all: isCatchAll,
      },
      env,
      junkSettings
    );
  } catch (e) {
    console.error("Spam classifier threw (non-fatal):", e);
    spamVerdict = { is_spam: false, score: 0, reason: "classifier_error" };
  }

  // Delivery rules run AFTER classification and may override it (an explicit
  // inbox rule rescues a spam verdict). All matching rules apply in priority
  // order; later rules win on conflicts.
  const delivery: DeliveryState = {
    folder: spamVerdict.is_spam ? SPAM_FOLDER : "inbox",
    is_read: false,
    is_starred: false,
    is_spam: spamVerdict.is_spam,
    is_trash: false,
    is_archived: false,
  };
  try {
    const applicable = activeRules.filter((r) => !r.domain_id || r.domain_id === matchedDomain.id);
    if (applicable.length > 0) {
      const fired = applyRuleActions(
        applicable,
        {
          from: fromAddress.toLowerCase().trim(),
          to: toAddresses.map((a: string) => (a || "").toLowerCase()),
          subject: finalSubject || "",
        },
        delivery
      );
      if (fired.length > 0) console.log(`Rules fired: ${fired.join(", ")}`);
    }
  } catch (e) {
    console.error("Rules pass threw (non-fatal):", e);
  }

  // Conversation thread (Apple Mail–style grouping)
  let threadId: string | null = null;
  try {
    threadId = await resolveThreadId(env, {
      domainId: matchedDomain.id,
      subject: finalSubject,
      inReplyTo: getHeader(headers, "in-reply-to"),
      headers,
    });
  } catch (e) {
    console.error("thread resolve failed (non-fatal):", e);
    threadId = crypto.randomUUID();
  }

  // Insert message
  const msgRes = await supabaseQuery(env, "/email_messages", {
    method: "POST",
    body: {
      domain_id: matchedDomain.id,
      address_id: matchedAddress?.id || catchAllAddressId || null,
      direction: "inbound",
      resend_email_id: emailId,
      from_address: fromAddress,
      from_name: fromName,
      to_addresses: toAddresses,
      cc_addresses: ccAddresses,
      bcc_addresses: bccAddresses,
      subject: finalSubject,
      body_text: bodyText,
      body_html: bodyHtml,
      headers: headers,
      in_reply_to: getHeader(headers, "in-reply-to"),
      thread_id: threadId,
      is_catch_all: isCatchAll,
      folder: delivery.folder,
      is_read: delivery.is_read,
      is_starred: delivery.is_starred,
      is_trash: delivery.is_trash,
      is_archived: delivery.is_archived,
      is_spam: delivery.is_spam,
      spam_score: spamVerdict.score,
      spam_reason: spamVerdict.reason,
      spam_checked_at: new Date().toISOString(),
      received_at: createdAt,
    },
  });

  if (!msgRes.ok) {
    console.error("Failed to store email:", msgRes.data);
    return errorResponse("Failed to store email", 500);
  }

  const message = Array.isArray(msgRes.data) ? msgRes.data[0] : msgRes.data;

  // 2. Handle attachments — fetch from Resend Attachments API
  const webhookAttachments = webhookData.attachments || fullEmail?.attachments || [];
  if (webhookAttachments.length > 0) {
    // Call the attachments API to get download URLs
    const attachmentsData = await resendGet(env, `/emails/receiving/${emailId}/attachments`) as { data: AttachmentWithUrl[] } | null;

    if (attachmentsData?.data) {
      for (const att of attachmentsData.data) {
        const storagePath = `${matchedDomain.domain}/${message.id}/${att.filename}`;

        // Download the attachment from Resend's signed URL
        try {
          const downloadRes = await fetch(att.download_url);
          if (!downloadRes.ok) {
            console.error(`Failed to download attachment ${att.filename}: ${downloadRes.status}`);
            continue;
          }

          const fileBuffer = await downloadRes.arrayBuffer();

          // Upload to Supabase Storage
          const uploadUrl = `${env.SUPABASE_URL}/storage/v1/object/email-attachments/${storagePath}`;
          const uploadRes = await fetch(uploadUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
              "Content-Type": att.content_type || "application/octet-stream",
            },
            body: fileBuffer,
          });

          if (!uploadRes.ok) {
            console.error(`Failed to upload attachment to storage: ${uploadRes.status}`);
          }
        } catch (e) {
          console.error("Attachment download/upload error:", e);
        }

        // Record in DB
        await supabaseQuery(env, "/email_attachments", {
          method: "POST",
          body: {
            message_id: message.id,
            filename: att.filename,
            content_type: att.content_type,
            size_bytes: att.size || 0,
            storage_path: storagePath,
          },
        });
      }
    } else {
      // Fallback: just store metadata from webhook if API call failed
      for (const att of webhookAttachments) {
        await supabaseQuery(env, "/email_attachments", {
          method: "POST",
          body: {
            message_id: message.id,
            filename: att.filename,
            content_type: att.content_type,
            size_bytes: 0,
            storage_path: `pending/${emailId}/${att.filename}`,
          },
        });
      }
    }
  }

  // 3. Auto-learn contacts
  try {
    await fetch(new URL("/api/email/contacts", request.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contacts: [
          { email: fromAddress, display_name: fromName, direction: "received" },
        ],
      }),
    });
  } catch (e) {
    console.error("Contact learning failed (non-fatal):", e);
  }

  // 4. Send push notifications (RFC 8291 encrypted + VAPID signed). Only
  // mail that lands in the inbox, unread and unfiled, pings the phone —
  // junk, and rule-filed/-read/-trashed deliveries stay silent (a rule that
  // only flags still notifies).
  let shouldNotify =
    delivery.folder === "inbox" &&
    !delivery.is_read &&
    !delivery.is_spam &&
    !delivery.is_trash &&
    !delivery.is_archived;
  // Optional: users can silence push for catch-all mail (still delivered and
  // counted, just no ping). Only query settings when it could matter.
  if (shouldNotify && isCatchAll) {
    const notif = await readSetting<{ pushCatchAll: boolean }>(
      env,
      "notifications",
      SETTINGS_DEFAULTS.notifications
    );
    if (notif.pushCatchAll === false) shouldNotify = false;
  }
  if (!shouldNotify) {
    return jsonResponse({ received: true, message_id: message.id, spam: delivery.is_spam }, 200);
  }
  try {
    const subsRes = await supabaseQuery(env, "/mc_push_subscriptions?is_active=eq.true");
    if (subsRes.ok && Array.isArray(subsRes.data) && subsRes.data.length > 0) {
      // Truncate body preview from email text
      const bodyPreview = bodyText
        ? bodyText.replace(/\s+/g, " ").trim().substring(0, 100)
        : "";

      const pushPayload = {
        title: `📧 ${fromName || fromAddress}`,
        body: bodyPreview
          ? `${finalSubject}\n${bodyPreview}${bodyPreview.length >= 100 ? "..." : ""}`
          : (finalSubject.length > 80 ? finalSubject.substring(0, 80) + "..." : finalSubject),
        type: "email",
        messageId: message.id,
        from: fromName || fromAddress,
        subject: finalSubject,
        domain: matchedDomain.domain,
      };

      const vapidPublicKey = env.VAPID_PUBLIC_KEY;
      const vapidPrivateKey = env.VAPID_PRIVATE_KEY;

      if (vapidPublicKey && vapidPrivateKey) {
        const results = await broadcastPush(
          subsRes.data,
          pushPayload,
          vapidPublicKey,
          vapidPrivateKey
        );

        // Prune permanently-dead subscriptions: expired (404/410), VAPID-key
        // mismatch (403 — old key, fails forever), malformed (400), corrupt
        // stored keys (DER parse failure). Transient failures stay active.
        for (const { id, result } of results) {
          const dead =
            result.status === 400 ||
            result.status === 403 ||
            result.status === 404 ||
            result.status === 410 ||
            (result.error || "").includes("Invalid DER");
          if (dead) {
            await supabaseQuery(env, `/mc_push_subscriptions?id=eq.${id}`, {
              method: "PATCH",
              body: { is_active: false, updated_at: new Date().toISOString() },
            });
            console.log(`Deactivated dead push subscription ${id} (${result.status ?? result.error})`);
          } else if (!result.success) {
            console.error(`Push to ${id} failed: ${result.status} ${result.error || result.statusText}`);
          }
        }
      } else {
        console.error("VAPID keys not configured — push notifications disabled");
      }
    }
  } catch (pushErr) {
    console.error("Push notification error:", pushErr);
  }

  return jsonResponse({ received: true, message_id: message.id }, 200);
};
