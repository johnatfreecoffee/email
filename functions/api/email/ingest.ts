import { Env, errorResponse, jsonResponse } from "./_shared";
import { deliverInboundMessage, type BinaryAttachment } from "./_inbound-deliver";
import { ingressSpamVerdict } from "./_ingress-spam";
import { headersToRecord, messageIdFromHeaders, parseRawMime } from "./_mime";
interface CFContext {
  request: Request;
  env: Env;
}

const SECRET_HEADER = "X-Email-Ingest-Secret";

function checkIngestSecret(request: Request, env: Env): Response | null {
  const expected = env.EMAIL_INGEST_SECRET;
  if (!expected) {
    return errorResponse("Ingest not configured", 503);
  }
  const got = request.headers.get(SECRET_HEADER);
  if (!got || got !== expected) {
    return errorResponse("Unauthorized", 401);
  }
  return null;
}

function normalizeAddressList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).toLowerCase().trim()).filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function decodeBase64Attachments(
  raw: unknown
): BinaryAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: BinaryAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const filename = String((item as { filename?: string }).filename || "attachment").replace(
      /[/\\]+/g,
      "_"
    );
    const content_type = String((item as { content_type?: string }).content_type || "application/octet-stream");
    const b64 = (item as { data_base64?: string }).data_base64;
    if (!b64) continue;
    try {
      const bin = atob(b64.replace(/\s+/g, ""));
      const data = Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
      out.push({ filename, content_type, data });
    } catch {
      /* skip */
    }
  }
  return out;
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;

  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const authErr = checkIngestSecret(request, env);
  if (authErr) return authErr;

  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  let domainHint: string | null = null;
  let fromRaw = "";
  let envelopeTo: string[] = [];
  let ccAddresses: string[] = [];
  let bccAddresses: string[] = [];
  let subject = "(no subject)";
  let bodyText: string | null = null;
  let bodyHtml: string | null = null;
  let headers: Record<string, string> | null = null;
  let rawMime: string | null = null;
  let binaryAttachments: BinaryAttachment[] = [];
  let createdAt = new Date().toISOString();

  if (contentType.includes("message/rfc822") || contentType.includes("text/plain")) {
    rawMime = await request.text();
    const parsed = parseRawMime(rawMime);
    headers = { ...parsed.headers };
    for (const [k, v] of request.headers.entries()) {
      if (k.toLowerCase().startsWith("x-cf-") || k.toLowerCase() === "authentication-results") {
        headers[k] = v;
      }
    }
    bodyText = parsed.text;
    bodyHtml = parsed.html;
    fromRaw = headers["From"] || headers["from"] || "";
    envelopeTo = normalizeAddressList(headers["To"] || headers["to"]);
    ccAddresses = normalizeAddressList(headers["Cc"] || headers["cc"]);
    subject = headers["Subject"] || headers["subject"] || subject;
  } else {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    domainHint = body.domain ? String(body.domain).toLowerCase().trim() : null;
    fromRaw = String(body.from || "");
    envelopeTo = normalizeAddressList(body.to);
    ccAddresses = normalizeAddressList(body.cc);
    bccAddresses = normalizeAddressList(body.bcc);
    subject = String(body.subject || subject);
    bodyText = body.text != null ? String(body.text) : null;
    bodyHtml = body.html != null ? String(body.html) : null;
    if (body.headers && typeof body.headers === "object") {
      headers = body.headers as Record<string, string>;
    }
    if (body.received_at) createdAt = String(body.received_at);
    if (typeof body.raw === "string") rawMime = body.raw;
    binaryAttachments = decodeBase64Attachments(body.attachments);

    if (rawMime && (!bodyText && !bodyHtml)) {
      const parsed = parseRawMime(rawMime);
      headers = { ...(headers || {}), ...parsed.headers };
      bodyText = parsed.text;
      bodyHtml = parsed.html;
      if (!fromRaw) fromRaw = headers["From"] || headers["from"] || "";
      if (envelopeTo.length === 0) {
        envelopeTo = normalizeAddressList(headers["To"] || headers["to"]);
      }
      if (!subject || subject === "(no subject)") {
        subject = headers["Subject"] || headers["subject"] || subject;
      }
    }
  }

  if (!domainHint) {
    const first = envelopeTo[0] || "";
    domainHint = first.includes("@") ? first.split("@")[1]?.toLowerCase() : null;
  }

  if (!headers && rawMime) {
    headers = headersToRecord(rawMime.split(/\r?\n\r?\n/)[0] + "\n\n");
  }

  let ingestMessageId = messageIdFromHeaders(headers);
  if (!ingestMessageId && rawMime) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(rawMime.slice(0, 50000))
    );
    ingestMessageId = `raw:${Array.from(new Uint8Array(digest))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 40)}`;
  }

  const ingress = ingressSpamVerdict(headers);

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
    ingestMessageId,
    domainHint,
    binaryAttachments,
    spamVerdictOverride: ingress,
    skipLlmSpam: true,
  });
};
