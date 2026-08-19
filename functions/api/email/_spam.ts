// Spam classifier — heuristic fast-path + free OpenRouter model + sender-cache.
//
// classifySpam() runs in this order:
//   1. Check email_sender_reputation for a cached verdict on `from_address`.
//      If `verdict='spam'` or `'trusted'` (or user_override=true), return that.
//   2. Heuristic fast-path: SPF/DKIM fail + suspicious pattern => spam.
//      (We never short-circuit "trusted" from heuristics — only "spam".)
//   3. Call OpenRouter free model with subject + body preview + from.
//      Try gemini-2.0-flash-exp:free, then llama-3.3-70b-instruct:free.
//   4. On any error, fall back to heuristic-only score (defaults to 0.0 / ham).
//   5. Upsert the sender reputation so the next message is decided in step 1.
//
// SPAM_THRESHOLD = 0.7 — score at/above marks is_spam=true and folder='spam'.

import { Env, supabaseQuery } from "./_shared";

const SPAM_THRESHOLD = 0.7;

// User-tunable knobs (Settings → Junk Mail), threaded in by inbound.ts from
// the email_settings row; defaults preserve historical behavior.
export interface JunkSettings {
  llmAssist: boolean;
  threshold: number;
}

export const DEFAULT_JUNK_SETTINGS: JunkSettings = {
  llmAssist: true,
  threshold: SPAM_THRESHOLD,
};

const FREE_MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

export interface SpamInput {
  subject: string;
  body_text: string | null;
  from_address: string;
  headers: Record<string, string> | null;
  is_catch_all: boolean;
}

export interface SpamVerdict {
  is_spam: boolean;
  score: number; // 0.0..1.0
  reason: string;
}

function header(headers: Record<string, string> | null, name: string): string {
  if (!headers) return "";
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k] || "";
  }
  return "";
}

// Heuristic-only scoring. Never returns >0.85 by itself — anything ambiguous
// is left for the LLM to confirm.
function heuristicScore(input: SpamInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const authResults = header(input.headers, "Authentication-Results").toLowerCase();
  const spfFail = /spf=(fail|softfail|none)\b/.test(authResults);
  const dkimFail = /dkim=fail\b/.test(authResults);
  const dmarcFail = /dmarc=fail\b/.test(authResults);

  if (spfFail) { score += 0.25; reasons.push("spf_fail"); }
  if (dkimFail) { score += 0.25; reasons.push("dkim_fail"); }
  if (dmarcFail) { score += 0.15; reasons.push("dmarc_fail"); }

  // Random-looking local-part on the FROM address (e.g. xkjf9q3@...)
  const fromLocal = (input.from_address.split("@")[0] || "").toLowerCase();
  if (/^[a-z0-9]{12,}$/.test(fromLocal) && !/[aeiou]{2}/.test(fromLocal)) {
    score += 0.2;
    reasons.push("random_local_part");
  }

  // Subject screaming caps + exclamation
  const subj = (input.subject || "").trim();
  const longUpper = subj.length > 8 && subj.replace(/[^A-Z]/g, "").length / subj.length > 0.6;
  if (longUpper) { score += 0.15; reasons.push("subject_shouting"); }
  if (/(?:claim|prize|winner|congratulations|act now|limited time|click here|wire transfer|nigerian|inheritance|bitcoin|crypto giveaway)/i.test(subj)) {
    score += 0.2;
    reasons.push("subject_keyword");
  }

  // Catch-all + any of the above = stronger signal
  if (input.is_catch_all && score > 0.2) {
    score += 0.1;
    reasons.push("catch_all_amplifier");
  }

  // Clamp to 0.85 (LLM has the last word above that)
  if (score > 0.85) score = 0.85;

  return { score, reasons };
}

async function callOpenRouter(
  env: Env,
  model: string,
  input: SpamInput,
  threshold: number
): Promise<SpamVerdict | null> {
  if (!env.OPENROUTER_KEY) return null;

  const bodyPreview = (input.body_text || "").slice(0, 500).replace(/\s+/g, " ").trim();
  const promptUser = `From: ${input.from_address}
Subject: ${input.subject || "(no subject)"}
Catch-all delivery: ${input.is_catch_all ? "yes" : "no"}
Body (first 500 chars): ${bodyPreview || "(empty)"}`;

  const promptSystem = `You are an email spam classifier. Reply with ONLY a single JSON object on one line, no preamble, no markdown, no code fences. Schema:
{"is_spam": boolean, "score": number (0.0-1.0), "reason": "short_snake_case_label"}
Be conservative — only mark spam if you are confident. Marketing/newsletters from legit senders are NOT spam unless clearly malicious or scammy. Catch-all delivery alone is not spam.`;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://email.example",
        "X-Title": "Email Spam Filter",
      },
      body: JSON.stringify({
        model,
        max_tokens: 100,
        temperature: 0,
        messages: [
          { role: "system", content: promptSystem },
          { role: "user", content: promptUser },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`OpenRouter ${model} HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    // Strip code fences if the model added them anyway
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]) as { is_spam?: boolean; score?: number; reason?: string };
    const score = Math.max(0, Math.min(1, Number(parsed.score ?? 0)));
    return {
      is_spam: Boolean(parsed.is_spam) || score >= threshold,
      score,
      reason: String(parsed.reason || "llm").slice(0, 80),
    };
  } catch (e) {
    console.error(`OpenRouter ${model} threw:`, e);
    return null;
  }
}

async function lookupSender(env: Env, fromAddress: string) {
  const res = await supabaseQuery(
    env,
    `/email_sender_reputation?from_address=eq.${encodeURIComponent(fromAddress)}&limit=1`
  );
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return null;
  return res.data[0] as {
    from_address: string;
    verdict: "spam" | "trusted" | "unknown";
    spam_score: number | null;
    sample_count: number;
    user_override: boolean;
  };
}

async function upsertSender(
  env: Env,
  fromAddress: string,
  verdict: "spam" | "trusted" | "unknown",
  score: number,
  userOverride: boolean
) {
  const now = new Date().toISOString();
  // Try update first; if no row affected, insert.
  const updRes = await supabaseQuery(
    env,
    `/email_sender_reputation?from_address=eq.${encodeURIComponent(fromAddress)}`,
    {
      method: "PATCH",
      body: {
        verdict,
        spam_score: score,
        last_seen_at: now,
        user_override: userOverride,
        updated_at: now,
      },
    }
  );
  if (updRes.ok && Array.isArray(updRes.data) && updRes.data.length > 0) return;

  await supabaseQuery(env, "/email_sender_reputation", {
    method: "POST",
    body: {
      from_address: fromAddress,
      verdict,
      spam_score: score,
      user_override: userOverride,
    },
  });
}

export async function classifySpam(
  input: SpamInput,
  env: Env,
  junk: JunkSettings = DEFAULT_JUNK_SETTINGS
): Promise<SpamVerdict> {
  const threshold = Math.max(0.05, Math.min(0.99, junk.threshold ?? SPAM_THRESHOLD));
  const fromAddress = (input.from_address || "").toLowerCase().trim();

  // 1. Per-sender cache
  if (fromAddress) {
    const cached = await lookupSender(env, fromAddress);
    if (cached) {
      if (cached.user_override) {
        return {
          is_spam: cached.verdict === "spam",
          score: cached.verdict === "spam" ? 1.0 : 0.0,
          reason: "user_override",
        };
      }
      if (cached.verdict === "spam") {
        return { is_spam: true, score: cached.spam_score ?? 0.95, reason: "cached_spam" };
      }
      if (cached.verdict === "trusted") {
        return { is_spam: false, score: cached.spam_score ?? 0.05, reason: "cached_trusted" };
      }
      // 'unknown' — fall through to fresh classification
    }
  }

  // 2. Heuristic fast-path
  const h = heuristicScore(input);
  if (h.score >= threshold) {
    if (fromAddress) await upsertSender(env, fromAddress, "spam", h.score, false);
    return { is_spam: true, score: h.score, reason: `heuristic:${h.reasons.join(",")}` };
  }

  // 3. LLM (user-disableable; env key remains the second gate)
  let verdict: SpamVerdict | null = null;
  if (junk.llmAssist) {
    for (const model of FREE_MODELS) {
      verdict = await callOpenRouter(env, model, input, threshold);
      if (verdict) break;
    }
  }

  if (!verdict) {
    // 4. Fallback: heuristic-only verdict
    verdict = {
      is_spam: h.score >= threshold,
      score: h.score,
      reason: h.reasons.length
        ? `heuristic_only:${h.reasons.join(",")}`
        : junk.llmAssist
        ? "llm_unavailable"
        : "llm_disabled",
    };
  }

  // 5. Memoize
  if (fromAddress) {
    const cacheVerdict: "spam" | "trusted" | "unknown" = verdict.is_spam
      ? "spam"
      : verdict.score < 0.2
      ? "trusted"
      : "unknown";
    await upsertSender(env, fromAddress, cacheVerdict, verdict.score, false);
  }

  return verdict;
}

export const SPAM_FOLDER = "spam";
export const SPAM_THRESHOLD_VALUE = SPAM_THRESHOLD;
