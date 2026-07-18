"use client";

// Settings → Rules: manage delivery rules (applied to incoming mail in
// inbound.ts). Ordered list with drag reorder, enable toggles, and an
// add/edit card with condition + action builders.

import { useState, useEffect, useCallback } from "react";
import { ListFilter, Plus, GripVertical, Pencil, Trash2, Loader2, X } from "lucide-react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { apiFetch } from "@/lib/auth";
import type { EmailDomain } from "../email-layout";
import { MCSwitch, SegmentedControl, SelectRow } from "./controls";

interface RuleCondition {
  field: "from" | "to" | "subject";
  op: "contains" | "equals" | "ends_with";
  value: string;
}

interface RuleAction {
  type: "move_folder" | "mark_read" | "flag" | "junk" | "trash";
  folder?: "inbox" | "archive";
}

interface EmailRule {
  id: string;
  name: string;
  is_active: boolean;
  priority: number;
  match_type: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleAction[];
  domain_id: string | null;
}

const FIELD_LABELS: Record<string, string> = { from: "From", to: "To", subject: "Subject" };
const OP_LABELS: Record<string, string> = { contains: "contains", equals: "is exactly", ends_with: "ends with" };
const ACTION_LABELS: Record<string, string> = {
  mark_read: "Mark read",
  flag: "Flag",
  junk: "Move to Junk",
  trash: "Move to Trash",
};

function actionLabel(a: RuleAction): string {
  if (a.type === "move_folder") return a.folder === "archive" ? "Archive" : "Move to Inbox";
  return ACTION_LABELS[a.type] ?? a.type;
}

function ruleSummary(rule: EmailRule): string {
  const conds = rule.conditions
    .map((c) => `${FIELD_LABELS[c.field]} ${OP_LABELS[c.op]} "${c.value}"`)
    .join(rule.match_type === "any" ? " or " : " and ");
  const acts = rule.actions.map(actionLabel).join(", ");
  return `${conds} → ${acts}`;
}

const inputCls = "px-2 py-1 rounded-md text-[12px] outline-none";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--mc-bg)",
  color: "var(--mc-text)",
  border: "1px solid var(--mc-border)",
};

// ---------- Add/Edit card ----------

function RuleEditor({
  rule,
  domains,
  onSave,
  onCancel,
}: {
  rule: EmailRule | null;
  domains: EmailDomain[];
  onSave: (draft: Omit<EmailRule, "id" | "priority" | "is_active">, id?: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [matchType, setMatchType] = useState<"all" | "any">(rule?.match_type ?? "all");
  const [conditions, setConditions] = useState<RuleCondition[]>(
    rule?.conditions?.length ? rule.conditions : [{ field: "from", op: "contains", value: "" }]
  );
  const [actions, setActions] = useState<RuleAction[]>(
    rule?.actions?.length ? rule.actions : [{ type: "mark_read" }]
  );
  const [domainId, setDomainId] = useState<string>(rule?.domain_id ?? "all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setCond = (i: number, patch: Partial<RuleCondition>) =>
    setConditions((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const setAct = (i: number, patch: Partial<RuleAction>) =>
    setActions((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));

  const save = async () => {
    setSaving(true);
    setError(null);
    const err = await onSave(
      {
        name: name.trim(),
        match_type: matchType,
        conditions: conditions.filter((c) => c.value.trim()),
        actions,
        domain_id: domainId === "all" ? null : domainId,
      },
      rule?.id
    );
    setSaving(false);
    if (err) setError(err);
  };

  return (
    <div
      className="rounded-[10px] p-3 mb-3"
      style={{ backgroundColor: "var(--mc-bg-tertiary)", border: "1px solid var(--mc-border)" }}
    >
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
          {rule ? "Edit Rule" : "New Rule"}
        </span>
        <button onClick={onCancel} className="p-1 rounded" style={{ color: "var(--mc-text-muted)" }}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <input
        type="text"
        placeholder="Rule name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={`${inputCls} w-full mb-2.5`}
        style={inputStyle}
      />

      <div className="flex items-center gap-2 mb-2 text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
        If
        <SegmentedControl<"all" | "any">
          value={matchType}
          onChange={setMatchType}
          options={[
            { value: "all", label: "all" },
            { value: "any", label: "any" },
          ]}
        />
        of the following are true:
      </div>

      {conditions.map((c, i) => (
        <div key={i} className="flex items-center gap-1.5 mb-1.5">
          <SelectRow
            value={c.field}
            onChange={(v) => setCond(i, { field: v as RuleCondition["field"] })}
            options={[
              { value: "from", label: "From" },
              { value: "to", label: "To" },
              { value: "subject", label: "Subject" },
            ]}
          />
          <SelectRow
            value={c.op}
            onChange={(v) => setCond(i, { op: v as RuleCondition["op"] })}
            options={[
              { value: "contains", label: "contains" },
              { value: "equals", label: "is exactly" },
              { value: "ends_with", label: "ends with" },
            ]}
          />
          <input
            type="text"
            placeholder={c.field === "from" && c.op === "ends_with" ? "@example.com" : "value"}
            value={c.value}
            onChange={(e) => setCond(i, { value: e.target.value })}
            className={`${inputCls} flex-1 min-w-0`}
            style={inputStyle}
          />
          <button
            onClick={() => setConditions((prev) => prev.filter((_, idx) => idx !== i))}
            disabled={conditions.length === 1}
            className="p-1 rounded disabled:opacity-30"
            style={{ color: "var(--mc-text-muted)" }}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      <button
        onClick={() => setConditions((prev) => [...prev, { field: "from", op: "contains", value: "" }])}
        className="text-[11px] mb-2.5"
        style={{ color: "var(--mc-accent)" }}
      >
        + Add condition
      </button>

      <div className="text-[12px] mb-1.5" style={{ color: "var(--mc-text-muted)" }}>
        Perform these actions:
      </div>
      {actions.map((a, i) => (
        <div key={i} className="flex items-center gap-1.5 mb-1.5">
          <SelectRow
            value={a.type === "move_folder" ? `move_${a.folder}` : a.type}
            onChange={(v) => {
              if (v === "move_inbox") setAct(i, { type: "move_folder", folder: "inbox" });
              else if (v === "move_archive") setAct(i, { type: "move_folder", folder: "archive" });
              else setAct(i, { type: v as RuleAction["type"], folder: undefined });
            }}
            options={[
              { value: "mark_read", label: "Mark read" },
              { value: "flag", label: "Flag" },
              { value: "move_archive", label: "Archive" },
              { value: "move_inbox", label: "Move to Inbox (rescue)" },
              { value: "junk", label: "Move to Junk" },
              { value: "trash", label: "Move to Trash" },
            ]}
          />
          <button
            onClick={() => setActions((prev) => prev.filter((_, idx) => idx !== i))}
            disabled={actions.length === 1}
            className="p-1 rounded disabled:opacity-30"
            style={{ color: "var(--mc-text-muted)" }}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      <button
        onClick={() => setActions((prev) => [...prev, { type: "mark_read" }])}
        className="text-[11px] mb-2.5"
        style={{ color: "var(--mc-accent)" }}
      >
        + Add action
      </button>

      <div className="flex items-center gap-2 mb-3 text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
        Applies to
        <SelectRow
          value={domainId}
          onChange={setDomainId}
          options={[
            { value: "all", label: "All domains" },
            ...domains.map((d) => ({ value: d.id, label: d.domain })),
          ]}
        />
      </div>

      {error && (
        <div className="text-[12px] mb-2" style={{ color: "var(--mc-danger)" }}>{error}</div>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md text-[12px]"
          style={{ color: "var(--mc-text-muted)", border: "1px solid var(--mc-border)" }}
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving || !name.trim() || conditions.every((c) => !c.value.trim())}
          className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white disabled:opacity-40"
          style={{ backgroundColor: "var(--mc-accent)" }}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save Rule"}
        </button>
      </div>
    </div>
  );
}

// ---------- Tab ----------

export function RulesTab({ domains = [] }: { domains?: EmailDomain[] }) {
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [needsMigration, setNeedsMigration] = useState(false);
  const [editing, setEditing] = useState<EmailRule | null | "new">(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/email/rules");
      if (res.ok) {
        setRules(await res.json());
        setNeedsMigration(false);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveRule = async (
    draft: Omit<EmailRule, "id" | "priority" | "is_active">,
    id?: string
  ): Promise<string | null> => {
    const res = await apiFetch("/api/email/rules", {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(id ? { id, ...draft } : draft),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data?.needs_migration) setNeedsMigration(true);
      return data?.error || "Failed to save rule";
    }
    setEditing(null);
    await load();
    return null;
  };

  const toggleActive = async (rule: EmailRule) => {
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, is_active: !r.is_active } : r)));
    await apiFetch("/api/email/rules", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, is_active: !rule.is_active }),
    });
  };

  const deleteRule = async (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    setConfirmDelete(null);
    await apiFetch(`/api/email/rules?id=${id}`, { method: "DELETE" });
  };

  const onDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const next = [...rules];
    const [moved] = next.splice(result.source.index, 1);
    next.splice(result.destination.index, 0, moved);
    setRules(next);
    await apiFetch("/api/email/rules", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reorder: next.map((r) => r.id) }),
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--mc-accent)" }} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>Rules</div>
          <div className="text-[11px]" style={{ color: "var(--mc-text-muted)" }}>
            Run on incoming mail, top to bottom. All matching rules apply; later rules win.
          </div>
        </div>
        <button
          onClick={() => setEditing("new")}
          disabled={needsMigration}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium text-white disabled:opacity-40"
          style={{ backgroundColor: "var(--mc-accent)" }}
          title={needsMigration ? "Run the migration SQL first (see notice above)" : "Add a rule"}
        >
          <Plus className="h-3.5 w-3.5" /> Add Rule
        </button>
      </div>

      {editing !== null && (
        <RuleEditor
          rule={editing === "new" ? null : editing}
          domains={domains}
          onSave={saveRule}
          onCancel={() => setEditing(null)}
        />
      )}

      {rules.length === 0 && editing === null ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <ListFilter className="h-8 w-8 mb-3" style={{ color: "var(--mc-text-ghost)" }} />
          <div className="text-[13px] font-medium" style={{ color: "var(--mc-text-secondary)" }}>
            No rules yet
          </div>
          <div className="text-[12px] mt-1 max-w-[300px] leading-4" style={{ color: "var(--mc-text-muted)" }}>
            Rules file, flag, mark read, or junk incoming messages automatically — great for taming catch-alls.
          </div>
        </div>
      ) : (
        <DragDropContext onDragEnd={onDragEnd}>
          <Droppable droppableId="rules">
            {(dropProvided) => (
              <div
                ref={dropProvided.innerRef}
                {...dropProvided.droppableProps}
                className="rounded-[10px] overflow-hidden"
                style={{ backgroundColor: "var(--mc-bg-tertiary)" }}
              >
                {rules.map((rule, index) => {
                  const domainLabel = rule.domain_id
                    ? domains.find((d) => d.id === rule.domain_id)?.domain
                    : null;
                  return (
                    <Draggable key={rule.id} draggableId={rule.id} index={index}>
                      {(dragProvided, snapshot) => (
                        <div
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          className="flex items-center gap-2 px-2.5 py-2"
                          style={{
                            ...dragProvided.draggableProps.style,
                            borderBottom: index === rules.length - 1 ? "none" : "1px solid var(--mc-border-subtle)",
                            backgroundColor: snapshot.isDragging ? "var(--mc-bg-elevated)" : undefined,
                            opacity: rule.is_active ? 1 : 0.55,
                          }}
                        >
                          <span
                            {...dragProvided.dragHandleProps}
                            className="flex-shrink-0 cursor-grab active:cursor-grabbing"
                            style={{ color: "var(--mc-text-faint)" }}
                          >
                            <GripVertical className="h-3.5 w-3.5" />
                          </span>
                          <MCSwitch checked={rule.is_active} onCheckedChange={() => toggleActive(rule)} />
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] truncate" style={{ color: "var(--mc-text)" }}>
                              {rule.name}
                              {domainLabel && (
                                <span className="ml-1.5 text-[10px]" style={{ color: "var(--mc-text-faint)" }}>
                                  {domainLabel}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>
                              {ruleSummary(rule)}
                            </div>
                          </div>
                          {confirmDelete === rule.id ? (
                            <button
                              onClick={() => deleteRule(rule.id)}
                              className="px-2 py-1 rounded-md text-[11px] font-medium text-white flex-shrink-0"
                              style={{ backgroundColor: "var(--mc-danger)" }}
                            >
                              Confirm
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => setEditing(rule)}
                                className="p-1.5 rounded-md flex-shrink-0"
                                style={{ color: "var(--mc-text-muted)" }}
                                title="Edit"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => setConfirmDelete(rule.id)}
                                className="p-1.5 rounded-md flex-shrink-0"
                                style={{ color: "var(--mc-text-muted)" }}
                                title="Delete"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </Draggable>
                  );
                })}
                {dropProvided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      )}
    </div>
  );
}
