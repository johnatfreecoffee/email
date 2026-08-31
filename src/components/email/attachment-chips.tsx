"use client";

/* Signed storage URLs are off-origin; next/image is unoptimized in this export. */
/* eslint-disable @next/next/no-img-element */

import { Download, ExternalLink, Paperclip, X } from "lucide-react";
import { useMemo, useState } from "react";

export type MailAttachment = {
  id: string;
  filename: string;
  content_type?: string;
  size_bytes?: number;
  storage_path?: string;
  signed_url?: string | null;
  url?: string | null;
};

function supabasePublicUrl(path: string): string {
  if (typeof window === "undefined") return "";
  const meta = document.querySelector('meta[name="supabase-url"]')?.getAttribute("content") || "";
  const base = meta || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  if (!base || !path) return "";
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/email-attachments/${path}`;
}

export function attachmentHref(att: MailAttachment): string {
  if (att.signed_url) return att.signed_url;
  if (att.url) return att.url;
  if (att.storage_path) return supabasePublicUrl(att.storage_path);
  return "";
}

export function formatBytes(bytes?: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function isPreviewableImage(att: MailAttachment): boolean {
  const t = (att.content_type || "").toLowerCase();
  if (t.includes("heic") || t.includes("heif")) return false;
  if (t.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.filename || "");
}

export function AttachmentChips({
  attachments,
  compact = false,
}: {
  attachments: MailAttachment[] | null | undefined;
  compact?: boolean;
}) {
  const list = useMemo(() => (Array.isArray(attachments) ? attachments.filter((a) => a && a.id) : []), [attachments]);
  const [open, setOpen] = useState<MailAttachment | null>(null);
  if (!list.length) return null;

  return (
    <>
      <div className={compact ? "flex flex-wrap gap-1.5 mt-1.5" : "flex flex-wrap gap-2"}>
        {!compact && (
          <div className="w-full flex items-center gap-1.5 mb-0.5">
            <Paperclip className="h-3.5 w-3.5" style={{ color: "var(--mc-text-faint)" }} />
            <span className="text-[12px]" style={{ color: "var(--mc-text-faint)" }}>
              {list.length} file{list.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
        {list.map((att) => {
          const href = attachmentHref(att);
          const preview = isPreviewableImage(att);
          if (preview && href) {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => setOpen(att)}
                className="flex items-center gap-2 rounded-lg overflow-hidden text-left"
                style={{ backgroundColor: "var(--mc-bg-active)", color: "var(--mc-text-secondary)" }}
                title={att.filename}
              >
                <img src={href} alt={att.filename} className="h-14 w-14 object-cover flex-shrink-0" />
                <span className="pr-2.5 py-1 min-w-0">
                  <span className="block text-[12px] truncate max-w-[140px]">{att.filename}</span>
                  <span className="block text-[10px]" style={{ color: "var(--mc-text-faint)" }}>
                    {formatBytes(att.size_bytes)}
                  </span>
                </span>
              </button>
            );
          }
          return (
            <a
              key={att.id}
              href={href || undefined}
              target="_blank"
              rel="noopener noreferrer"
              download={att.filename}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px]"
              style={{ backgroundColor: "var(--mc-bg-active)", color: "var(--mc-text-secondary)" }}
            >
              <Download className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--mc-text-faint)" }} />
              <span className="truncate max-w-[150px]">{att.filename}</span>
              <span className="text-[10px]" style={{ color: "var(--mc-text-faint)" }}>
                {formatBytes(att.size_bytes)}
              </span>
              <ExternalLink className="h-3 w-3 flex-shrink-0" style={{ color: "var(--mc-text-faint)" }} />
            </a>
          );
        })}
      </div>
      {open && attachmentHref(open) && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4"
          style={{ backgroundColor: "var(--mc-modal-overlay)" }}
          onClick={() => setOpen(null)}
        >
          <div
            className="relative max-w-[min(92vw,960px)] max-h-[88vh] rounded-xl overflow-hidden"
            style={{ backgroundColor: "var(--mc-bg-elevated)", boxShadow: "var(--mc-shadow)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-3 py-2" style={{ borderBottom: "1px solid var(--mc-border)" }}>
              <div className="text-[13px] truncate min-w-0" style={{ color: "var(--mc-text)" }}>
                {open.filename}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <a
                  href={attachmentHref(open)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1.5 rounded-md"
                  style={{ color: "var(--mc-text-muted)" }}
                  title="Open"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
                <button
                  type="button"
                  onClick={() => setOpen(null)}
                  className="p-1.5 rounded-md"
                  style={{ color: "var(--mc-text-muted)" }}
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <img
              src={attachmentHref(open)}
              alt={open.filename}
              className="max-w-full max-h-[80vh] object-contain bg-black/80"
            />
          </div>
        </div>
      )}
    </>
  );
}
