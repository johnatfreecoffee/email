import type { EmailDomain } from "@/components/email/email-layout";

/** Sidebar / account label — display_label overrides apex domain. */
export function domainDisplayLabel(d: Pick<EmailDomain, "domain" | "display_label">): string {
  const label = (d.display_label || "").trim();
  return label || d.domain;
}
