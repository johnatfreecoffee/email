import { Env, jsonResponse, errorResponse, supabaseQuery } from "./_shared";
import { broadcastPush } from "./_web-push";
import { classifySpam, SPAM_FOLDER, type SpamVerdict } from "./_spam";
import { readSetting, SETTINGS_DEFAULTS } from "./_settings";
import { fetchActiveRules, applyRuleActions, type DeliveryState } from "./_rules";
import { resolveThreadId } from "./_thread";
import {
  AGENT_FOLDER,
  agentDisplayName,
  isAgentLocal,
  isAgentRecipient,
  localPartOf,
  recipientList,
} from "./_agent";
import { maybeCloudChat } from "./_agent_cloud";
import { getHeader, resolveFrom } from "./_inbound-parse";

interface AttachmentWithUrl {
  id?: string;
  filename?: string;
  content_type?: string;
  content_disposition?: string;
  content_id?: string;
  size?: number;
  size_bytes?: number;
  download_url?: string;
}

export interface BinaryAttachment {
  filename: string;
  content_type: string;
  data: ArrayBuffer;
}

export interface DeliverInboundParams {
  envelopeTo: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string;
  fromRaw: string;
  bodyHtml: string | null;
  bodyText: string | null;
  headers: Record<string, string> | null;
  createdAt: string;
  resendEmailId?: string | null;
  ingestMessageId?: string | null;
  domainHint?: string | null;
  resendAttachments?: {
    emailId: string;
    webhookAttachments?: AttachmentWithUrl[];
    fullEmailAttachments?: AttachmentWithUrl[];
    resendGet: (path: string) => Promise<any>;
  };
  binaryAttachments?: BinaryAttachment[];
  spamVerdictOverride?: SpamVerdict | null;
  skipLlmSpam?: boolean;
}

function attachmentsFromResend(raw: unknown): AttachmentWithUrl[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as AttachmentWithUrl[];
  if (typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: AttachmentWithUrl[] }).data;
  }
  return [];
}

function attachmentFilename(att: AttachmentWithUrl, index: number): string {
  const raw =
    (att.filename || "").trim() ||
    (att.content_id ? `inline-${att.content_id}` : `attachment-${index + 1}`);
  return raw.replace(/[/\\]+/g, "_").replace(/^\.+/, "_") || `attachment-${index + 1}`;
}

async function storeBinaryAttachment(
  env: Env,
  domainName: string,
  messageId: string,
  filename: string,
  contentType: string,
  fileBuffer: ArrayBuffer,
  sizeHint?: number
) {
  const storagePath = `${domainName}/${messageId}/${filename}`;
  const uploadUrl = `${env.SUPABASE_URL}/storage/v1/object/email-attachments/${storagePath}`;
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": contentType,
    },
    body: fileBuffer,
  });
  if (!uploadRes.ok) {
    console.error(`Failed to upload attachment to storage: ${uploadRes.status}`);
    return;
  }
  await supabaseQuery(env, "/email_attachments", {
    method: "POST",
    body: {
      message_id: messageId,
      filename,
      content_type: contentType,
      size_bytes: sizeHint || fileBuffer.byteLength || 0,
      storage_path: storagePath,
    },
  });
}

export async function deliverInboundMessage(
  env: Env,
  requestUrl: string,
  params: DeliverInboundParams
): Promise<Response> {
  const {
    envelopeTo,
    ccAddresses,
    bccAddresses,
    subject,
    fromRaw,
    bodyHtml,
    bodyText,
    headers,
    createdAt,
    resendEmailId,
    ingestMessageId,
    domainHint,
    resendAttachments,
    binaryAttachments,
    spamVerdictOverride,
    skipLlmSpam,
  } = params;

  if (ingestMessageId) {
    const dupe = await supabaseQuery(
      env,
      `/email_messages?ingest_message_id=eq.${encodeURIComponent(ingestMessageId)}&select=id,domain_id&limit=1`
    );
    if (dupe.ok && Array.isArray(dupe.data) && dupe.data[0]) {
      return jsonResponse(
        { received: true, duplicate: true, message_id: dupe.data[0].id },
        200
      );
    }
  }

  if (resendEmailId) {
    const dupe = await supabaseQuery(
      env,
      `/email_messages?resend_email_id=eq.${encodeURIComponent(resendEmailId)}&select=id&limit=1`
    );
    if (dupe.ok && Array.isArray(dupe.data) && dupe.data.length > 0) {
      return jsonResponse({ received: true, duplicate: true, message_id: dupe.data[0].id }, 200);
    }
  }

  const toAddresses = envelopeTo;
  const extraAgent: string[] = [];
  const recipsLower = recipientList(toAddresses, ccAddresses, bccAddresses).map((a) => a.toLowerCase());
  const subj = subject || "";
  if (
    recipsLower.includes("noreply@noknok.pro") &&
    /noknok marketing agent/i.test(subj) &&
    (getHeader(headers, "in-reply-to") || getHeader(headers, "references"))
  ) {
    extraAgent.push("a.noknok@freecoffee.dev");
  }
  const allRecipients = recipientList(toAddresses, ccAddresses, bccAddresses, extraAgent);

  let matchedDomain: any = null;
  let matchedAddress: any = null;
  let isCatchAll = false;

  const domainCandidates = domainHint
    ? [domainHint.toLowerCase()]
    : allRecipients.map((a) => a.split("@")[1]?.toLowerCase()).filter(Boolean);

  for (const toAddr of allRecipients) {
    const [localPart, domainPart] = toAddr.toLowerCase().split("@");
    if (!domainPart) continue;
    if (domainHint && domainPart !== domainHint.toLowerCase()) continue;

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

  if (!matchedDomain && domainCandidates.length > 0) {
    const domainRes = await supabaseQuery(
      env,
      `/email_domains?domain=eq.${domainCandidates[0]}&limit=1`
    );
    if (domainRes.ok && Array.isArray(domainRes.data) && domainRes.data[0]) {
      matchedDomain = domainRes.data[0];
      isCatchAll = true;
    }
  }

  if (!matchedDomain) {
    return new Response("OK", { status: 200 });
  }

  const matchedLocal =
    (matchedAddress as { address?: string } | null | undefined)?.address ||
    localPartOf(allRecipients.find((a) => isAgentLocal(localPartOf(a))) || toAddresses[0] || "");
  const isAgent = isAgentRecipient(allRecipients, matchedLocal);

  if (isAgent) {
    isCatchAll = false;
    if (!matchedAddress) {
      const wantLocal = localPartOf(
        allRecipients.find((a) => isAgentLocal(localPartOf(a))) || toAddresses[0] || ""
      );
      if (wantLocal) {
        try {
          const existing = await supabaseQuery(
            env,
            `/email_addresses?domain_id=eq.${matchedDomain.id}&address=eq.${wantLocal}&limit=1`
          );
          if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
            matchedAddress = existing.data[0];
          } else {
            const created = await supabaseQuery(env, "/email_addresses", {
              method: "POST",
              body: {
                domain_id: matchedDomain.id,
                address: wantLocal,
                display_name: agentDisplayName(wantLocal),
                is_active: true,
              },
            });
            if (created.ok && Array.isArray(created.data) && created.data[0]) {
              matchedAddress = created.data[0];
            }
          }
        } catch (e) {
          console.error("ensure agent address failed (non-fatal):", e);
        }
      }
    }
  }

  let finalSubject = subject;
  if (isCatchAll && matchedDomain.catch_all_subject_prefix) {
    finalSubject = `${matchedDomain.catch_all_subject_prefix} ${subject}`;
  }

  const fromParsed = resolveFrom(fromRaw, getHeader(headers, "from"));
  const fromAddress = fromParsed.address;
  const fromName = fromParsed.name;

  const catchAllAddressId =
    isCatchAll && matchedDomain.catchall_destination_address_id
      ? matchedDomain.catchall_destination_address_id
      : null;

  const [junkSettings, activeRules] = await Promise.all([
    readSetting(env, "junk", SETTINGS_DEFAULTS.junk),
    fetchActiveRules(env),
  ]);

  let spamVerdict: SpamVerdict;
  if (spamVerdictOverride) {
    spamVerdict = spamVerdictOverride;
  } else if (isAgent) {
    spamVerdict = { is_spam: false, score: 0, reason: "agent_mailbox" };
  } else if (skipLlmSpam) {
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
        { ...junkSettings, llmAssist: false }
      );
    } catch (e) {
      console.error("Spam classifier threw (non-fatal):", e);
      spamVerdict = { is_spam: false, score: 0, reason: "classifier_error" };
    }
  } else {
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
  }

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
      applyRuleActions(
        applicable,
        {
          from: fromAddress.toLowerCase().trim(),
          to: toAddresses.map((a: string) => (a || "").toLowerCase()),
          subject: finalSubject || "",
        },
        delivery
      );
    }
  } catch (e) {
    console.error("Rules pass threw (non-fatal):", e);
  }

  if (isAgent) {
    delivery.folder = AGENT_FOLDER;
    delivery.is_read = true;
    delivery.is_spam = false;
    delivery.is_trash = false;
    delivery.is_archived = false;
    isCatchAll = false;
  }

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

  const msgRes = await supabaseQuery(env, "/email_messages", {
    method: "POST",
    body: {
      domain_id: matchedDomain.id,
      address_id: matchedAddress?.id || catchAllAddressId || null,
      direction: "inbound",
      resend_email_id: resendEmailId || null,
      ingest_message_id: ingestMessageId || null,
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
  const domainName = String(matchedDomain.domain || "");

  const seenNames = new Set<string>();

  if (binaryAttachments?.length) {
    for (let i = 0; i < binaryAttachments.length; i++) {
      const att = binaryAttachments[i];
      const filename = att.filename.replace(/[/\\]+/g, "_") || `attachment-${i + 1}`;
      if (seenNames.has(filename)) continue;
      seenNames.add(filename);
      try {
        await storeBinaryAttachment(
          env,
          domainName,
          message.id,
          filename,
          att.content_type || "application/octet-stream",
          att.data
        );
      } catch (e) {
        console.error("Binary attachment error:", e);
      }
    }
  }

  if (resendAttachments?.emailId && resendAttachments.resendGet) {
    const webhookAttachments = attachmentsFromResend(resendAttachments.webhookAttachments || []);
    const attachmentsData = await resendAttachments.resendGet(
      `/emails/receiving/${resendAttachments.emailId}/attachments`
    );
    const apiAttachments = attachmentsFromResend(attachmentsData);
    const candidates =
      apiAttachments.length > 0
        ? apiAttachments
        : webhookAttachments.length > 0
        ? webhookAttachments
        : attachmentsFromResend(resendAttachments.fullEmailAttachments || []);

    for (let i = 0; i < candidates.length; i++) {
      const att = candidates[i];
      const filename = attachmentFilename(att, i);
      if (seenNames.has(filename)) continue;
      const downloadUrl = att.download_url;
      if (!downloadUrl) continue;
      try {
        const downloadRes = await fetch(downloadUrl);
        if (!downloadRes.ok) continue;
        const fileBuffer = await downloadRes.arrayBuffer();
        const contentType =
          att.content_type || downloadRes.headers.get("content-type") || "application/octet-stream";
        seenNames.add(filename);
        await storeBinaryAttachment(
          env,
          domainName,
          message.id,
          filename,
          contentType,
          fileBuffer,
          att.size || att.size_bytes || fileBuffer.byteLength
        );
      } catch (e) {
        console.error("Resend attachment error:", e);
      }
    }
  }

  try {
    await fetch(new URL("/api/email/contacts", requestUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contacts: [{ email: fromAddress, display_name: fromName, direction: "received" }],
      }),
    });
  } catch (e) {
    console.error("Contact learning failed (non-fatal):", e);
  }

  let shouldNotify =
    delivery.folder === "inbox" &&
    !delivery.is_read &&
    !delivery.is_spam &&
    !delivery.is_trash &&
    !delivery.is_archived;

  if (shouldNotify && isAgent) shouldNotify = false;

  if (isAgent && message?.id) {
    try {
      await maybeCloudChat(env, {
        messageId: String(message.id),
        fromAddress,
        toAddresses,
        ccAddresses,
        matchedLocal,
        subject: finalSubject,
        bodyText: bodyText || "",
        domain: domainName,
        resendEmailId: resendEmailId || "",
      });
    } catch (e) {
      console.error("cloud chat failed (non-fatal):", e);
    }
  }

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
      const bodyPreview = bodyText ? bodyText.replace(/\s+/g, " ").trim().substring(0, 100) : "";
      const pushPayload = {
        title: `📧 ${fromName || fromAddress}`,
        body: bodyPreview
          ? `${finalSubject}\n${bodyPreview}${bodyPreview.length >= 100 ? "..." : ""}`
          : finalSubject.length > 80
          ? finalSubject.substring(0, 80) + "..."
          : finalSubject,
        type: "email",
        messageId: message.id,
        from: fromName || fromAddress,
        subject: finalSubject,
        domain: domainName,
      };
      const vapidPublicKey = env.VAPID_PUBLIC_KEY;
      const vapidPrivateKey = env.VAPID_PRIVATE_KEY;
      if (vapidPublicKey && vapidPrivateKey) {
        const results = await broadcastPush(subsRes.data, pushPayload, vapidPublicKey, vapidPrivateKey);
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
          }
        }
      }
    }
  } catch (pushErr) {
    console.error("Push notification error:", pushErr);
  }

  return jsonResponse({ received: true, message_id: message.id }, 200);
}
