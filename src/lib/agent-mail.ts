/** a.noknok@ / e.grokdesk@ — hidden from inbox/catch-all, live in Agents folders. */
export const AGENT_FOLDER = "agent";
/** Kanban of agent_jobs — sidebar entry next to Agents, not a mail folder. */
export const BOARD_FOLDER = "board";

export function isAgentLocal(local: string | null | undefined): boolean {
  return !!local && /^[ae]\./i.test(String(local).trim());
}

export function isAgentAddress(addr: { address?: string | null } | null | undefined): boolean {
  return isAgentLocal(addr?.address);
}
