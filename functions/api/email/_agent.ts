// Agent Mail identities: a.noknok@, e.grokdesk@, …
// These stay deliverable for the local worker but live in folder=agent
// so they never pollute inbox / catch-all / All Mail.

export const AGENT_FOLDER = "agent";

export function isAgentLocal(local: string | null | undefined): boolean {
  return !!local && /^[ae]\./i.test(String(local).trim());
}

export function localPartOf(addr: string | null | undefined): string {
  return String(addr || "").toLowerCase().split("@")[0] || "";
}

export function isAgentRecipient(toAddresses: string[] | null | undefined, matchedLocal?: string | null): boolean {
  if (isAgentLocal(matchedLocal)) return true;
  return (toAddresses || []).some((a) => isAgentLocal(localPartOf(a)));
}

export function agentDisplayName(local: string): string {
  const l = String(local || "").trim().toLowerCase();
  if (l.startsWith("e.")) {
    return l
      .slice(2)
      .split(/[._-]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || "Agent";
  }
  const rest = l.replace(/^a\./, "");
  const name = rest
    .split(/[._-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return name ? `Agent ${name}` : "Agent";
}
