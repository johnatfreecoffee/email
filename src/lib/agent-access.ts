/** Prompt locks + flow copy. Worker (access.py) enforces; this is what the UI shows. */

export type PermKey = "read" | "write" | "update" | "delete";
export type GrantMode = "ask" | "custom" | "all";

export interface Grant {
  enabled: boolean;
  mode: GrantMode;
  perms: Record<PermKey, boolean>;
}

export const PERMS: PermKey[] = ["read", "write", "update", "delete"];

export const ASK_WORK_RULE = "- QUESTIONS ONLY. Do not change any files. Answer, then stop.";
export const CODE_WORK_RULE =
  "- Do the work in the workspace with tools when they ask for code/project work, then summarize.";
export const COMMON_RULES = [
  "- If unclear, ask one short clarifying question.",
  "- Never invent secrets. Never send mail yourself — your stdout IS the email reply body.",
  "- Keep the reply under ~400 words unless they asked for detail.",
  "- Do not mention token counts unless asked.",
  "- Prefer finishing with a partial useful answer over running forever. If time is tight, ship what you have.",
];

export const ASK_LOCK =
  "HARD PERMISSION LOCK — QUESTIONS ONLY.\n" +
  "This sender may only ask questions. You MUST NOT create, edit, update, " +
  "or delete any files. You MUST NOT run mutating shell commands " +
  "(no install, no git write, no rm, no redirect-to-file). " +
  "Read-only inspection is allowed if needed to answer. " +
  "If they ask you to change code, refuse in one sentence and explain " +
  "they only have question access.";

export const ALL_LOCK = "This sender has full code access (read/write/update/delete) for this agent.";

export function customLock(bits: string[]): string {
  return (
    "HARD PERMISSION LOCK — LIMITED CODE ACCESS.\n" +
    `Allowed for this sender: ${bits.join(", ") || "read only"}.\n` +
    "You MUST NOT perform a disallowed action. " +
    "If they ask for something outside this grant, refuse and say which permission is missing."
  );
}

export function denyMessage(agentName: string, reason: string): string {
  const name = agentName || "this agent";
  if (reason === "no_agent") {
    return (
      `This mailbox is restricted. Your address isn't allowed to talk to ${name}. ` +
      "Ask the owner to enable it in Settings → Agents."
    );
  }
  return `This mailbox is restricted. ${name} didn't run your message.`;
}

export function questionsOnly(g: Grant): boolean {
  if (g.mode === "ask") return true;
  return !g.perms.write && !g.perms.update && !g.perms.delete;
}

export function previewFromGrant(g: Grant): {
  grok_runs: boolean;
  prompt: string;
  flags: string;
} {
  if (!g.enabled) {
    return {
      grok_runs: false,
      prompt: "Grok does not start.\nNo pre-prompt. No tools. No reply.",
      flags: "unchecked agent — email never reaches Grok for this mailbox",
    };
  }
  const q = questionsOnly(g);
  const all = g.mode === "all" || (g.perms.read && g.perms.write && g.perms.update && g.perms.delete);
  let lock: string;
  if (q) lock = ASK_LOCK;
  else if (all) lock = ALL_LOCK;
  else lock = customLock(PERMS.filter((k) => g.perms[k]));
  const wr = q ? ASK_WORK_RULE : CODE_WORK_RULE;
  const rules = [wr, ...COMMON_RULES].join("\n");
  if (all && !q) {
    return {
      grok_runs: true,
      prompt: `${lock}\n\nRules:\n${rules}`,
      flags: "--always-approve --permission-mode bypassPermissions",
    };
  }
  const tools: string[] = [];
  const deny: string[] = [];
  if (q || !g.perms.write) {
    tools.push("write");
    deny.push("Write(*)");
  }
  if (q || !g.perms.update) {
    tools.push("search_replace");
    deny.push("Edit(*)");
  }
  if (q || !g.perms.delete) deny.push("Bash(rm *)", "Bash(rmdir *)", "Bash(unlink *)");
  const mode = q ? "plan" : "dontAsk";
  const flagBits = [`--permission-mode ${mode}`];
  if (tools.length) flagBits.push(`--disallowed-tools ${tools.join(",")}`);
  deny.forEach((r) => flagBits.push(`--deny ${r}`));
  return {
    grok_runs: true,
    prompt: `${lock}\n\nRules:\n${rules}`,
    flags: `--always-approve ${flagBits.join(" ")}`,
  };
}

export function howItWorks() {
  const ask: Grant = {
    enabled: true,
    mode: "ask",
    perms: { read: true, write: false, update: false, delete: false },
  };
  const custom: Grant = {
    enabled: true,
    mode: "custom",
    perms: { read: true, write: true, update: false, delete: false },
  };
  const all: Grant = {
    enabled: true,
    mode: "all",
    perms: { read: true, write: true, update: true, delete: true },
  };
  return {
    flow: [
      {
        n: 1,
        title: "Email hits an agent mailbox",
        body: "Someone writes an a.* / e.* address. The worker on the hands machine picks it up.",
      },
      {
        n: 2,
        title: "Are they on Users?",
        body: "From-address is checked against Settings → Agents. Not on the list → stop. Grok never starts. No reply.",
      },
      {
        n: 3,
        title: "Are they in Archive?",
        body: "Archived people stay in the file but are off. Same as not on the list: no Grok, no reply.",
      },
      {
        n: 4,
        title: "Is this agent checked for them?",
        body: "On the list but this agent unchecked → Grok still does not start. They get a short denial email. Other checked agents still work.",
      },
      {
        n: 5,
        title: "Grok starts with a hidden pre-prompt",
        body: "Only then do we spawn Grok. We prepend a lock the sender never sees, plus tool blocks so it cannot ignore the note.",
      },
    ],
    stops: [
      {
        id: "unknown",
        title: "Not on the list",
        grok: false,
        reply: "None — silent. We do not confirm the mailbox exists.",
      },
      {
        id: "archived",
        title: "In Archive",
        grok: false,
        reply: "None — silent. Restore them on the Archive tab to turn them back on.",
      },
      {
        id: "no_agent",
        title: "On the list, this agent unchecked",
        grok: false,
        reply: denyMessage("Agent NokNok", "no_agent"),
      },
    ],
    previews: {
      ask: previewFromGrant(ask),
      custom: previewFromGrant(custom),
      all: previewFromGrant(all),
    },
  };
}

export function blankGrant(): Grant {
  return { enabled: false, mode: "ask", perms: { read: true, write: false, update: false, delete: false } };
}

export function normalizeGrant(raw: unknown): Grant {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const permsSrc = src.perms && typeof src.perms === "object" ? (src.perms as Record<string, unknown>) : {};
  const perms = {
    read: !!permsSrc.read,
    write: !!permsSrc.write,
    update: !!permsSrc.update,
    delete: !!permsSrc.delete,
  };
  let mode: GrantMode = src.mode === "all" || src.mode === "custom" || src.mode === "ask" ? src.mode : "ask";
  if (mode === "all") Object.assign(perms, { read: true, write: true, update: true, delete: true });
  if (mode === "ask") Object.assign(perms, { read: true, write: false, update: false, delete: false });
  if (perms.read && perms.write && perms.update && perms.delete) mode = "all";
  else if (!perms.write && !perms.update && !perms.delete) mode = "ask";
  else mode = "custom";
  return { enabled: !!src.enabled, mode, perms };
}
