export function parseAddressList(headerValue: string | null | undefined): string[] {
  if (!headerValue) return [];
  const matches = headerValue.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);
  return matches ? matches.map((s) => s.toLowerCase()) : [];
}

export function getHeader(
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

export function decodeMimeWords(input: string): string {
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

export function splitNameAddr(value: string): { name: string | null; address: string } {
  const v = (value || "").trim();
  const m = v.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].trim().replace(/^["']|["']$/g, "").trim();
    return { name: name || null, address: m[2].trim() };
  }
  return { name: null, address: v };
}

export function resolveFrom(
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
