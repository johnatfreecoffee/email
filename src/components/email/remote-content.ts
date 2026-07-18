// Remote-content blocking for HTML mail (privacy: tracking pixels, read
// receipts). Best-effort neutralization by attribute rename — a renamed
// attribute triggers no fetch and no broken-image chrome. Runs on the raw
// body_html BEFORE it enters the sandboxed iframe srcdoc; the iframe's
// sandbox/link-hijack remains the security boundary.
//
// cid: and data: inline images pass untouched by construction (only http/https
// and protocol-relative URLs are neutralized).

const REMOTE_ATTR_RE = /\s(src|srcset|poster|background|href)\s*=\s*(["'])\s*((?:https?:)?\/\/[^"']*)\2/gi;
const STYLE_URL_RE = /url\(\s*(["']?)((?:https?:)?\/\/[^)"']*)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\/[^;)"']*["']?\s*\)?\s*;?/gi;

export function stripRemoteContent(html: string): { html: string; blocked: number } {
  let blocked = 0;

  let out = html.replace(REMOTE_ATTR_RE, (match, attr: string, quote: string, url: string, offset: number, full: string) => {
    // href: only neutralize on <link> elements (stylesheets/prefetch) — anchor
    // hrefs don't load anything until clicked, and clicks open externally.
    if (attr.toLowerCase() === "href") {
      const tagStart = full.lastIndexOf("<", offset);
      const tag = full.slice(tagStart + 1, tagStart + 5).toLowerCase();
      if (!tag.startsWith("link")) return match;
    }
    blocked++;
    return ` data-mc-blocked-${attr.toLowerCase()}=${quote}${url}${quote}`;
  });

  out = out.replace(STYLE_URL_RE, () => {
    blocked++;
    return "url()";
  });

  out = out.replace(IMPORT_RE, () => {
    blocked++;
    return "";
  });

  return { html: out, blocked };
}
