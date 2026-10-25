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

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function extractBody(part: string): { text: string | null; html: string | null } {
  const split = part.match(/\r?\n\r?\n/);
  if (!split) return { text: null, html: null };
  const idx = part.search(/\r?\n\r?\n/);
  const head = part.slice(0, idx);
  let body = part.slice(idx).replace(/^\r?\n\r?\n/, "");
  const ct = (head.match(/content-type:\s*([^;\r\n]+)/i) || [])[1]?.toLowerCase() || "text/plain";
  const enc = (head.match(/content-transfer-encoding:\s*([^\r\n]+)/i) || [])[1]?.toLowerCase() || "";
  if (enc.includes("quoted-printable")) body = decodeQuotedPrintable(body);
  if (enc.includes("base64")) {
    try {
      const bin = atob(body.replace(/\s+/g, ""));
      body = new TextDecoder("utf-8", { fatal: false }).decode(
        Uint8Array.from(bin, (c) => c.charCodeAt(0))
      );
    } catch {
      /* keep raw */
    }
  }
  if (ct.includes("text/html")) return { text: null, html: body.trim() || null };
  if (ct.includes("text/plain")) return { text: body.trim() || null, html: null };
  return { text: null, html: null };
}

export function parseRawMime(raw: string): {
  headers: Record<string, string>;
  text: string | null;
  html: string | null;
} {
  const headers = headersToRecord(raw);
  const topCt = (headers["Content-Type"] || headers["content-type"] || "").toLowerCase();

  if (topCt.includes("multipart/")) {
    const boundaryMatch = topCt.match(/boundary="?([^";\s]+)"?/);
    const boundary = boundaryMatch?.[1];
    if (!boundary) return { headers, text: null, html: null };
    const parts = raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    let text: string | null = null;
    let html: string | null = null;
    for (const part of parts) {
      if (!part.trim() || part.trim() === "--") continue;
      const b = extractBody(part);
      if (b.html && !html) html = b.html;
      if (b.text && !text) text = b.text;
    }
    return { headers, text, html };
  }

  const body = extractBody(raw);
  return { headers, text: body.text, html: body.html };
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
