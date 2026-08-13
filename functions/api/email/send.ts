import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, resendAPI, checkAuth } from "./_shared";
import { resolveThreadId } from "./_thread";
import { AGENT_FOLDER, isAgentLocal, localPartOf } from "./_agent";

interface CFContext {
  request: Request;
  env: Env;
  waitUntil?: (promise: Promise<unknown>) => void;
}

// POST: Send an email via Resend
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  if (request.method !== "POST") return errorResponse("Method not allowed", 405, origin);

  const body = await request.json() as {
    from: string;       // "John Romano <john@cleanenergyexperts.pro>"
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    html?: string;
    text?: string;
    reply_to?: string;
    in_reply_to?: string;
    domain_id?: string;
    address_id?: string;
    attachments?: Array<{
      filename: string;
      content: string; // base64
      content_type: string;
    }>;
  };

  if (!body.from || !body.to || !body.subject) {
    return errorResponse("from, to, and subject are required", 400, origin);
  }

  // Send via Resend
  const sendPayload: any = {
    from: body.from,
    to: body.to,
    subject: body.subject,
  };
  if (body.html) sendPayload.html = body.html;
  if (body.text) sendPayload.text = body.text;
  if (body.cc) sendPayload.cc = body.cc;
  if (body.bcc) sendPayload.bcc = body.bcc;
  if (body.reply_to) sendPayload.reply_to = body.reply_to;
  if (body.attachments && body.attachments.length > 0) {
    sendPayload.attachments = body.attachments.map((att) => ({
      filename: att.filename,
      content: att.content, // Resend accepts base64 content directly
      content_type: att.content_type,
    }));
  }

  const resendRes = await resendAPI(env, "/emails", {
    method: "POST",
    body: sendPayload,
  });

  if (!resendRes.ok) {
    return errorResponse(`Send failed: ${JSON.stringify(resendRes.data)}`, 400, origin);
  }

  const sent = resendRes.data as { id: string };

  // Parse from address
  let fromAddress = body.from;
  let fromName: string | null = null;
  const nameMatch = body.from.match(/^(.+?)\s*<(.+?)>$/);
  if (nameMatch) {
    fromName = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    fromAddress = nameMatch[2];
  }

  // Auto-resolve domain_id from from address if not provided or not a UUID
  let resolvedDomainId = body.domain_id || null;
  let resolvedAddressId = body.address_id || null;
  const fromDomainName = fromAddress.split("@")[1]?.toLowerCase();
  
  if (fromDomainName && (!resolvedDomainId || !resolvedDomainId.match(/^[0-9a-f]{8}-/))) {
    // Look up domain by name
    const domainLookup = await supabaseQuery(env, `/email_domains?domain=eq.${fromDomainName}&select=id`, {
      method: "GET",
    });
    if (domainLookup.ok && Array.isArray(domainLookup.data) && domainLookup.data.length > 0) {
      resolvedDomainId = domainLookup.data[0].id;
    }
  }

  // Conversation thread
  let threadId: string | null = null;
  try {
    threadId = await resolveThreadId(env, {
      domainId: resolvedDomainId,
      subject: body.subject,
      inReplyTo: body.in_reply_to || null,
      headers: null,
    });
  } catch (e) {
    console.error("thread resolve failed (non-fatal):", e);
    threadId = crypto.randomUUID();
  }

  // Store outbound message in DB
  const msgRes = await supabaseQuery(env, "/email_messages", {
    method: "POST",
    body: {
      domain_id: resolvedDomainId,
      address_id: resolvedAddressId,
      resend_email_id: sent.id,
      direction: "outbound",
      from_address: fromAddress,
      from_name: fromName,
      to_addresses: body.to,
      cc_addresses: body.cc || [],
      bcc_addresses: body.bcc || [],
      subject: body.subject,
      body_text: body.text || null,
      body_html: body.html || null,
      in_reply_to: body.in_reply_to || null,
      thread_id: threadId,
      is_read: true,
      folder: isAgentLocal(localPartOf(fromAddress)) ? AGENT_FOLDER : "sent",
      received_at: new Date().toISOString(),
    },
  });

  const message = msgRes.ok ? (Array.isArray(msgRes.data) ? msgRes.data[0] : msgRes.data) : null;

  // Store outbound attachments
  if (message && body.attachments && body.attachments.length > 0) {
    // Parse domain from from address
    const fromDomain = fromAddress.split("@")[1] || "unknown";

    for (const att of body.attachments) {
      const storagePath = `${fromDomain}/${message.id}/${att.filename}`;

      // Upload to Supabase Storage
      try {
        const binaryData = Uint8Array.from(atob(att.content), (c) => c.charCodeAt(0));
        await fetch(`${env.SUPABASE_URL}/storage/v1/object/email-attachments/${storagePath}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            "Content-Type": att.content_type || "application/octet-stream",
          },
          body: binaryData,
        });
      } catch (e) {
        console.error("Failed to upload outbound attachment:", e);
      }

      // Record in DB
      await supabaseQuery(env, "/email_attachments", {
        method: "POST",
        body: {
          message_id: message.id,
          filename: att.filename,
          content_type: att.content_type,
          size_bytes: Math.ceil((att.content.length * 3) / 4),
          storage_path: storagePath,
        },
      });
    }
  }

  // Auto-learn contacts from recipients
  try {
    const contacts = body.to.map((email) => ({
      email: email.trim(),
      direction: "sent" as const,
    }));
    if (body.cc) {
      contacts.push(...body.cc.map((email) => ({ email: email.trim(), direction: "sent" as const })));
    }
    if (body.bcc) {
      contacts.push(...body.bcc.map((email) => ({ email: email.trim(), direction: "sent" as const })));
    }
    // Fire and forget — don't block the response
    fetch(`${env.SUPABASE_URL}/rest/v1/rpc/noop`, { method: "HEAD" }).catch(() => {}); // warm
    await fetch(new URL("/api/email/contacts", request.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contacts }),
    }).catch(() => {});
  } catch (e) {
    console.error("Contact learning failed (non-fatal):", e);
  }

  return jsonResponse({
    sent: true,
    resend_id: sent.id,
    message,
  }, 200, origin);
};
