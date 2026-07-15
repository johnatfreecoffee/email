"use client";

import {
  ArrowLeft,
  Reply,
  ReplyAll,
  Forward,
  Star,
  Trash2,
  Archive,
  Paperclip,
  Download,
  ExternalLink,
  Copy,
  Check,
  MailOpen,
  Mail,
  AlertOctagon,
} from "lucide-react";
import { useState, useCallback } from "react";
import type { EmailMessage } from "./email-layout";

interface MessageReaderProps {
  message: EmailMessage | null;
  onTrash: (id: string) => void;
  onArchive: (id: string) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onToggleSpam?: (id: string, isSpamNow: boolean) => void;
  onReply: (msg: EmailMessage) => void;
  onReplyAll: (msg: EmailMessage) => void;
  onForward: (msg: EmailMessage) => void;
  onToggleRead: (id: string, isRead: boolean) => void;
  onBack: () => void;
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CopyableEmail({ email, name }: { email: string; name?: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  return (
    <span className="inline-flex items-center gap-1 group/copy">
      {name && name !== email && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            copyToClipboard(name);
          }}
          className="hover:text-[#06B6D4] transition-colors cursor-pointer"
          title={`Copy "${name}"`}
        >
          {name}
          {copied === name && <Check className="inline h-3 w-3 text-[#34D399] ml-0.5" />}
        </button>
      )}
      {name && name !== email && <span style={{ color: "var(--mc-text-faint)" }}>&lt;</span>}
      <button
        onClick={(e) => {
          e.stopPropagation();
          copyToClipboard(email);
        }}
        className="hover:text-[#06B6D4] transition-colors cursor-pointer"
        title={`Copy ${email}`}
      >
        {email}
        {copied === email && <Check className="inline h-3 w-3 text-[#34D399] ml-0.5" />}
      </button>
      {name && name !== email && <span style={{ color: "var(--mc-text-faint)" }}>&gt;</span>}
      <Copy className="h-3 w-3 opacity-0 group-hover/copy:opacity-100 transition-opacity cursor-pointer hover:text-[#06B6D4]"
        style={{ color: "var(--mc-text-faint)" }}
        onClick={(e) => {
          e.stopPropagation();
          copyToClipboard(name && name !== email ? `${name} <${email}>` : email);
        }}
      />
    </span>
  );
}

function CopyableAddress({ address }: { address: string }) {
  const match = address.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return <CopyableEmail name={match[1].trim()} email={match[2].trim()} />;
  }
  return <CopyableEmail email={address} />;
}

// Toolbar action button component
function ToolbarButton({
  onClick,
  icon: Icon,
  title,
  hoverColor = "#06B6D4",
  hoverBg = "rgba(6,182,212,0.08)",
  active = false,
  activeColor,
}: {
  onClick: () => void;
  icon: typeof Reply;
  title: string;
  hoverColor?: string;
  hoverBg?: string;
  active?: boolean;
  activeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="p-2 rounded-lg transition-all"
      style={{
        color: active && activeColor ? activeColor : "var(--mc-text-faint)",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.color = hoverColor;
        (e.currentTarget as HTMLElement).style.backgroundColor = hoverBg;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.color = active && activeColor ? activeColor : "var(--mc-text-faint)";
        (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
      }}
      title={title}
    >
      <Icon className={`h-4 w-4 ${active && activeColor ? "fill-current" : ""}`} />
    </button>
  );
}

export function MessageReader({
  message,
  onTrash,
  onArchive,
  onToggleStar,
  onToggleSpam,
  onReply,
  onReplyAll,
  onForward,
  onToggleRead,
  onBack,
}: MessageReaderProps) {
  if (!message) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--mc-text-faint)" }}>
        <div className="text-center">
          <Mail className="h-8 w-8 mx-auto mb-3 opacity-30" />
          <p className="text-[14px]">Select an email to read</p>
          <p className="text-[12px] mt-1" style={{ color: "var(--mc-text-faint)" }}>
            Choose from the list on the left
          </p>
        </div>
      </div>
    );
  }

  const toList = Array.isArray(message.to_addresses) ? message.to_addresses : [String(message.to_addresses)];
  const ccList = message.cc_addresses && message.cc_addresses.length > 0 ? message.cc_addresses : null;
  const hasMultipleRecipients = toList.length > 1 || (ccList && ccList.length > 0);

  return (
    <div className="flex flex-col h-full">
      {/* Top actions bar — grouped with dividers */}
      <div
        className="flex items-center gap-0.5 px-3 py-2"
        style={{ borderBottom: "1px solid var(--mc-border)" }}
      >
        {/* Mobile back button — large touch target */}
        <button
          onClick={onBack}
          className="md:hidden p-2.5 -ml-1 rounded-lg transition-all active:scale-95"
          style={{ color: "var(--mc-text-muted)" }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-bg-hover)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
          }}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>

        <div className="flex-1" />

        {/* Reply group */}
        <ToolbarButton onClick={() => onReply(message)} icon={Reply} title="Reply (r)" />
        <ToolbarButton onClick={() => onReplyAll(message)} icon={ReplyAll} title="Reply All (Shift+R)" />
        <ToolbarButton onClick={() => onForward(message)} icon={Forward} title="Forward (f)" />

        {/* Divider */}
        <div className="w-px h-5 mx-1" style={{ backgroundColor: "var(--mc-border)" }} />

        {/* Status group */}
        <ToolbarButton
          onClick={() => onToggleRead(message.id, message.is_read)}
          icon={message.is_read ? MailOpen : Mail}
          title={message.is_read ? "Mark as unread (u)" : "Mark as read (u)"}
        />
        <ToolbarButton
          onClick={() => onToggleStar(message.id, message.is_starred)}
          icon={Star}
          title={message.is_starred ? "Unstar (s)" : "Star (s)"}
          hoverColor="#EAB308"
          hoverBg="rgba(234,179,8,0.08)"
          active={message.is_starred}
          activeColor="#EAB308"
        />

        {/* Divider */}
        <div className="w-px h-5 mx-1" style={{ backgroundColor: "var(--mc-border)" }} />

        {/* Destructive group */}
        <ToolbarButton
          onClick={() => onArchive(message.id)}
          icon={Archive}
          title="Archive (a)"
          hoverColor="#FBBF24"
          hoverBg="rgba(251,191,36,0.08)"
        />
        {onToggleSpam && (
          message.folder === "spam" || message.is_spam ? (
            <ToolbarButton
              onClick={() => onToggleSpam(message.id, true)}
              icon={Mail}
              title="Not spam — restore to inbox and trust the sender"
              hoverColor="#34D399"
              hoverBg="rgba(52,211,153,0.08)"
            />
          ) : (
            <ToolbarButton
              onClick={() => onToggleSpam(message.id, false)}
              icon={AlertOctagon}
              title="Mark as spam"
              hoverColor="#F87171"
              hoverBg="rgba(248,113,113,0.08)"
            />
          )
        )}
        <ToolbarButton
          onClick={() => onTrash(message.id)}
          icon={Trash2}
          title="Trash (Delete)"
          hoverColor="#F87171"
          hoverBg="rgba(248,113,113,0.08)"
        />
      </div>

      {/* Message header */}
      <div className="px-6 py-4" style={{ borderBottom: "1px solid var(--mc-border)" }}>
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div className="h-10 w-10 rounded-full bg-gradient-to-br from-[#06B6D4] to-[#34D399] flex items-center justify-center text-white text-[15px] font-bold flex-shrink-0 mt-0.5">
            {(message.from_name || message.from_address)[0]?.toUpperCase() || "?"}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>
                <CopyableEmail
                  name={message.from_name || undefined}
                  email={message.from_address}
                />
              </span>
              {message.is_catch_all && (
                <span className="text-[10px] font-bold bg-[rgba(251,191,36,0.15)] text-[#FBBF24] px-1.5 py-0.5 rounded">
                  CATCH-ALL
                </span>
              )}
              {message.direction === "outbound" && (
                <span className="text-[10px] font-bold bg-[rgba(6,182,212,0.15)] text-[#06B6D4] px-1.5 py-0.5 rounded">
                  SENT
                </span>
              )}
            </div>

            {/* To line */}
            <div className="text-[12px] mt-1 flex items-start gap-1" style={{ color: "var(--mc-text-muted)" }}>
              <span className="flex-shrink-0">To:</span>
              <span className="flex flex-wrap gap-x-1.5">
                {toList.map((addr, i) => (
                  <span key={i}>
                    <CopyableAddress address={addr} />
                    {i < toList.length - 1 && <span style={{ color: "var(--mc-text-faint)" }}>,</span>}
                  </span>
                ))}
              </span>
            </div>

            {/* CC line */}
            {ccList && (
              <div className="text-[12px] mt-0.5 flex items-start gap-1" style={{ color: "var(--mc-text-muted)" }}>
                <span className="flex-shrink-0">Cc:</span>
                <span className="flex flex-wrap gap-x-1.5">
                  {ccList.map((addr, i) => (
                    <span key={i}>
                      <CopyableAddress address={addr} />
                      {i < ccList.length - 1 && <span style={{ color: "var(--mc-text-faint)" }}>,</span>}
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>

          <span className="text-[11px] flex-shrink-0 mt-1" style={{ color: "var(--mc-text-faint)" }}>
            {formatFullDate(message.received_at)}
          </span>
        </div>

        <h1 className="text-[18px] font-semibold mt-4" style={{ color: "var(--mc-text)" }}>
          {message.subject || "(no subject)"}
        </h1>
      </div>

      {/* Attachments bar */}
      {message.attachments && message.attachments.length > 0 && (
        <div className="px-6 py-3" style={{ borderBottom: "1px solid var(--mc-border)", backgroundColor: "var(--mc-bg-hover)" }}>
          <div className="flex items-center gap-2 mb-2">
            <Paperclip className="h-3.5 w-3.5" style={{ color: "var(--mc-text-faint)" }} />
            <span className="text-[12px]" style={{ color: "var(--mc-text-faint)" }}>
              {message.attachments.length} attachment{message.attachments.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {message.attachments.map((att) => {
              const supabaseUrl = typeof window !== "undefined" 
                ? (document.querySelector('meta[name="supabase-url"]')?.getAttribute("content") || "https://YOUR_PROJECT_REF.supabase.co")
                : "https://YOUR_PROJECT_REF.supabase.co";
              const downloadUrl = `${supabaseUrl}/storage/v1/object/public/email-attachments/${att.storage_path}`;
              const isImage = att.content_type?.startsWith("image/");
              return (
                <a
                  key={att.id}
                  href={downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={att.filename}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] transition-colors cursor-pointer group"
                  style={{
                    backgroundColor: "var(--mc-bg-active)",
                    color: "var(--mc-text-secondary)",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "#06B6D4";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "var(--mc-text-secondary)";
                  }}
                >
                  {isImage ? (
                    <img
                      src={downloadUrl}
                      alt={att.filename}
                      className="h-8 w-8 rounded object-cover flex-shrink-0"
                    />
                  ) : (
                    <Download className="h-3.5 w-3.5" style={{ color: "var(--mc-text-faint)" }} />
                  )}
                  <span className="truncate max-w-[150px]">{att.filename}</span>
                  <span className="text-[10px]" style={{ color: "var(--mc-text-faint)" }}>{formatSize(att.size_bytes)}</span>
                  <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100" style={{ color: "var(--mc-text-faint)" }} />
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Message body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {message.body_html ? (
          <iframe
            srcDoc={`
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <base target="_blank">
                <style>
                  body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 14px;
                    line-height: 1.6;
                    color: #1a1a1a !important;
                    background: #ffffff !important;
                    margin: 0;
                    padding: 8px;
                    word-wrap: break-word;
                    overflow-wrap: break-word;
                  }
                  /* Force readable text on any background */
                  * { color: inherit; }
                  a { color: #0284c7 !important; cursor: pointer; }
                  img { max-width: 100%; height: auto; }
                  table { max-width: 100% !important; }
                  blockquote {
                    border-left: 3px solid #d1d5db;
                    margin: 0.5em 0;
                    padding: 0.25em 1em;
                    color: #6b7280 !important;
                  }
                  /* Override dark backgrounds from email HTML */
                  div, td, th, p, span, li {
                    background-color: transparent !important;
                  }
                  body > * {
                    max-width: 100% !important;
                  }
                </style>
              </head>
              <body>${message.body_html}</body>
              </html>
            `}
            // allow-same-origin: parent can rewrite links + size iframe
            // allow-popups + escape: target=_blank / window.open leave the app
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            className="w-full border-none min-h-[300px]"
            style={{ background: "#ffffff", borderRadius: "8px" }}
            onLoad={(e) => {
              const iframe = e.target as HTMLIFrameElement;
              const doc = iframe.contentDocument;
              if (!doc) return;

              // Force every link out of the reader into a new browser tab.
              const openExternal = (href: string) => {
                if (!href || href.startsWith("javascript:") || href.startsWith("data:")) return;
                window.open(href, "_blank", "noopener,noreferrer");
              };

              doc.querySelectorAll("a[href]").forEach((node) => {
                const a = node as HTMLAnchorElement;
                a.setAttribute("target", "_blank");
                a.setAttribute("rel", "noopener noreferrer");
                a.addEventListener(
                  "click",
                  (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    openExternal(a.href);
                  },
                  true
                );
              });

              // Catch-all for dynamically-styled anchors / area maps
              doc.addEventListener(
                "click",
                (ev) => {
                  const el = (ev.target as Element | null)?.closest?.("a[href]");
                  if (!el) return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  openExternal((el as HTMLAnchorElement).href);
                },
                true
              );

              iframe.style.height = (doc.body?.scrollHeight || 300) + 20 + "px";
            }}
          />
        ) : (
          <pre className="text-[13px] whitespace-pre-wrap font-sans leading-relaxed" style={{ color: "var(--mc-text-secondary)" }}>
            {message.body_text || "No content"}
          </pre>
        )}
      </div>

      {/* Bottom reply bar */}
      <div className="px-6 py-3 flex items-center gap-2" style={{ borderTop: "1px solid var(--mc-border)" }}>
        <button
          onClick={() => onReply(message)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] transition-all"
          style={{
            backgroundColor: "var(--mc-bg-hover)",
            color: "var(--mc-text-secondary)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(6,182,212,0.1)";
            (e.currentTarget as HTMLElement).style.color = "#06B6D4";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-bg-hover)";
            (e.currentTarget as HTMLElement).style.color = "var(--mc-text-secondary)";
          }}
        >
          <Reply className="h-3.5 w-3.5" />
          Reply
        </button>
        {hasMultipleRecipients && (
          <button
            onClick={() => onReplyAll(message)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] transition-all"
            style={{
              backgroundColor: "var(--mc-bg-hover)",
              color: "var(--mc-text-secondary)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(6,182,212,0.1)";
              (e.currentTarget as HTMLElement).style.color = "#06B6D4";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-bg-hover)";
              (e.currentTarget as HTMLElement).style.color = "var(--mc-text-secondary)";
            }}
          >
            <ReplyAll className="h-3.5 w-3.5" />
            Reply All
          </button>
        )}
        <button
          onClick={() => onForward(message)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] transition-all"
          style={{
            backgroundColor: "var(--mc-bg-hover)",
            color: "var(--mc-text-secondary)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(6,182,212,0.1)";
            (e.currentTarget as HTMLElement).style.color = "#06B6D4";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mc-bg-hover)";
            (e.currentTarget as HTMLElement).style.color = "var(--mc-text-secondary)";
          }}
        >
          <Forward className="h-3.5 w-3.5" />
          Forward
        </button>
      </div>
    </div>
  );
}
