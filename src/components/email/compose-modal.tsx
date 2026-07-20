"use client";

import React, { useState, useRef } from "react";
import { X, Send, Loader2, Paperclip, FileText, Image, File, Save } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { AddressAutocomplete, type AddressAutocompleteHandle } from "./address-autocomplete";
import { RichEditor } from "./rich-editor";
import type { EmailDomain, EmailMessage } from "./email-layout";
import { apiFetch } from "@/lib/auth";
import { useSettings } from "@/lib/settings";

interface Draft {
  id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  subject: string;
  body_html: string;
  body_text: string;
  compose_mode: string;
  updated_at: string;
}

interface ComposeModalProps {
  domains: EmailDomain[];
  selectedDomain: EmailDomain | null;
  replyTo: EmailMessage | null;
  composeMode?: "new" | "reply" | "reply-all" | "forward";
  draft?: Draft | null;
  onClose: () => void;
  onSent: () => void;
}

export function ComposeModal({
  domains,
  selectedDomain,
  replyTo,
  composeMode = "new",
  draft,
  onClose,
  onSent,
}: ComposeModalProps) {
  const { settings } = useSettings();
  // Build "from" options from all domains + addresses
  const fromOptions: { label: string; value: string; domainId: string; addressId?: string }[] = [];
  for (const domain of domains) {
    for (const addr of domain.addresses || []) {
      const email = `${addr.address}@${domain.domain}`;
      const displayName = addr.display_name || addr.address;
      fromOptions.push({
        label: `${displayName} <${email}>`,
        value: `${displayName} <${email}>`,
        domainId: domain.id,
        addressId: addr.id,
      });
    }
  }

  // Fallback: if no addresses configured, create options from domain catch-all
  if (fromOptions.length === 0) {
    for (const domain of domains) {
      fromOptions.push({
        label: `john@${domain.domain}`,
        value: `John Romano <john@${domain.domain}>`,
        domainId: domain.id,
      });
    }
  }

  // New composes honor the "Send new messages from" setting when set;
  // replies/forwards keep the existing first-option behavior.
  const preferred =
    composeMode === "new" && settings.composing.defaultAddressId
      ? fromOptions.find((o) => o.addressId === settings.composing.defaultAddressId)
      : undefined;
  const defaultFrom = preferred?.value ?? (fromOptions.length > 0 ? fromOptions[0].value : "");

  const isReply = composeMode === "reply" || composeMode === "reply-all";
  const isForward = composeMode === "forward";

  // Build initial "to" based on mode
  const buildInitialTo = () => {
    if (composeMode === "reply-all" && replyTo) {
      // Reply all: original sender + all to/cc except our own addresses
      const ourEmails = new Set(fromOptions.map((o) => o.value.match(/<(.+)>/)?.[1]?.toLowerCase()).filter(Boolean));
      const allRecipients = [
        replyTo.from_address,
        ...(replyTo.to_addresses || []),
      ].filter((addr) => !ourEmails.has(addr.toLowerCase()));
      return [...new Set(allRecipients)].join(", ");
    }
    if (isReply) return replyTo?.from_address || "";
    return "";
  };

  const buildInitialCc = () => {
    if (composeMode === "reply-all" && replyTo?.cc_addresses?.length) {
      const ourEmails = new Set(fromOptions.map((o) => o.value.match(/<(.+)>/)?.[1]?.toLowerCase()).filter(Boolean));
      return replyTo.cc_addresses.filter((addr) => !ourEmails.has(addr.toLowerCase())).join(", ");
    }
    return "";
  };

  const buildInitialSubject = () => {
    if (!replyTo) return "";
    const cleanSubject = replyTo.subject?.replace(/^(Re|Fwd|Fw):\s*/gi, "") || "";
    if (isReply) return `Re: ${cleanSubject}`;
    if (isForward) return `Fwd: ${cleanSubject}`;
    return "";
  };

  const buildInitialBody = () => {
    if (!replyTo) return "";
    const dateStr = new Date(replyTo.received_at || "").toLocaleDateString();
    const sender = replyTo.from_name || replyTo.from_address;
    const quoted = (replyTo.body_text || "").split("\n").join("\n> ");
    if (isReply) {
      return `\n\n---\nOn ${dateStr}, ${sender} wrote:\n> ${quoted}`;
    }
    if (isForward) {
      return `\n\n---------- Forwarded message ----------\nFrom: ${sender} <${replyTo.from_address}>\nDate: ${dateStr}\nSubject: ${replyTo.subject}\nTo: ${(replyTo.to_addresses || []).join(", ")}\n\n${replyTo.body_text || ""}`;
    }
    return "";
  };

  const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const buildInitialHtml = () => {
    if (!replyTo) return "";
    const dateStr = new Date(replyTo.received_at || "").toLocaleDateString();
    const sender = escHtml(replyTo.from_name || replyTo.from_address);
    // Use body_html if available, otherwise convert body_text
    const quotedContent = replyTo.body_html
      || `<p>${escHtml(replyTo.body_text || "").replace(/\n/g, "<br>")}</p>`;
    if (isReply) {
      return `<p><br></p><p>On ${dateStr}, ${sender} wrote:</p><blockquote style="border-left: 3px solid var(--mc-accent); padding-left: 12px; margin-left: 0; color: #9CA3AF;">${quotedContent}</blockquote>`;
    }
    if (isForward) {
      const toAddrs = escHtml((replyTo.to_addresses || []).join(", "));
      return `<p><br></p><p style="color: #6B7280;">---------- Forwarded message ----------<br>From: ${sender} &lt;${escHtml(replyTo.from_address)}&gt;<br>Date: ${dateStr}<br>Subject: ${escHtml(replyTo.subject || "")}<br>To: ${toAddrs}</p><div>${quotedContent}</div>`;
    }
    return "";
  };

  // ---------- Signatures ----------
  const getSignatureHtml = (addressId: string | undefined): string => {
    if (!addressId) return "";
    const sig = settings.signatures.byAddressId[addressId];
    if (!sig?.enabled || !sig.html) return "";
    // Strip a signature that's only empty paragraphs
    const textish = sig.html.replace(/<[^>]+>/g, "").trim();
    if (!textish) return "";
    return `<div data-mc-signature="1">${sig.html}</div>`;
  };

  // Full initial body for a given From value: quote/forward block from the
  // message context + that address's signature, placed per the setting.
  const composeInitialHtml = (fromValue: string): string => {
    const opt = fromOptions.find((o) => o.value === fromValue);
    const sig = getSignatureHtml(opt?.addressId);
    const base = buildInitialHtml();
    if (!sig) return base;
    if (!base) return `<p><br></p><p><br></p>${sig}`; // new message: caret on top
    if (settings.composing.signaturePlacement === "above") {
      // Right after the leading blank paragraph, before the quote
      if (base.startsWith("<p><br></p>")) {
        return `<p><br></p>${sig}${base.slice("<p><br></p>".length)}`;
      }
      return `${sig}${base}`;
    }
    return `${base}${sig}`;
  };

  const [from, setFrom] = useState(draft?.from_address || defaultFrom);
  const [to, setTo] = useState(draft ? (draft.to_addresses || []).join(", ") : buildInitialTo());
  const [cc, setCc] = useState(draft ? (draft.cc_addresses || []).join(", ") : buildInitialCc());
  const [bcc, setBcc] = useState(draft ? (draft.bcc_addresses || []).join(", ") : "");
  const [subject, setSubject] = useState(draft?.subject || buildInitialSubject());
  const [body, setBody] = useState(draft?.body_text || buildInitialBody());
  const [showCcBcc, setShowCcBcc] = useState(composeMode === "reply-all" && cc.length > 0);
  const [htmlBody, setHtmlBody] = useState(draft?.body_html || "");

  // Editor content seeds ONCE (drafts verbatim — never inject a signature);
  // later From changes swap the signature only while the body is pristine.
  const [initialEditorHtml] = useState<string>(() => draft?.body_html || composeInitialHtml(draft?.from_address || defaultFrom));
  const editorRef = useRef<Editor | null>(null);
  const baselineRef = useRef<string>("");

  React.useEffect(() => {
    if (draft) return; // drafts keep their content, whatever the From
    const ed = editorRef.current;
    if (!ed) return;
    if (baselineRef.current && ed.getHTML() !== baselineRef.current) return; // user typed
    const next = composeInitialHtml(from);
    ed.commands.setContent(next);
    baselineRef.current = ed.getHTML(); // post-normalization baseline
    // setContent doesn't reliably emit update — sync the send/draft state
    setHtmlBody(baselineRef.current);
    setBody(ed.getText());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);
  const [draftId, setDraftId] = useState<string | null>(draft?.id || null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);

  // ⌘S to save draft
  const saveDraftRef = useRef<() => void>(undefined);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<AddressAutocompleteHandle>(null);
  const ccRef = useRef<AddressAutocompleteHandle>(null);
  const bccRef = useRef<AddressAutocompleteHandle>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  const focusEditor = () => {
    const tiptap = document.querySelector(".compose-modal .tiptap") as HTMLElement | null;
    if (tiptap) {
      tiptap.focus();
      return;
    }
    editorRef.current?.commands.focus("end");
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setAttachments((prev) => [...prev, ...files]);
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Strip the data URL prefix (e.g., "data:image/png;base64,")
        resolve(result.split(",")[1] || result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileIcon = (file: File) => {
    if (file.type.startsWith("image/")) return Image;
    if (file.type.includes("pdf") || file.type.includes("document")) return FileText;
    return File;
  };

  const handleSaveDraft = async () => {
    setSavingDraft(true);
    setDraftSaved(false);
    try {
      const draftData = {
        from: from,
        to: to.split(",").map((s) => s.trim()).filter(Boolean),
        cc: cc ? cc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        bcc: bcc ? bcc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        subject,
        html: htmlBody,
        text: body,
        compose_mode: composeMode,
        reply_to_message_id: replyTo?.id || null,
      };

      if (draftId) {
        // Update existing draft
        await apiFetch("/api/email/drafts", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: draftId, ...draftData }),
        });
      } else {
        // Create new draft
        const res = await apiFetch("/api/email/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draftData),
        });
        if (res.ok) {
          const created = await res.json();
          setDraftId(created.id);
        }
      }
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 2000);
    } catch (e) {
      console.error("Failed to save draft:", e);
    }
    setSavingDraft(false);
  };

  // Wire up ⌘S shortcut
  saveDraftRef.current = handleSaveDraft;
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveDraftRef.current?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Auto-save draft every 30 seconds if content has changed
  const lastAutoSaveContent = useRef("");
  React.useEffect(() => {
    const interval = setInterval(() => {
      const currentContent = `${to}|${subject}|${htmlBody}`;
      if (currentContent !== lastAutoSaveContent.current && (to || subject || htmlBody)) {
        lastAutoSaveContent.current = currentContent;
        saveDraftRef.current?.();
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [to, subject, htmlBody]);

  // Delete draft after successful send
  const deleteDraftIfExists = async () => {
    if (draftId) {
      await apiFetch(`/api/email/drafts?id=${draftId}`, { method: "DELETE" }).catch(() => {});
    }
  };

  const handleSend = async () => {
    if (!from || !to || !subject) {
      setError("From, To, and Subject are required");
      return;
    }

    setSending(true);
    setError("");

    const selectedFrom = fromOptions.find((f) => f.value === from);

    try {
      // Convert attachments to base64
      const attachmentPayloads = await Promise.all(
        attachments.map(async (file) => ({
          filename: file.name,
          content: await fileToBase64(file),
          content_type: file.type || "application/octet-stream",
        }))
      );

      const res = await apiFetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: to.split(",").map((s) => s.trim()).filter(Boolean),
          cc: cc ? cc.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          bcc: bcc ? bcc.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          subject,
          text: body,
          html: htmlBody || `<div style="white-space: pre-wrap; font-family: sans-serif;">${body.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</div>`,
          in_reply_to: isReply ? replyTo?.resend_email_id : undefined,
          domain_id: selectedFrom?.domainId,
          address_id: selectedFrom?.addressId,
          attachments: attachmentPayloads.length > 0 ? attachmentPayloads : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send");
      }

      await deleteDraftIfExists();
      onSent();
    } catch (e: any) {
      setError(e.message || "Failed to send email");
    }
    setSending(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end md:items-center justify-center">
      <div className="compose-modal w-full max-w-[640px] bg-card rounded-t-2xl md:rounded-2xl border border-border shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-[15px] font-semibold text-foreground">
            {composeMode === "reply" ? "Reply" : composeMode === "reply-all" ? "Reply All" : composeMode === "forward" ? "Forward" : "New Email"}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto">
          {/* From */}
          <div className="flex items-center border-b border-border/60 px-4 py-2">
            <span className="text-[12px] text-muted-foreground w-12">From</span>
            {fromOptions.length > 1 ? (
              <select
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="flex-1 bg-transparent text-[13px] text-foreground focus:outline-none appearance-none cursor-pointer"
              >
                {fromOptions.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-card">
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[13px] text-foreground">{from || "No addresses configured"}</span>
            )}
          </div>

          {/* To */}
          <div className="flex items-center border-b border-border/60">
            <span className="text-[12px] text-muted-foreground w-12 pl-4">To</span>
            <div className="flex-1">
              <AddressAutocomplete
                ref={toRef}
                value={to}
                onChange={setTo}
                placeholder="recipient@example.com"
                autoFocus={composeMode === "forward" || composeMode === "new"}
                onTabNext={() => {
                  if (showCcBcc) ccRef.current?.focus();
                  else subjectRef.current?.focus();
                }}
              />
            </div>
            {!showCcBcc && (
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowCcBcc(true)}
                className="text-[11px] text-muted-foreground hover:text-mc-teal mr-3"
              >
                Cc/Bcc
              </button>
            )}
          </div>

          {/* Cc / Bcc */}
          {showCcBcc && (
            <>
              <div className="flex items-center border-b border-border/60">
                <span className="text-[12px] text-muted-foreground w-12 pl-4">Cc</span>
                <div className="flex-1">
                  <AddressAutocomplete
                    ref={ccRef}
                    value={cc}
                    onChange={setCc}
                    placeholder="Cc recipients"
                    onTabNext={() => bccRef.current?.focus()}
                    onTabPrev={() => toRef.current?.focus()}
                  />
                </div>
              </div>
              <div className="flex items-center border-b border-border/60">
                <span className="text-[12px] text-muted-foreground w-12 pl-4">Bcc</span>
                <div className="flex-1">
                  <AddressAutocomplete
                    ref={bccRef}
                    value={bcc}
                    onChange={setBcc}
                    placeholder="Bcc recipients"
                    onTabNext={() => subjectRef.current?.focus()}
                    onTabPrev={() => ccRef.current?.focus()}
                  />
                </div>
              </div>
            </>
          )}

          {/* Subject */}
          <div className="flex items-center border-b border-border/60 px-4 py-2">
            <span className="text-[12px] text-muted-foreground w-12">Subj</span>
            <input
              ref={subjectRef}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="flex-1 bg-transparent text-[13px] text-foreground placeholder-[#4B5563] focus:outline-none"
              onKeyDown={(e) => {
                // Tab from subject → jump straight to editor body (skip toolbar)
                if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  focusEditor();
                }
                if (e.key === "Tab" && e.shiftKey) {
                  e.preventDefault();
                  if (showCcBcc) bccRef.current?.focus();
                  else toRef.current?.focus();
                }
              }}
            />
          </div>

          {/* Rich Text Body */}
          <RichEditor
            initialContent={initialEditorHtml}
            placeholder="Write your message..."
            onHtmlChange={(html) => setHtmlBody(html)}
            onTextChange={(text) => setBody(text)}
            onEditorReady={(ed) => {
              editorRef.current = ed;
              if (!baselineRef.current) baselineRef.current = ed.getHTML();
              // Seed send/draft state with the signature-bearing initial body
              if (!draft) {
                setHtmlBody(ed.getHTML());
                setBody(ed.getText());
              }
            }}
          />

          {/* Attachments */}
          {attachments.length > 0 && (
            <div className="px-4 pb-3 border-t border-border/60 pt-3">
              <div className="flex items-center gap-2 mb-2">
                <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">
                  {attachments.length} attachment{attachments.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {attachments.map((file, i) => {
                  const FileIcon = getFileIcon(file);
                  return (
                    <div
                      key={`${file.name}-${i}`}
                      className="flex items-center gap-2 bg-muted/40 rounded-lg px-3 py-1.5 text-[12px] text-secondary-foreground group"
                    >
                      <FileIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="truncate max-w-[120px]">{file.name}</span>
                      <span className="text-[10px] text-muted-foreground">{formatFileSize(file.size)}</span>
                      <button
                        onClick={() => removeAttachment(i)}
                        className="p-0.5 text-muted-foreground hover:text-mc-red transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 text-[12px] text-mc-red bg-[rgba(255, 59, 48, 0.1)]">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                // Delete draft on discard if it was just created
                if (draftId) {
                  apiFetch(`/api/email/drafts?id=${draftId}`, { method: "DELETE" }).catch(() => {});
                }
                onClose();
              }}
              className="text-[13px] text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg hover:bg-muted/40"
            >
              Discard
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2 text-muted-foreground hover:text-mc-teal rounded-lg hover:bg-mc-teal-glow transition-colors"
              title="Attach files"
            >
              <Paperclip className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {/* Save Draft */}
            <button
              onClick={handleSaveDraft}
              disabled={savingDraft}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] transition-all ${
                draftSaved
                  ? "text-mc-green bg-[rgba(52, 199, 89, 0.12)]"
                  : "text-muted-foreground hover:text-foreground bg-muted/30 hover:bg-muted/50"
              }`}
              title="Save as draft (⌘S)"
            >
              {savingDraft ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : draftSaved ? (
                <Save className="h-3.5 w-3.5" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {draftSaved ? "Saved" : "Draft"}
            </button>

            {/* Send */}
            <button
              onClick={handleSend}
              disabled={sending || !from}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-mc-teal text-white text-[13px] font-medium hover:brightness-110 disabled:opacity-50 transition-all"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
