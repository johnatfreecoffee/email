import { Env, errorResponse, supabaseQuery } from "./_shared";
import { deliverInboundMessage } from "./_inbound-deliver";
import { getHeader, resolveFrom } from "./_inbound-parse";
import { resolveThreadId } from "./_thread";
import { AGENT_FOLDER, isAgentLocal } from "./_agent";

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
      size?: number;
      download_url?: string;
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
    size?: number;
    download_url?: string;
  }>;
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

  const sentFolder = isAgentLocal(fromLocal) ? AGENT_FOLDER : "sent";

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
      folder: sentFolder,
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

  return deliverInboundMessage(env, request.url, {
    envelopeTo,
    ccAddresses,
    bccAddresses,
    subject,
    fromRaw,
    bodyHtml,
    bodyText,
    headers,
    createdAt,
    resendEmailId: emailId,
    resendAttachments: {
      emailId,
      webhookAttachments: webhookData.attachments,
      fullEmailAttachments: fullEmail?.attachments,
      resendGet: (path) => resendGet(env, path),
    },
  });
};
