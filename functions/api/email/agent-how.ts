import { jsonResponse, optionsResponse, checkAuth, type Env } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// Keep in lockstep with src/lib/agent-access.ts + worker access.py
const ASK_LOCK =
  "HARD PERMISSION LOCK — QUESTIONS ONLY.\n" +
  "This sender may only ask questions. You MUST NOT create, edit, update, " +
  "or delete any files. You MUST NOT run mutating shell commands " +
  "(no install, no git write, no rm, no redirect-to-file). " +
  "Read-only inspection is allowed if needed to answer. " +
  "If they ask you to change code, refuse in one sentence and explain " +
  "they only have question access.";
const ALL_LOCK = "This sender has full code access (read/write/update/delete) for this agent.";
const ASK_WORK = "- QUESTIONS ONLY. Do not change any files. Answer, then stop.";
const CODE_WORK =
  "- Do the work in the workspace with tools when they ask for code/project work, then summarize.";
const COMMON = [
  "- Your stdout IS the email they read. Print only the finished note.",
  "- Write like a person: short sentences, real paragraphs, blank lines between them.",
  "- No process talk (no checking memory/git/deploy, no \"then sending the reply\").",
  "- Don't dump every URL or path. One link if useful. They will ask if they want more.",
  "- If unclear, ask one short clarifying question.",
  "- Never invent secrets. Never send mail yourself.",
  "- Prefer finishing with a partial useful answer over running forever.",
];

function pack(lock: string, work: string, flags: string) {
  return { grok_runs: true, prompt: `${lock}\n\nRules:\n${[work, ...COMMON].join("\n")}`, flags };
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  if (request.method === "OPTIONS") return optionsResponse(origin);
  const authError = await checkAuth(request, env);
  if (authError) return authError;
  if (request.method !== "GET") return jsonResponse({ error: "method" }, 405, origin);

  const customLock =
    "HARD PERMISSION LOCK — LIMITED CODE ACCESS.\n" +
    "Allowed for this sender: read, write.\n" +
    "You MUST NOT perform a disallowed action. " +
    "If they ask for something outside this grant, refuse and say which permission is missing.";

  return jsonResponse(
    {
      flow: [
        { n: 1, title: "Email hits an agent mailbox", body: "Someone writes an a.* / e.* address. The worker on the hands machine picks it up." },
        { n: 2, title: "Are they on Users?", body: "From-address is checked against Settings → Agents. Not on the list → stop. Grok never starts. No reply." },
        { n: 3, title: "Are they in Archive?", body: "Archived people stay in the file but are off. Same as not on the list: no Grok, no reply." },
        { n: 4, title: "Is this agent checked for them?", body: "On the list but this agent unchecked → Grok still does not start. They get a short denial email. Other checked agents still work." },
        { n: 5, title: "Grok starts with a hidden pre-prompt", body: "Only then do we spawn Grok. We prepend a lock the sender never sees, plus tool blocks so it cannot ignore the note." },
      ],
      stops: [
        { id: "unknown", title: "Not on the list", grok: false, reply: "None — silent. We do not confirm the mailbox exists." },
        { id: "archived", title: "In Archive", grok: false, reply: "None — silent. Restore them on the Archive tab to turn them back on." },
        {
          id: "no_agent",
          title: "On the list, this agent unchecked",
          grok: false,
          reply:
            "This mailbox is restricted. Your address isn't allowed to talk to Agent NokNok. Ask the owner to enable it in Settings → Agents.",
        },
      ],
      previews: {
        ask: pack(ASK_LOCK, ASK_WORK, "--always-approve --permission-mode plan --disallowed-tools write,search_replace --deny Write(*) --deny Edit(*) --deny Bash(rm *)"),
        custom: pack(
          customLock,
          CODE_WORK,
          "--always-approve --permission-mode dontAsk --disallowed-tools search_replace --deny Edit(*) --deny Bash(rm *)"
        ),
        all: pack(ALL_LOCK, CODE_WORK, "--always-approve --permission-mode bypassPermissions"),
      },
    },
    200,
    origin
  );
};
