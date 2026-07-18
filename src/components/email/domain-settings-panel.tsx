"use client";

import { useState } from "react";
import {
  X,
  Plus,
  Mail,
  Shield,
  Trash2,
  Pencil,
  Check,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import type { EmailDomain, EmailAddress } from "./email-layout";
import { apiFetch } from "@/lib/auth";

interface DomainSettingsPanelProps {
  domain: EmailDomain;
  onClose: () => void;
  onRefresh: () => void;
}

type Tab = "addresses" | "catchall" | "danger";

export function DomainSettingsPanel({ domain, onClose, onRefresh }: DomainSettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>("addresses");

  // Address list state
  const [localAddresses, setLocalAddresses] = useState<EmailAddress[]>(domain.addresses || []);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLocal, setNewLocal] = useState("");
  const [newDisplay, setNewDisplay] = useState("");
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editing, setEditing] = useState<{ id: string; local: string; display: string } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  // Confirm-delete address
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; email: string } | null>(null);

  // Catch-all tab state
  const [catchAllEnabled, setCatchAllEnabled] = useState(domain.catch_all_enabled);
  const [catchAllPrefix, setCatchAllPrefix] = useState(domain.catch_all_subject_prefix || "[Catch-All]");
  const [catchAllDest, setCatchAllDest] = useState<string | null>(
    domain.catchall_destination_address_id || null
  );
  const [catchAllSaving, setCatchAllSaving] = useState(false);
  const [catchAllSavedAt, setCatchAllSavedAt] = useState(0);

  // Danger tab state
  const [deletingDomain, setDeletingDomain] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const tabs: { id: Tab; label: string; icon: typeof Mail }[] = [
    { id: "addresses", label: "Addresses", icon: Mail },
    { id: "catchall", label: "Catch-All", icon: Shield },
    { id: "danger", label: "Danger Zone", icon: Trash2 },
  ];

  // ─── Add a new address ───
  const addAddress = async () => {
    const local = newLocal.toLowerCase().trim().replace(/@.*$/, "");
    if (!local) return;
    setAdding(true);
    try {
      const res = await apiFetch("/api/email/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain_id: domain.id,
          address: local,
          display_name: newDisplay.trim() || undefined,
        }),
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

  // ─── Edit an address (local-part + display name) ───
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

  // ─── Delete an address ───
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

  // ─── Catch-all toggle + prefix save ───
  const saveCatchAll = async (next: { enabled?: boolean; prefix?: string; destination?: string | null }) => {
    setCatchAllSaving(true);
    try {
      const body: Record<string, any> = { domain_id: domain.id };
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

  // ─── Delete entire domain ───
  const deleteDomain = async () => {
    setDeletingDomain(true);
    try {
      const res = await apiFetch(`/api/email/domains?id=${domain.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to delete domain");
        return;
      }
      onClose();
      onRefresh();
    } finally {
      setDeletingDomain(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "var(--mc-bg-panel, #111318)",
          border: "1px solid var(--mc-border, rgba(255,255,255,0.06))",
          borderRadius: 12,
          width: "min(680px, 95vw)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          color: "var(--mc-text, #fff)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--mc-border, rgba(255,255,255,0.06))",
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: "var(--mc-text-faint, #6B7280)" }}>Domain settings</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{domain.domain}</div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "var(--mc-text-faint, #9CA3AF)", cursor: "pointer" }}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", padding: "0 20px", borderBottom: "1px solid var(--mc-border, rgba(255,255,255,0.06))" }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "12px 16px",
                background: "transparent",
                color: activeTab === tab.id ? "var(--mc-accent)" : "var(--mc-text-faint, #9CA3AF)",
                borderBottom:
                  activeTab === tab.id
                    ? "2px solid var(--mc-accent)"
                    : "2px solid transparent",
                border: "none",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 500,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
          {/* ─── Addresses tab ─── */}
          {activeTab === "addresses" && (
            <div>
              {/* Add form */}
              {!showAddForm ? (
                <button
                  onClick={() => setShowAddForm(true)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 14px",
                    borderRadius: 6,
                    background: "var(--mc-accent)",
                    color: "#fff",
                    border: "none",
                    cursor: "pointer",
                    fontSize: 14,
                    marginBottom: 16,
                  }}
                >
                  <Plus size={14} /> Add address
                </button>
              ) : (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 8,
                    border: "1px solid var(--mc-border, rgba(255,255,255,0.06))",
                    backgroundColor: "var(--mc-bg-card, #1A1D24)",
                    marginBottom: 16,
                  }}
                >
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <input
                      type="text"
                      placeholder="local-part"
                      value={newLocal}
                      onChange={(e) => setNewLocal(e.target.value)}
                      style={inputStyle}
                    />
                    <div style={{ alignSelf: "center", color: "var(--mc-text-faint, #6B7280)" }}>@{domain.domain}</div>
                  </div>
                  <input
                    type="text"
                    placeholder="Display name (optional)"
                    value={newDisplay}
                    onChange={(e) => setNewDisplay(e.target.value)}
                    style={{ ...inputStyle, width: "100%", marginBottom: 8 }}
                  />
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button onClick={() => { setShowAddForm(false); setNewLocal(""); setNewDisplay(""); }} style={btnGhost}>Cancel</button>
                    <button onClick={addAddress} disabled={adding || !newLocal.trim()} style={btnPrimary}>
                      {adding ? <Loader2 size={14} className="animate-spin" /> : "Add"}
                    </button>
                  </div>
                </div>
              )}

              {/* Address list */}
              {localAddresses.length === 0 ? (
                <div style={{ color: "var(--mc-text-faint, #6B7280)", fontSize: 14 }}>No addresses yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {localAddresses.map((addr) => (
                    <div
                      key={addr.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        borderRadius: 6,
                        backgroundColor: "var(--mc-bg-card, #1A1D24)",
                        border: "1px solid var(--mc-border, rgba(255,255,255,0.06))",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500 }}>
                          {addr.address}@{domain.domain}
                        </div>
                        {addr.display_name && (
                          <div style={{ fontSize: 12, color: "var(--mc-text-faint, #9CA3AF)" }}>
                            {addr.display_name}
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          onClick={() =>
                            setEditing({
                              id: addr.id,
                              local: addr.address,
                              display: addr.display_name || "",
                            })
                          }
                          style={iconBtn}
                          title="Edit"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() =>
                            setConfirmDelete({ id: addr.id, email: `${addr.address}@${domain.domain}` })
                          }
                          style={{ ...iconBtn, color: "#EF4444" }}
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ─── Catch-all tab ─── */}
          {activeTab === "catchall" && (
            <div>
              <div style={{ fontSize: 14, color: "var(--mc-text-faint, #9CA3AF)", marginBottom: 16, lineHeight: 1.5 }}>
                When enabled, mail to any unknown address on <code>@{domain.domain}</code> is captured in MC's inbox
                with a subject prefix to flag it as catch-all.
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: 16 }}>
                <input
                  type="checkbox"
                  checked={catchAllEnabled}
                  onChange={(e) => saveCatchAll({ enabled: e.target.checked })}
                  disabled={catchAllSaving}
                />
                <span style={{ fontSize: 14 }}>Catch all unknown addresses</span>
              </label>

              {catchAllEnabled && (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontSize: 12, color: "var(--mc-text-faint, #9CA3AF)", display: "block", marginBottom: 4 }}>
                      Subject prefix
                    </label>
                    <input
                      type="text"
                      value={catchAllPrefix}
                      onChange={(e) => setCatchAllPrefix(e.target.value)}
                      onBlur={() => saveCatchAll({ prefix: catchAllPrefix })}
                      style={{ ...inputStyle, width: "100%" }}
                      placeholder="[Catch-All]"
                    />
                  </div>

                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontSize: 12, color: "var(--mc-text-faint, #9CA3AF)", display: "block", marginBottom: 4 }}>
                      Route catch-all mail to
                    </label>
                    <select
                      value={catchAllDest || ""}
                      onChange={(e) => saveCatchAll({ destination: e.target.value || null })}
                      disabled={catchAllSaving || localAddresses.filter((a) => a.is_active).length === 0}
                      style={{ ...inputStyle, width: "100%", cursor: "pointer" }}
                    >
                      <option value="">— Unattributed (inbox at domain level) —</option>
                      {localAddresses
                        .filter((a) => a.is_active)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.address}@{domain.domain}
                            {a.display_name ? ` (${a.display_name})` : ""}
                          </option>
                        ))}
                    </select>
                    <div style={{ fontSize: 11, color: "var(--mc-text-faint, #6B7280)", marginTop: 4, lineHeight: 1.4 }}>
                      Unmatched mail on this domain will be attributed to the selected address — so it shows up in
                      that address&apos;s inbox view alongside their own mail.
                    </div>
                  </div>
                </>
              )}

              {Date.now() - catchAllSavedAt < 2000 && (
                <div style={{ fontSize: 12, color: "var(--mc-accent)", display: "flex", alignItems: "center", gap: 4 }}>
                  <Check size={12} /> Saved
                </div>
              )}
            </div>
          )}

          {/* ─── Danger tab ─── */}
          {activeTab === "danger" && (
            <div>
              <div
                style={{
                  padding: 16,
                  borderRadius: 8,
                  border: "1px solid #7F1D1D",
                  backgroundColor: "rgba(127,29,29,0.15)",
                  marginBottom: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <AlertTriangle size={16} style={{ color: "#EF4444" }} />
                  <div style={{ fontWeight: 600 }}>Delete domain</div>
                </div>
                <div style={{ fontSize: 13, color: "var(--mc-text-faint, #9CA3AF)", marginBottom: 12, lineHeight: 1.5 }}>
                  Removes <code>{domain.domain}</code> from Resend and this app. Deletes every address and stored
                  message on this domain. DNS records in Cloudflare are NOT touched.
                </div>
                <input
                  type="text"
                  placeholder={`Type "${domain.domain}" to confirm`}
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  style={{ ...inputStyle, width: "100%", marginBottom: 8 }}
                />
                <button
                  onClick={deleteDomain}
                  disabled={deletingDomain || deleteConfirmText !== domain.domain}
                  style={{
                    ...btnPrimary,
                    backgroundColor: "#DC2626",
                    opacity: deletingDomain || deleteConfirmText !== domain.domain ? 0.5 : 1,
                  }}
                >
                  {deletingDomain ? <Loader2 size={14} className="animate-spin" /> : "Delete domain"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Edit address modal */}
      {editing && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            backgroundColor: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setEditing(null)}
        >
          <div
            style={{
              backgroundColor: "var(--mc-bg-panel, #111318)",
              border: "1px solid var(--mc-border, rgba(255,255,255,0.06))",
              borderRadius: 12,
              padding: 20,
              width: "min(440px, 90vw)",
              color: "var(--mc-text, #fff)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Edit address</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                type="text"
                value={editing.local}
                onChange={(e) => setEditing({ ...editing, local: e.target.value })}
                style={inputStyle}
              />
              <div style={{ alignSelf: "center", color: "var(--mc-text-faint, #6B7280)" }}>@{domain.domain}</div>
            </div>
            <input
              type="text"
              placeholder="Display name (optional)"
              value={editing.display}
              onChange={(e) => setEditing({ ...editing, display: e.target.value })}
              style={{ ...inputStyle, width: "100%", marginBottom: 8 }}
            />
            {editError && <div style={{ color: "#EF4444", fontSize: 12, marginBottom: 8 }}>{editError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setEditing(null)} style={btnGhost}>Cancel</button>
              <button onClick={saveEdit} disabled={editSaving} style={btnPrimary}>
                {editSaving ? <Loader2 size={14} className="animate-spin" /> : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm-delete address modal */}
      {confirmDelete && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            backgroundColor: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setConfirmDelete(null)}
        >
          <div
            style={{
              backgroundColor: "var(--mc-bg-panel, #111318)",
              border: "1px solid var(--mc-border, rgba(255,255,255,0.06))",
              borderRadius: 12,
              padding: 20,
              width: "min(420px, 90vw)",
              color: "var(--mc-text, #fff)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Delete {confirmDelete.email}?</div>
            <div style={{ fontSize: 13, color: "var(--mc-text-faint, #9CA3AF)", marginBottom: 16 }}>
              Future mail to this address will fall through to the domain's catch-all (if enabled) or bounce.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmDelete(null)} style={btnGhost}>Cancel</button>
              <button
                onClick={() => deleteAddress(confirmDelete.id)}
                style={{ ...btnPrimary, backgroundColor: "#DC2626" }}
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

// Inline styles (rather than a new CSS module) since this file follows the
// rest of the email/ component pattern of literal style objects.
const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.1)",
  backgroundColor: "rgba(0,0,0,0.3)",
  color: "var(--mc-text, #fff)",
  fontSize: 14,
  outline: "none",
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  background: "var(--mc-accent)",
  color: "#fff",
  border: "none",
  cursor: "pointer",
  fontSize: 14,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const btnGhost: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  background: "transparent",
  color: "var(--mc-text-faint, #9CA3AF)",
  border: "1px solid rgba(255,255,255,0.1)",
  cursor: "pointer",
  fontSize: 14,
};

const iconBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--mc-text-faint, #9CA3AF)",
  cursor: "pointer",
  padding: 6,
  borderRadius: 4,
};
