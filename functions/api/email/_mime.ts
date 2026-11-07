/** Minimal MIME parser for ingress (no native deps). */

export function headersToRecord(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  let current = "";
  for (const line of lines) {
    if (line === "") break;
    if (/^\s/.test(line) && current) {
      const key = current.split(":")[0];
      out[key] = (out[key] || "") + " " + line.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    current = line;
    out[name] = val;
  }
  return out;
}

function headerValue(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value || "";
  }
  return "";
}

function decodeQuotedPrintable(input: string): string {
  const bytes: number[] = [];
  const collapsed = input.replace(/=\r?\n/g, "");
  for (let i = 0; i < collapsed.length; i++) {
    if (collapsed[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(collapsed.slice(i + 1, i + 3))) {
      bytes.push(parseInt(collapsed.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(collapsed.charCodeAt(i) & 0xff);
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
}

function decodeTransfer(body: string, encoding: string): string {
  const enc = encoding.toLowerCase();
  if (enc.includes("quoted-printable")) return decodeQuotedPrintable(body);
  if (enc.includes("base64")) {
    try {
      const bin = atob(body.replace(/\s+/g, ""));
      return new TextDecoder("utf-8", { fatal: false }).decode(
        Uint8Array.from(bin, (c) => c.charCodeAt(0))
      );
    } catch {
      return body;
    }
  }
  return body;
}

function extractBodies(entity: string): { text: string | null; html: string | null } {
  const trimmed = entity.replace(/^\r?\n/, "");
  const headers = headersToRecord(trimmed);
  const ctRaw = headerValue(headers, "content-type");
  const ct = ctRaw.toLowerCase();
  const idx = trimmed.search(/\r?\n\r?\n/);
  if (idx === -1) return { text: null, html: null };
  let body = trimmed.slice(idx).replace(/^\r?\n\r?\n/, "");

  if (ct.includes("multipart/")) {
    const boundary = (ctRaw.match(/boundary="?([^";\s]+)"?/i) || [])[1];
    if (!boundary) return { text: null, html: null };
    const marker = new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const pieces = trimmed.split(marker);
    if (pieces.length < 2) return { text: null, html: null };
    let text: string | null = null;
    let html: string | null = null;
    for (const part of pieces.slice(1)) {
      if (!part.trim() || part.trim() === "--") continue;
      const inner = extractBodies(part);
      if (inner.html && !html) html = inner.html;
      if (inner.text && !text) text = inner.text;
    }
    return { text, html };
  }

  body = decodeTransfer(body, headerValue(headers, "content-transfer-encoding"));
  if (ct.includes("text/html")) return { text: null, html: body.trim() || null };
  if (ct.includes("text/plain") || !ct) return { text: body.trim() || null, html: null };
  return { text: null, html: null };
}

export function parseRawMime(raw: string): {
  headers: Record<string, string>;
  text: string | null;
  html: string | null;
} {
  const headers = headersToRecord(raw);
  const bodies = extractBodies(raw);
  return { headers, text: bodies.text, html: bodies.html };
}

export function messageIdFromHeaders(headers: Record<string, string> | null): string | null {
  if (!headers) return null;
  const raw =
    headers["Message-ID"] ||
    headers["Message-Id"] ||
    headers["message-id"] ||
    "";
  const trimmed = raw.trim().replace(/^<|>$/g, "");
  return trimmed || null;
}
