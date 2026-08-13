"use client";

// Per-domain account management — extracted from the old DomainSettingsPanel
// overlay so it can live inside Settings → Accounts. State seeds from props:
// render with key={domain.id}.

import { useState } from "react";
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import type { EmailDomain, EmailAddress } from "./email-layout";
import { apiFetch } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import { SettingsSection, SettingsRow, SegmentedControl, MCSwitch } from "./settings/controls";

type Segment = "info" | "addresses" | "catchall" | "danger";

interface DomainAccountDetailProps {
  domain: EmailDomain;
  onRefresh: () => void;
  onDeleted: () => void;
  initialSegment?: Segment;
}

interface DnsRecord {
  record?: string;
  name?: string;
  type?: string;
  value?: string;
  status?: string;
}

const inputCls = "px-2.5 py-1.5 rounded-md text-[13px] outline-none";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--mc-bg)",
  color: "var(--mc-text)",
  border: "1px solid var(--mc-border)",
};

export function DomainAccountDetail({ domain, onRefresh, onDeleted, initialSegment = "info" }: DomainAccountDetailProps) {
  const [segment, setSegment] = useState<Segment>(initialSegment);
  const { settings, updateSetting } = useSettings();
  const domainThreadOn =
    domain.id in (settings.viewing.threadDomainOverrides || {})
      ? !!settings.viewing.threadDomainOverrides[domain.id]
      : settings.viewing.threadConversations !== false;

  // Addresses
  const [localAddresses, setLocalAddresses] = useState<EmailAddress[]>(domain.addresses || []);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLocal, setNewLocal] = useState("");
  const [newDisplay, setNewDisplay] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id: string; local: string; display: string } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; email: string } | null>(null);

  // Catch-all
  const [catchAllEnabled, setCatchAllEnabled] = useState(domain.catch_all_enabled);
  const [catchAllPrefix, setCatchAllPrefix] = useState(domain.catch_all_subject_prefix || "[Catch-All]");
  const [catchAllDest, setCatchAllDest] = useState<string | null>(domain.catchall_destination_address_id || null);
  const [catchAllSaving, setCatchAllSaving] = useState(false);
  const [catchAllSavedAt, setCatchAllSavedAt] = useState(0);

  // Danger
  const [deletingDomain, setDeletingDomain] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  // Info
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);

  const addAddress = async () => {
    const local = newLocal.toLowerCase().trim().replace(/@.*$/, "");
    if (!local) return;
    setAdding(true);
    try {
      const res = await apiFetch("/api/email/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain_id: domain.id, address: local, display_name: newDisplay.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to add address");
        return;
      }
      setLocalAddresses((prev) => [...prev, data]);
      setNewLocal("");
      setNewDisplay("");
      setShowAddForm(false);
      onRefresh();
    } finally {
      setAdding(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditError("");
    setEditSaving(true);
    try {
      const updates: Record<string, string> = {};
      const orig = localAddresses.find((a) => a.id === editing.id);
      if (orig && editing.local !== orig.address) updates.address = editing.local;
      if (orig && editing.display !== (orig.display_name || "")) updates.display_name = editing.display;
      if (Object.keys(updates).length === 0) {
        setEditing(null);
        return;
      }
      const res = await apiFetch(`/api/email/addresses?id=${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (!res.ok) {
        setEditError(data.error || "Failed to save");
        return;
      }
      setLocalAddresses((prev) =>
        prev.map((a) => (a.id === editing.id ? { ...a, address: data.address, display_name: data.display_name } : a))
      );
      setEditing(null);
      onRefresh();
    } finally {
      setEditSaving(false);
    }
  };

  const deleteAddress = async (id: string) => {
    const res = await apiFetch(`/api/email/addresses?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || "Failed to delete address");
      return;
    }
    setLocalAddresses((prev) => prev.filter((a) => a.id !== id));
    setConfirmDelete(null);
    onRefresh();
  };

  const saveCatchAll = async (next: { enabled?: boolean; prefix?: string; destination?: string | null }) => {
    setCatchAllSaving(true);
    try {
      const body: Record<string, unknown> = { domain_id: domain.id };
      if (next.enabled !== undefined) body.catch_all_enabled = next.enabled;
      if (next.prefix !== undefined) body.catch_all_subject_prefix = next.prefix;
      if (next.destination !== undefined) body.catchall_destination_address_id = next.destination;
      const res = await apiFetch("/api/email/domains-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (next.enabled !== undefined) setCatchAllEnabled(next.enabled);
        if (next.prefix !== undefined) setCatchAllPrefix(next.prefix);
        if (next.destination !== undefined) setCatchAllDest(next.destination);
        setCatchAllSavedAt(Date.now());
        onRefresh();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to save catch-all settings");
      }
    } finally {
      setCatchAllSaving(false);
    }
  };

  const deleteDomain = async () => {
    setDeletingDomain(true);
    try {
      const res = await apiFetch(`/api/email/domains?id=${domain.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to delete domain");
        return;
      }
      onDeleted();
      onRefresh();
    } finally {
      setDeletingDomain(false);
    }
  };

  const reverify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await apiFetch("/api/email/domains-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain_id: domain.id, resend_domain_id: domain.resend_domain_id }),
      });
      const data = await res.json().catch(() => ({}));
      setVerifyResult(res.ok ? `Status: ${data.status || "checked"}` : data.error || "Verification failed");
      onRefresh();
    } catch (e) {
      setVerifyResult(`Error: ${(e as Error).message}`);
    }
    setVerifying(false);
  };

  const dnsRecords: DnsRecord[] = Array.isArray((domain as unknown as { dns_records?: DnsRecord[] }).dns_records)
    ? ((domain as unknown as { dns_records: DnsRecord[] }).dns_records)
    : [];

  const status = (domain.status || "unknown").toLowerCase();
  const statusColor = ["active", "verified", "dns_configured"].includes(status)
    ? "var(--mc-success)"
    : ["pending", "not_started"].includes(status)
    ? "var(--mc-warning)"
    : "var(--mc-danger)";

  return (
    <div>
      <div className="mb-3">
        <SegmentedControl<Segment>
          value={segment}
          onChange={setSegment}
          options={[
            { value: "info", label: "Account Information" },
            { value: "addresses", label: "Addresses" },
            { value: "catchall", label: "Catch-All" },
            { value: "danger", label: "Danger" },
          ]}
        />
      </div>

      {segment === "info" && (
        <div>
          <SettingsSection title="Account">
            <SettingsRow
              label="Status"
              control={
                <span className="flex items-center gap-1.5 text-[12px]" style={{ color: statusColor }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusColor }} />
                  {domain.status || "unknown"}
                </span>
              }
            />
            <SettingsRow
              label="Domain"
              control={<span className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>{domain.domain}</span>}
            />
            <SettingsRow
              label="Added"
              control={
                <span className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
                  {domain.created_at ? new Date(domain.created_at).toLocaleDateString() : "—"}
                </span>
              }
            />
            <SettingsRow
              label="Organize by conversation"
              description="Group replies into threads for this account (like Apple Mail)"
              control={
                <MCSwitch
                  checked={domainThreadOn}
                  onCheckedChange={(next) => {
                    updateSetting("viewing", {
                      threadDomainOverrides: {
                        ...(settings.viewing.threadDomainOverrides || {}),
                        [domain.id]: next,
                      },
                    });
                  }}
                />
              }
            />
            <SettingsRow
              label="Re-check DNS verification"
              description={verifyResult ?? undefined}
              last
              control={
                <button
                  onClick={reverify}
                  disabled={verifying}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium disabled:opacity-40"
                  style={{ backgroundColor: "var(--mc-bg-elevated)", color: "var(--mc-text)", border: "1px solid var(--mc-border)" }}
                >
                  <RefreshCw className={`h-3 w-3 ${verifying ? "animate-spin" : ""}`} />
                  Verify
                </button>
              }
            />
          </SettingsSection>

          {dnsRecords.length > 0 && (
            <SettingsSection title="DNS records" footnote="Managed automatically in Cloudflare when the domain was added.">
              <div className="max-h-[180px] overflow-y-auto">
                {dnsRecords.map((r, i) => (
                  <div
                    key={i}
                    className="px-3 py-2 text-[11px] font-mono"
                    style={{
                      borderBottom: i === dnsRecords.length - 1 ? "none" : "1px solid var(--mc-border-subtle)",
                      color: "var(--mc-text-secondary)",
                    }}
                  >
                    <span className="font-semibold" style={{ color: "var(--mc-text)" }}>{r.type || r.record}</span>{" "}
                    <span style={{ color: "var(--mc-text-muted)" }}>{r.name}</span>
                    <div className="truncate" style={{ color: "var(--mc-text-faint)" }}>{r.value}</div>
                  </div>
                ))}
              </div>
            </SettingsSection>
          )}
        </div>
      )}

      {segment === "addresses" && (
        <div>
          {!showAddForm ? (
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-white mb-3"
              style={{ backgroundColor: "var(--mc-accent)" }}
            >
              <Plus className="h-3.5 w-3.5" /> Add address
            </button>
          ) : (
            <div className="p-3 rounded-[10px] mb-3" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  placeholder="local-part"
                  value={newLocal}
                  onChange={(e) => setNewLocal(e.target.value)}
                  className={inputCls}
                  style={inputStyle}
                />
                <span className="text-[13px]" style={{ color: "var(--mc-text-faint)" }}>@{domain.domain}</span>
              </div>
              <input
                type="text"
                placeholder="Display name (optional)"
                value={newDisplay}
                onChange={(e) => setNewDisplay(e.target.value)}
                className={`${inputCls} w-full mb-2`}
                style={inputStyle}
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { setShowAddForm(false); setNewLocal(""); setNewDisplay(""); }}
                  className="px-3 py-1.5 rounded-md text-[12px]"
                  style={{ color: "var(--mc-text-muted)", border: "1px solid var(--mc-border)" }}
                >
                  Cancel
                </button>
                <button
                  onClick={addAddress}
                  disabled={adding || !newLocal.trim()}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white disabled:opacity-40"
                  style={{ backgroundColor: "var(--mc-accent)" }}
                >
                  {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
                </button>
              </div>
            </div>
          )}

          {localAddresses.length === 0 ? (
            <div className="text-[13px]" style={{ color: "var(--mc-text-faint)" }}>No addresses yet.</div>
          ) : (
            <div className="rounded-[10px] overflow-hidden" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
              {localAddresses.filter((a) => !/^[ae]\./i.test(a.address)).map((addr, i, arr) => (
                <div
                  key={addr.id}
                  className="flex items-center justify-between px-3 py-2"
                  style={{ borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--mc-border-subtle)" }}
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate" style={{ color: "var(--mc-text)" }}>
                      {addr.address}@{domain.domain}
                    </div>
                    {addr.display_name && (
                      <div className="text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>{addr.display_name}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => setEditing({ id: addr.id, local: addr.address, display: addr.display_name || "" })}
                      className="p-1.5 rounded-md"
                      style={{ color: "var(--mc-text-muted)" }}
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setConfirmDelete({ id: addr.id, email: `${addr.address}@${domain.domain}` })}
                      className="p-1.5 rounded-md"
                      style={{ color: "var(--mc-danger)" }}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {localAddresses.some((a) => /^[ae]\./i.test(a.address)) && (
            <div className="mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "var(--mc-text-faint)" }}>
                Agent mailboxes
              </div>
              <div className="text-[11px] mb-2" style={{ color: "var(--mc-text-muted)" }}>
                Hidden from inbox, catch-all, and All Mail. Live under Agents in the sidebar.
              </div>
              <div className="rounded-[10px] overflow-hidden" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
                {localAddresses.filter((a) => /^[ae]\./i.test(a.address)).map((addr, i, arr) => (
                  <div
                    key={addr.id}
                    className="flex items-center justify-between px-3 py-2"
                    style={{ borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--mc-border-subtle)" }}
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate" style={{ color: "var(--mc-text)" }}>
                        {addr.address}@{domain.domain}
                      </div>
                      {addr.display_name && (
                        <div className="text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>{addr.display_name}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => setEditing({ id: addr.id, local: addr.address, display: addr.display_name || "" })}
                        className="p-1.5 rounded-md"
                        style={{ color: "var(--mc-text-muted)" }}
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDelete({ id: addr.id, email: `${addr.address}@${domain.domain}` })}
                        className="p-1.5 rounded-md"
                        style={{ color: "var(--mc-danger)" }}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {segment === "catchall" && (
        <div>
          <SettingsSection
            title="Catch-all"
            footnote={`Mail to any unknown address on @${domain.domain} is captured with a subject prefix so it stands out.`}
          >
            <SettingsRow
              label="Catch all unknown addresses"
              control={
                <MCSwitch
                  checked={catchAllEnabled}
                  onCheckedChange={(next) => saveCatchAll({ enabled: next })}
                  disabled={catchAllSaving}
                />
              }
              last={!catchAllEnabled}
            />
            {catchAllEnabled && (
              <>
                <SettingsRow
                  label="Subject prefix"
                  control={
                    <input
                      type="text"
                      value={catchAllPrefix}
                      onChange={(e) => setCatchAllPrefix(e.target.value)}
                      onBlur={() => saveCatchAll({ prefix: catchAllPrefix })}
                      className={inputCls}
                      style={{ ...inputStyle, width: 140 }}
                      placeholder="[Catch-All]"
                    />
                  }
                />
                <SettingsRow
                  label="Route catch-all mail to"
                  description="Unmatched mail is attributed to this address's inbox"
                  last
                  control={
                    <select
                      value={catchAllDest || ""}
                      onChange={(e) => saveCatchAll({ destination: e.target.value || null })}
                      disabled={catchAllSaving}
                      className={`${inputCls} cursor-pointer`}
                      style={inputStyle}
                    >
                      <option value="">— Unattributed —</option>
                      {localAddresses
                        .filter((a) => a.is_active && !/^[ae]\./i.test(a.address))
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.address}@{domain.domain}
                          </option>
                        ))}
                    </select>
                  }
                />
              </>
            )}
          </SettingsSection>
          {Date.now() - catchAllSavedAt < 2000 && (
            <div className="flex items-center gap-1 text-[12px]" style={{ color: "var(--mc-success)" }}>
              <Check className="h-3 w-3" /> Saved
            </div>
          )}
        </div>
      )}

      {segment === "danger" && (
        <div
          className="p-4 rounded-[10px]"
          style={{ backgroundColor: "rgba(255, 59, 48, 0.08)", border: "1px solid rgba(255, 59, 48, 0.3)" }}
        >
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4" style={{ color: "var(--mc-danger)" }} />
            <span className="text-[14px] font-semibold" style={{ color: "var(--mc-text)" }}>Delete domain</span>
          </div>
          <div className="text-[12px] leading-5 mb-3" style={{ color: "var(--mc-text-muted)" }}>
            Removes <code>{domain.domain}</code> from Resend and this app. Deletes every address and stored message
            on this domain. DNS records in Cloudflare are NOT touched.
          </div>
          <input
            type="text"
            placeholder={`Type "${domain.domain}" to confirm`}
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            className={`${inputCls} w-full mb-2`}
            style={inputStyle}
          />
          <button
            onClick={deleteDomain}
            disabled={deletingDomain || deleteConfirmText !== domain.domain}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-white disabled:opacity-40"
            style={{ backgroundColor: "var(--mc-danger)" }}
          >
            {deletingDomain ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Delete domain"}
          </button>
        </div>
      )}

      {/* Edit address sub-modal */}
      {editing && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          style={{ backgroundColor: "var(--mc-modal-overlay)" }}
          onClick={() => setEditing(null)}
        >
          <div
            className="rounded-xl p-4 w-[min(420px,90vw)]"
            style={{ backgroundColor: "var(--mc-bg-elevated)", border: "1px solid var(--mc-border)", boxShadow: "var(--mc-shadow)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-semibold mb-3" style={{ color: "var(--mc-text)" }}>Edit address</div>
            <div className="flex items-center gap-2 mb-2">
              <input
                type="text"
                value={editing.local}
                onChange={(e) => setEditing({ ...editing, local: e.target.value })}
                className={inputCls}
                style={inputStyle}
              />
              <span className="text-[13px]" style={{ color: "var(--mc-text-faint)" }}>@{domain.domain}</span>
            </div>
            <input
              type="text"
              placeholder="Display name (optional)"
              value={editing.display}
              onChange={(e) => setEditing({ ...editing, display: e.target.value })}
              className={`${inputCls} w-full mb-2`}
              style={inputStyle}
            />
            {editError && <div className="text-[12px] mb-2" style={{ color: "var(--mc-danger)" }}>{editError}</div>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditing(null)}
                className="px-3 py-1.5 rounded-md text-[12px]"
                style={{ color: "var(--mc-text-muted)", border: "1px solid var(--mc-border)" }}
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={editSaving}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white disabled:opacity-40"
                style={{ backgroundColor: "var(--mc-accent)" }}
              >
                {editSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm-delete address sub-modal */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          style={{ backgroundColor: "var(--mc-modal-overlay)" }}
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="rounded-xl p-4 w-[min(400px,90vw)]"
            style={{ backgroundColor: "var(--mc-bg-elevated)", border: "1px solid var(--mc-border)", boxShadow: "var(--mc-shadow)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-semibold mb-1" style={{ color: "var(--mc-text)" }}>
              Delete {confirmDelete.email}?
            </div>
            <div className="text-[12px] mb-3" style={{ color: "var(--mc-text-muted)" }}>
              Future mail to this address will fall through to the domain&apos;s catch-all (if enabled) or bounce.
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 rounded-md text-[12px]"
                style={{ color: "var(--mc-text-muted)", border: "1px solid var(--mc-border)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => deleteAddress(confirmDelete.id)}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white"
                style={{ backgroundColor: "var(--mc-danger)" }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
