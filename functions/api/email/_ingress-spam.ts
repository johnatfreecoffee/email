import type { SpamVerdict } from "./_spam";

const CF_SPAM_SCORE_THRESHOLD = 5;

function headerVal(headers: Record<string, string> | null, name: string): string {
  if (!headers) return "";
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k] || "";
  }
  return "";
}

/** Cloudflare Email Routing / ingress signals — hard-route junk before LLM. */
export function ingressSpamVerdict(headers: Record<string, string> | null): SpamVerdict | null {
  const cfScoreRaw =
    headerVal(headers, "X-CF-SpamH-Score") ||
    headerVal(headers, "x-cf-spamh-score") ||
    headerVal(headers, "X-Cf-Spamh-Score");
  const cfScore = parseFloat((cfScoreRaw || "").trim());
  if (!Number.isNaN(cfScore) && cfScore >= CF_SPAM_SCORE_THRESHOLD) {
    return {
      is_spam: true,
      score: Math.min(1, cfScore / 10),
      reason: "cf_spamh_score",
    };
  }

  const auth = headerVal(headers, "Authentication-Results").toLowerCase();
  const spfFail = /spf=(fail|softfail)\b/.test(auth);
  const dkimFail = /dkim=fail\b/.test(auth);
  const dmarcFail = /dmarc=fail\b/.test(auth);
  if (spfFail && dkimFail) {
    return { is_spam: true, score: 0.9, reason: "ingress_spf_dkim_fail" };
  }
  if (dmarcFail && (spfFail || dkimFail)) {
    return { is_spam: true, score: 0.85, reason: "ingress_dmarc_fail" };
  }

  return null;
}
