import type { EmailDomain } from "@/components/email/email-layout";

/** Keep stored order, drop removed domains, append new ids at the end. */
export function mergeDomainOrder(stored: string[], domainIds: string[]): string[] {
  const live = new Set(domainIds);
  const next = stored.filter((id) => live.has(id));
  for (const id of domainIds) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

export function sortDomainsByOrder(domains: EmailDomain[], order: string[]): EmailDomain[] {
  if (!order.length) return domains;
  const byId = new Map(domains.map((d) => [d.id, d]));
  const out: EmailDomain[] = [];
  for (const id of order) {
    const d = byId.get(id);
    if (d) out.push(d);
  }
  for (const d of domains) {
    if (!out.some((x) => x.id === d.id)) out.push(d);
  }
  return out;
}
