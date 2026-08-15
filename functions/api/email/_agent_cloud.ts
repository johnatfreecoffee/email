import { Env, supabaseQuery, resendAPI } from "./_shared";
import { agentDisplayName, isAgentLocal, localPartOf } from "./_agent";

const STALE_MS = 120_000;
const ASK_LOCK =
  "HARD PERMISSION LOCK — QUESTIONS ONLY.\n" +
  "This sender may only ask questions. You MUST NOT create, edit, update, " +
  "or delete any files. You have no tools. Answer in plain email body only. " +
  "If they ask you to change code, refuse in one sentence and explain " +
  "they only have question access.";

export function normalizeEmail(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^.*<([^>]+)>.*$/, "$1");
}

function questionsOnly(mode: string, perms: Record<string, unknown> | null): boolean {
  if (mode === "ask") return true;
  const p = perms || {};
  return !p.write && !p.update && !p.delete;
}

async function workerOnline(env: Env): Promise<{ online: boolean; hands: string }> {
  const r = await supabaseQuery(env, "/agent_runtime?id=eq.1");
  if (!r.ok || !Array.isArray(r.data) || !r.data[0]) return { online: false, hands: "auto" };
  const row = r.data[0] as { worker_seen_at?: string; hands?: string };
  const hands = row.hands === "api" || row.hands === "local" || row.hands === "box" ? row.hands : "auto";
  const t = row.worker_seen_at ? Date.parse(row.worker_seen_at) : NaN;
  const online = !Number.isNaN(t) && Date.now() - t <= STALE_MS;
  return { online, hands };
}

async function loadGrant(env: Env, fromAddr: string, agentLocal: string) {
  const email = normalizeEmail(fromAddr);
  const senders = await supabaseQuery(env, `/agent_senders?email=eq.${encodeURIComponent(email)}&limit=1`);
  if (!senders.ok || !Array.isArray(senders.data) || !senders.data[0]) {
    return { reason: "unknown" as const, grant: null, sender: null };
  }
  const sender = senders.data[0] as { id: string; archived?: boolean; first_name?: string };
  if (sender.archived) return { reason: "archived" as const, grant: null, sender };
  const g = await supabaseQuery(
    env,
    `/agent_sender_grants?sender_id=eq.${sender.id}&agent_local=eq.${encodeURIComponent(agentLocal)}&limit=1`
  );
  const grant = g.ok && Array.isArray(g.data) ? (g.data[0] as Record<string, unknown> | undefined) : undefined;
  if (!grant || !grant.enabled) return { reason: "no_agent" as const, grant: null, sender };
  return { reason: "ok" as const, grant, sender };
}

async function markHandled(env: Env, messageId: string, via: string): Promise<boolean> {
  const r = await supabaseQuery(env, "/agent_handled_messages", {
    method: "POST",
    body: { message_id: messageId, via },
  });
  if (r.ok) return true;
  // unique conflict = already handled
  const code = (r.data as { code?: string } | null)?.code;
  return code === "23505";
}

async function alreadyHandled(env: Env, messageId: string): Promise<boolean> {
  const r = await supabaseQuery(env, `/agent_handled_messages?message_id=eq.${messageId}&select=via`);
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

async function xaiReply(env: Env, prompt: string): Promise<string | null> {
  const key = (env as Env & { XAI_API_KEY?: string }).XAI_API_KEY;
  if (!key) return null;
  const models = ["grok-3", "grok-2-latest"];
  for (const model of models) {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: ASK_LOCK },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
      }),
    });
    if (!res.ok) continue;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (text) return text.slice(0, 8000);
  }
  return null;
}

async function sendAgentMail(
  env: Env,
  opts: {
    fromHeader: string;
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string | null;
  }
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    from: opts.fromHeader,
    to: [opts.to],
    subject: opts.subject,
    text: opts.text,
  };
  if (opts.inReplyTo) {
    const mid = opts.inReplyTo.startsWith("<") ? opts.inReplyTo : `<${opts.inReplyTo}>`;
    payload.headers = { "In-Reply-To": mid, References: mid };
  }
  const r = await resendAPI(env, "/emails", { method: "POST", body: payload });
  return r.ok;
}

/** After inbound stores an agent message: maybe reply via xAI if the Mac is down. */
export async function maybeCloudChat(
  env: Env,
  args: {
    messageId: string;
    fromAddress: string;
    toAddresses: string[];
    matchedLocal: string;
    subject: string;
    bodyText: string;
    domain: string;
    resendEmailId?: string | null;
  }
): Promise<void> {
  if (!args.messageId) return;
  if (await alreadyHandled(env, args.messageId)) return;

  const local = isAgentLocal(args.matchedLocal)
    ? args.matchedLocal.toLowerCase()
    : localPartOf((args.toAddresses || []).find((a) => isAgentLocal(localPartOf(a))) || "");
  if (!local) return;

  const { online, hands } = await workerOnline(env);
  // local = Mac only. api = Function handles ask-only even if Mac is up.
  // auto (default) = Function only when Mac is stale.
  if (hands === "local") return;
  if (hands !== "api" && online) return;

  const auth = await loadGrant(env, args.fromAddress, local);
  if (auth.reason === "unknown" || auth.reason === "archived") return;

  const claimed = await markHandled(env, args.messageId, "cloud-pending");
  if (!claimed) return;

  const display = agentDisplayName(local);
  const fromHeader = `${display} <${local}@${args.domain}>`;
  const subj = args.subject.startsWith("Re:") ? args.subject : `Re: ${args.subject}`;

  if (auth.reason === "no_agent") {
    const text =
      `This mailbox is restricted. Your address isn't allowed to talk to ${display}. ` +
      "Ask the owner to enable it in Settings → Agents.";
    const sent = await sendAgentMail(env, {
      fromHeader,
      to: args.fromAddress,
      subject: subj,
      text,
      inReplyTo: args.resendEmailId,
    });
    return;
  }

  const mode = String(auth.grant?.mode || "ask");
  const perms = (auth.grant?.perms as Record<string, unknown>) || {};
  const ask = questionsOnly(mode, perms);

  if (!ask) {
    const text =
      `${display} needs This machine (or a Cloud box) to change code. ` +
      "The worker is offline. Ask a question if you only need an answer, or wait until the machine is back.";
    const sent = await sendAgentMail(env, {
      fromHeader,
      to: args.fromAddress,
      subject: subj,
      text,
      inReplyTo: args.resendEmailId,
    });
    return;
  }

  const prompt =
    `You are ${display}. Reply as a person, not an agent log.\n` +
    `Print ONLY the finished email. Short. Real paragraphs. No process talk.\n` +
    `No memory/git/deploy narration. One link if useful. They will ask if they want more.\n` +
    `No subject line.\n\n` +
    `From: ${args.fromAddress}\nSubject: ${args.subject}\n\n${args.bodyText || "(empty)"}`;
  const reply = await xaiReply(env, prompt);
  if (!reply) {
    const sent = await sendAgentMail(env, {
      fromHeader,
      to: args.fromAddress,
      subject: subj,
      text: "Cloud chat is not configured (missing XAI_API_KEY) and the local worker is offline.",
      inReplyTo: args.resendEmailId,
    });
    return;
  }

  await sendAgentMail(env, {
    fromHeader,
    to: args.fromAddress,
    subject: subj,
    text: reply,
    inReplyTo: args.resendEmailId,
  });
}
