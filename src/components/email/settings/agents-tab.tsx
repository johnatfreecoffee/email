"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import {
  type Grant,
  type GrantMode,
  blankGrant,
  normalizeGrant,
  previewFromGrant,
} from "@/lib/agent-access";
import type { EmailDomain } from "../email-layout";

interface AgentInfo {
  id?: string;
  local_part: string;
  display_name: string;
  is_active?: boolean;
  mailbox?: string;
  domain_id?: string;
  domain?: string;
}

interface AgentUser {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  archived: boolean;
  agents: Record<string, Grant>;
}

type SubTab = "mailboxes" | "active" | "access" | "archived" | "setup";

const AM_CSS = `
  .am-in { width:100%; border:1px solid var(--mc-border); background:var(--mc-bg); color:var(--mc-text); border-radius:8px; padding:7px 10px; font-size:13px; outline:none; box-sizing:border-box; }
  .am-in:focus { border-color:var(--mc-accent); box-shadow:0 0 0 3px var(--mc-accent-bg); }
  .am-btn { border:0; border-radius:8px; padding:7px 14px; background:var(--mc-accent); color:#fff; font-weight:600; font-size:13px; cursor:pointer; min-height:34px; }
  .am-btn:disabled { opacity:.55; cursor:default; }
  .am-ghost { background:transparent; color:var(--mc-text); border:1px solid var(--mc-border); border-radius:8px; padding:4px 9px; font-size:12px; cursor:pointer; }
  .am-ghost:disabled { opacity:.5; cursor:default; }
  .am-pre { margin:8px 0 0; padding:10px 12px; border-radius:10px; background:var(--mc-bg-tertiary); color:var(--mc-text); border:1px solid var(--mc-border); font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; overflow-x:hidden; max-width:100%; max-height:180px; overflow-y:auto; }
  .am-add { display:grid; gap:8px; grid-template-columns:1fr 1fr minmax(0,1.5fr) auto; align-items:center; }
  @media (max-width:720px) {
    .am-add { grid-template-columns:1fr 1fr; }
    .am-add .am-span { grid-column:1 / -1; }
  }
`;

const chip = (on: boolean): React.CSSProperties => ({
  border: `1px solid ${on ? "var(--mc-accent)" : "var(--mc-border)"}`,
  backgroundColor: on ? "var(--mc-bg-active)" : "transparent",
  color: on ? "var(--mc-accent)" : "var(--mc-text)",
  borderRadius: 999,
  padding: "3px 9px",
  fontSize: 12,
  fontWeight: on ? 600 : 500,
});

export function AgentsTab({
  domains = [],
  onRefreshDomains,
}: {
  domains?: EmailDomain[];
  onRefreshDomains?: () => void;
}) {
  const [tab, setTab] = useState<SubTab>("mailboxes");
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [needsMigration, setNeedsMigration] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, AgentUser>>({});
  const [q, setQ] = useState("");
  const [nfirst, setNfirst] = useState("");
  const [nlast, setNlast] = useState("");
  const [nemail, setNemail] = useState("");
  const [nerr, setNerr] = useState("");
  const [adding, setAdding] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const booted = useRef(false);
  const saveTimers = useRef<Record<string, number>>({});

  const load = useCallback(async (silent = false) => {
    if (!silent && !booted.current) setLoading(true);
    setError("");
    try {
      const [people, boxes] = await Promise.all([
        apiFetch(`/api/email/agent-users?tab=${tab === "archived" ? "archived" : "active"}`),
        apiFetch("/api/email/agent-mailboxes"),
      ]);
      const data = await people.json();
      const box = await boxes.json();
      if (!people.ok) throw new Error(data.error || people.statusText);
      setUsers(data.users || []);
      setAgents((box.agents || data.agents || []) as AgentInfo[]);
      setNeedsMigration(!!data.needs_migration);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
      booted.current = true;
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  function seedDraft(u: AgentUser): AgentUser {
    const agentsMap: Record<string, Grant> = {};
    for (const a of agents) agentsMap[a.local_part] = blankGrant();
    Object.assign(agentsMap, u.agents || {});
    for (const k of Object.keys(agentsMap)) agentsMap[k] = normalizeGrant(agentsMap[k]);
    return { ...u, agents: agentsMap };
  }

  function draftFor(u: AgentUser): AgentUser {
    return drafts[u.id] || seedDraft(u);
  }

  function setDraft(id: string, next: AgentUser, persist = false) {
    setDrafts((prev) => ({ ...prev, [id]: next }));
    if (!persist) return;
    window.clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = window.setTimeout(() => {
      void saveUser(id, next);
    }, 400);
  }

  const shown = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return users.filter((u) => {
      if (!u?.id) return false;
      const d = drafts[u.id] || u;
      const blob = `${d.first_name} ${d.last_name} ${d.email}`.toLowerCase();
      return !needle || blob.includes(needle);
    });
  }, [users, drafts, q]);

  async function addUser() {
    setNerr("");
    const first = nfirst.trim();
    const last = nlast.trim();
    const email = nemail.trim();
    if (!first || !last || !email) {
      setNerr("First, last, and email are required.");
      return;
    }
    const agentsMap: Record<string, Grant> = {};
    for (const a of agents) agentsMap[a.local_part] = blankGrant();
    setAdding(true);
    try {
      const res = await apiFetch("/api/email/agent-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: first, last_name: last, email, agents: agentsMap }),
      });
      const data = await res.json().catch(() => ({}));
      const user = data.user as AgentUser | undefined;
      if (!res.ok || !user?.id) {
        setNerr(data.error || "Couldn't add that person");
        await load(true);
        return;
      }
      setNfirst("");
      setNlast("");
      setNemail("");
      setUsers((prev) => [user, ...prev.filter((u) => u.id !== user.id)]);
      setOpen((s) => new Set(s).add(user.id));
      setHighlightId(user.id);
      window.setTimeout(() => {
        setHighlightId((id) => (id === user.id ? null : id));
      }, 1600);
    } catch (e) {
      setNerr(e instanceof Error ? e.message : "Couldn't add that person");
    } finally {
      setAdding(false);
    }
  }

  async function saveUser(id: string, override?: AgentUser) {
    const d = override || drafts[id] || users.find((u) => u.id === id);
    if (!d) return;
    setSavingId(id);
    setError("");
    try {
      const res = await apiFetch(`/api/email/agent-users?id=${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user) {
        setError(data.error || "save failed");
        return;
      }
      setUsers((prev) => prev.map((u) => (u.id === id ? data.user : u)));
      setDrafts((prev) => {
        const cur = prev[id];
        if (!cur) return prev;
        const nameDirty =
          cur.first_name !== d.first_name ||
          cur.last_name !== d.last_name ||
          cur.email !== d.email;
        if (nameDirty) {
          return { ...prev, [id]: { ...data.user, first_name: cur.first_name, last_name: cur.last_name, email: cur.email } };
        }
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSavedId(id);
      window.setTimeout(() => {
        setSavedId((cur) => (cur === id ? null : cur));
      }, 1400);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSavingId(null);
    }
  }

  async function archiveOrRestore(id: string, action: "archive" | "restore") {
    await apiFetch(`/api/email/agent-users?id=${id}&action=${action}`, { method: "POST" });
    setUsers((prev) => prev.filter((u) => u.id !== id));
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setOpen((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    await load(true);
  }

  if (tab === "setup") {
    return (
      <div>
        <SubTabs tab={tab} setTab={setTab} />
        <AgentSetupPanel
          domains={domains}
          agents={agents}
          onCreated={() => {
            void load();
            onRefreshDomains?.();
          }}
        />
        <style>{AM_CSS}</style>
      </div>
    );
  }

  if (tab === "mailboxes") {
    return (
      <div>
        <SubTabs tab={tab} setTab={setTab} />
        {loading ? (
          <div className="flex justify-center py-10" style={{ color: "var(--mc-text-muted)" }}>
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="text-[13px]" style={{ color: "var(--mc-danger)" }}>{error}</div>
        ) : (
          <MailboxesPanel
            agents={agents}
            domains={domains}
            onAgents={setAgents}
            onError={setError}
            onRefresh={() => {
              void load();
              onRefreshDomains?.();
            }}
          />
        )}
        <style>{AM_CSS}</style>
      </div>
    );
  }

  if (tab === "access") {
    return (
      <div>
        <SubTabs tab={tab} setTab={setTab} />
        {loading ? (
          <div className="flex justify-center py-10" style={{ color: "var(--mc-text-muted)" }}>
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="text-[13px]" style={{ color: "var(--mc-danger)" }}>{error}</div>
        ) : (
          <AccessByAgent
            users={users}
            agents={agents}
            onUsers={setUsers}
            onError={setError}
          />
        )}
        <style>{AM_CSS}</style>
      </div>
    );
  }

  return (
    <div>
      <SubTabs tab={tab} setTab={setTab} />
      {needsMigration && (
        <div className="text-[12px] mb-3 px-1" style={{ color: "var(--mc-text-muted)" }}>
          Run <code>migrations/email-agent-senders.sql</code> in Supabase, then refresh.
        </div>
      )}
      {tab === "active" && (
        <div className="am-add mb-3">
          <input className="am-in" placeholder="First" value={nfirst} onChange={(e) => setNfirst(e.target.value)} />
          <input className="am-in" placeholder="Last" value={nlast} onChange={(e) => setNlast(e.target.value)} />
          <input
            className="am-in am-span"
            placeholder="email@example.com"
            value={nemail}
            onChange={(e) => setNemail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addUser();
            }}
          />
          <button className="am-btn am-span" disabled={adding} onClick={() => void addUser()}>
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
          </button>
        </div>
      )}
      {nerr && <div className="text-[12px] mb-2" style={{ color: "var(--mc-danger)" }}>{nerr}</div>}
      {error && <div className="text-[12px] mb-2" style={{ color: "var(--mc-danger)" }}>{error}</div>}
      <input
        className="am-in w-full mb-3"
        placeholder="Search name or email"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {loading ? (
        <div className="flex justify-center py-10" style={{ color: "var(--mc-text-muted)" }}>
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : !shown.length ? (
        <div className="text-center py-10 text-[13px]" style={{ color: "var(--mc-text-muted)" }}>
          {tab === "archived" ? "Nothing archived." : "No users yet."}
        </div>
      ) : (
        <div className="grid gap-2">
          {shown.map((u) => (
            <UserCard
              key={u.id}
              u={draftFor(u)}
              agents={agents}
              open={open.has(u.id)}
              archived={tab === "archived"}
              saving={savingId === u.id}
              saved={savedId === u.id}
              highlight={highlightId === u.id}
              dirty={!!drafts[u.id]}
              onToggle={() => {
                setOpen((s) => {
                  const n = new Set(s);
                  if (n.has(u.id)) n.delete(u.id);
                  else n.add(u.id);
                  return n;
                });
              }}
              onChange={(next) => setDraft(u.id, next, true)}
              onSave={() => void saveUser(u.id, draftFor(u))}
              onArchive={() => archiveOrRestore(u.id, tab === "archived" ? "restore" : "archive")}
            />
          ))}
        </div>
      )}
      <style>{AM_CSS}</style>
    </div>
  );
}

function SubTabs({ tab, setTab }: { tab: SubTab; setTab: (t: SubTab) => void }) {
  const items: Array<[SubTab, string]> = [
    ["mailboxes", "Mailboxes"],
    ["active", "Users"],
    ["access", "Access"],
    ["archived", "People archive"],
    ["setup", "Agent setup"],
  ];
  return (
    <div className="flex gap-1 mb-4 p-1 rounded-[10px] w-fit" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
      {items.map(([id, label]) => (
        <button
          key={id}
          onClick={() => setTab(id)}
          className="px-3 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{
            backgroundColor: tab === id ? "var(--mc-bg-active)" : "transparent",
            color: tab === id ? "var(--mc-accent)" : "var(--mc-text-secondary)",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function summary(agents: Record<string, Grant>) {
  const on = Object.values(agents || {}).filter((g) => g.enabled);
  if (!on.length) return "no agents";
  if (on.every((g) => g.mode === "all")) return `${on.length} · full access`;
  if (on.every((g) => g.mode === "ask")) return `${on.length} · questions only`;
  return `${on.length} agents`;
}

function UserCard({
  u,
  agents,
  open,
  archived,
  saving,
  saved,
  highlight,
  dirty,
  onToggle,
  onChange,
  onSave,
  onArchive,
}: {
  u: AgentUser;
  agents: AgentInfo[];
  open: boolean;
  archived: boolean;
  saving: boolean;
  saved: boolean;
  highlight: boolean;
  dirty: boolean;
  onToggle: () => void;
  onChange: (u: AgentUser) => void;
  onSave: () => void;
  onArchive: () => void;
}) {
  return (
    <div
      className="rounded-[10px] overflow-hidden"
      style={{
        border: `1px solid ${highlight ? "var(--mc-accent)" : "var(--mc-border)"}`,
        backgroundColor: "var(--mc-bg-elevated)",
        boxShadow: highlight ? "0 0 0 3px var(--mc-accent-bg)" : undefined,
      }}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer" onClick={onToggle}>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
            {u.first_name} {u.last_name}
          </div>
          <div className="text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>{u.email}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: "var(--mc-accent-bg)", color: "var(--mc-accent)" }}>
            {summary(u.agents)}
          </span>
          <button
            className="am-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
          >
            {archived ? "Restore" : "Archive"}
          </button>
        </div>
      </div>
      {open && (
        <div className="px-3 pb-3" style={{ borderTop: "1px solid var(--mc-border)" }}>
          <div className="am-add my-3">
            <input className="am-in" value={u.first_name} onChange={(e) => onChange({ ...u, first_name: e.target.value })} />
            <input className="am-in" value={u.last_name} onChange={(e) => onChange({ ...u, last_name: e.target.value })} />
            <input className="am-in am-span" value={u.email} onChange={(e) => onChange({ ...u, email: e.target.value })} />
          </div>
          <div className="flex flex-wrap gap-2 mb-2">
            <button className="am-ghost" onClick={() => selectAll(u, agents, true, onChange)}>Select all agents</button>
            <button className="am-ghost" onClick={() => selectAll(u, agents, false, onChange)}>Deselect all</button>
            <button className="am-ghost" onClick={() => setAllMode(u, agents, "ask", onChange)}>All → questions only</button>
            <button className="am-ghost" onClick={() => setAllMode(u, agents, "all", onChange)}>All → full access</button>
          </div>
          {!agents.length ? (
            <p className="text-[12px] py-2" style={{ color: "var(--mc-text-muted)" }}>
              No agent mailboxes yet. Create one on Mailboxes, then come back and assign them.
            </p>
          ) : (
            <div className="grid gap-2">
              {agents.map((a) => (
                <AgentRow
                  key={a.local_part}
                  agent={a}
                  grant={u.agents[a.local_part] || blankGrant()}
                  onChange={(g) => onChange({ ...u, agents: { ...u.agents, [a.local_part]: g } })}
                />
              ))}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 mt-3">
            <span className="text-[11px] font-medium" style={{ color: saved ? "var(--mc-success)" : "var(--mc-text-faint)" }}>
              {saving ? "Saving…" : saved ? "Saved" : dirty ? "Unsaved" : ""}
            </span>
            <button className="am-btn" disabled={saving} onClick={onSave}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentSetupPanel({
  domains,
  agents,
  onCreated,
}: {
  domains: EmailDomain[];
  agents: AgentInfo[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [domainId, setDomainId] = useState(domains[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!domainId && domains[0]?.id) setDomainId(domains[0].id);
  }, [domains, domainId]);

  async function create() {
    setErr("");
    if (!domainId) {
      setErr("Add a domain in Settings → Setup / Accounts first.");
      return;
    }
    if (!name.trim() && !slug.trim()) {
      setErr("Give them a name, like Marketing.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch("/api/email/agent-mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain_id: domainId, name: name.trim() || slug.trim(), slug: slug.trim() || name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || "Couldn't create that agent");
        return;
      }
      setName("");
      setSlug("");
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <p className="text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>
        Agent setup only. Database, Resend, domain, and the worker live in Settings → Setup.
      </p>
      <ol className="space-y-2 text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>
        <li><span className="font-semibold" style={{ color: "var(--mc-text)" }}>1. Create a mailbox</span> — name + short id. We add a. so it becomes a.marketing@yourdomain.</li>
        <li><span className="font-semibold" style={{ color: "var(--mc-text)" }}>2. Allow people</span> — Users tab. Anyone not listed is ignored.</li>
        <li><span className="font-semibold" style={{ color: "var(--mc-text)" }}>3. Pick what they can do</span> — Questions only, Custom, or All. Access tab flips the same grants per agent.</li>
      </ol>
      <div className="am-add">
        <input className="am-in" placeholder="Name — Marketing" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="am-in" placeholder="Short id — marketing" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
        <select className="am-in am-span" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
          {!domains.length && <option value="">Add a domain first</option>}
          {domains.map((d) => (
            <option key={d.id} value={d.id}>{d.domain}</option>
          ))}
        </select>
        <button className="am-btn am-span" disabled={busy || !domains.length} onClick={() => void create()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
        </button>
      </div>
      {err && <p className="text-[12px]" style={{ color: "var(--mc-danger)" }}>{err}</p>}
      <p className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>
        {agents.length ? `${agents.filter((a) => a.is_active !== false).length} active agent${agents.filter((a) => a.is_active !== false).length === 1 ? "" : "s"}.` : "None yet."} See Mailboxes for archive.
      </p>
    </div>
  );
}

function MailboxesPanel({
  agents,
  domains,
  onAgents,
  onError,
  onRefresh,
}: {
  agents: AgentInfo[];
  domains: EmailDomain[];
  onAgents: (next: AgentInfo[]) => void;
  onError: (msg: string) => void;
  onRefresh: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [domainId, setDomainId] = useState(domains[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!domainId && domains[0]?.id) setDomainId(domains[0].id);
  }, [domains, domainId]);

  const shown = agents.filter((a) => {
    const n = q.toLowerCase().trim();
    if (!n) return true;
    return `${a.display_name} ${a.local_part} ${a.mailbox || ""}`.toLowerCase().includes(n);
  });
  const active = shown.filter((a) => a.is_active !== false);
  const archived = shown.filter((a) => a.is_active === false);

  async function create() {
    setErr("");
    if (!domainId) {
      setErr("Add a domain in Accounts first.");
      return;
    }
    if (!name.trim() && !slug.trim()) {
      setErr("Give them a name, like Marketing.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch("/api/email/agent-mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain_id: domainId, name: name.trim() || slug.trim(), slug: slug.trim() || name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || "Couldn't create that agent");
        return;
      }
      onAgents(data.agents || []);
      setName("");
      setSlug("");
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function setActive(a: AgentInfo, on: boolean) {
    if (!a.id) return;
    const res = await apiFetch(`/api/email/agent-mailboxes?id=${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: on }),
    });
    const data = await res.json();
    if (!res.ok) {
      onError(data.error || "Couldn't update");
      return;
    }
    onAgents(data.agents || []);
    onRefresh();
  }

  return (
    <div className="min-w-0">
      <p className="text-[12px] mb-3 leading-5" style={{ color: "var(--mc-text-muted)" }}>
        Each agent is a mailbox. Active ones show under Agents in the sidebar. Archived ones stay on this list so you can turn them back on.
      </p>
      <div className="am-add mb-3">
        <input className="am-in" placeholder="Name — Marketing" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="am-in" placeholder="Short id — marketing" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
        <select className="am-in am-span" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
          {!domains.length && <option value="">Add a domain first</option>}
          {domains.map((d) => (
            <option key={d.id} value={d.id}>{d.domain}</option>
          ))}
        </select>
        <button className="am-btn am-span" disabled={busy || !domains.length} onClick={() => void create()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
        </button>
      </div>
      {err && <p className="text-[12px] mb-2" style={{ color: "var(--mc-danger)" }}>{err}</p>}
      <input className="am-in w-full mb-3" placeholder="Search agents" value={q} onChange={(e) => setQ(e.target.value)} />

      <p className="text-[11px] font-semibold mb-1.5" style={{ color: "var(--mc-text-faint)" }}>
        Active ({active.length})
      </p>
      <AgentMailboxList rows={active} empty="No active agents yet. Create one above." onArchive={(a) => void setActive(a, false)} />

      <p className="text-[11px] font-semibold mt-4 mb-1.5" style={{ color: "var(--mc-text-faint)" }}>
        Archived ({archived.length})
      </p>
      <AgentMailboxList rows={archived} empty="Nothing archived." restore onArchive={(a) => void setActive(a, true)} />
    </div>
  );
}

function AgentMailboxList({
  rows,
  empty,
  restore,
  onArchive,
}: {
  rows: AgentInfo[];
  empty: string;
  restore?: boolean;
  onArchive: (a: AgentInfo) => void;
}) {
  if (!rows.length) {
    return <p className="text-[12px] py-2" style={{ color: "var(--mc-text-muted)" }}>{empty}</p>;
  }
  return (
    <div className="grid gap-2">
      {rows.map((a) => (
        <div
          key={a.id || a.local_part}
          className="flex items-center justify-between gap-3 rounded-[10px] px-3 py-2.5 min-w-0"
          style={{
            border: "1px solid var(--mc-border)",
            backgroundColor: "var(--mc-bg-elevated)",
            opacity: restore ? 0.75 : 1,
          }}
        >
          <div className="min-w-0">
            <div className="text-[13px] font-semibold truncate" style={{ color: "var(--mc-text)" }}>{a.display_name}</div>
            <div className="text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>{a.mailbox || a.local_part}</div>
          </div>
          <button className="am-ghost flex-shrink-0" onClick={() => onArchive(a)}>
            {restore ? "Restore" : "Archive"}
          </button>
        </div>
      ))}
    </div>
  );
}

function AccessByAgent({
  users,
  agents,
  onUsers,
  onError,
}: {
  users: AgentUser[];
  agents: AgentInfo[];
  onUsers: (next: AgentUser[] | ((prev: AgentUser[]) => AgentUser[])) => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  async function saveGrant(user: AgentUser, local: string, grant: Grant) {
    const key = `${user.id}:${local}`;
    setBusy(key);
    const agentsMap: Record<string, Grant> = {};
    for (const a of agents) agentsMap[a.local_part] = blankGrant();
    Object.assign(agentsMap, user.agents || {});
    for (const k of Object.keys(agentsMap)) agentsMap[k] = normalizeGrant(agentsMap[k]);
    agentsMap[local] = grant;
    const optimistic = { ...user, agents: agentsMap };
    onUsers((prev) => prev.map((u) => (u.id === user.id ? optimistic : u)));
    const res = await apiFetch(`/api/email/agent-users?id=${user.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(optimistic),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok || !data.user) {
      onError(data.error || "save failed");
      onUsers((prev) => prev.map((u) => (u.id === user.id ? user : u)));
      return;
    }
    onUsers((prev) => prev.map((u) => (u.id === user.id ? data.user : u)));
  }

  if (!agents.length) {
    return (
      <div className="text-center py-10 text-[13px]" style={{ color: "var(--mc-text-muted)" }}>
        No agent mailboxes yet. Add an a.* or e.* address under Accounts.
      </div>
    );
  }

  return (
    <div>
      <p className="text-[12px] mb-3" style={{ color: "var(--mc-text-muted)" }}>
        Who can email each agent. Same list as Users — flip either place. Off = Grok never starts. Only listed people can write these mailboxes.
      </p>
      <div className="grid gap-2">
        {agents.map((a) => {
          const allowed = users.filter((u) => u.agents?.[a.local_part]?.enabled);
          const isOpen = open.has(a.local_part);
          return (
            <div
              key={a.local_part}
              className="rounded-[10px] overflow-hidden"
              style={{ border: "1px solid var(--mc-border)", backgroundColor: "var(--mc-bg-elevated)" }}
            >
              <button
                type="button"
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left"
                onClick={() => {
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(a.local_part)) n.delete(a.local_part);
                    else n.add(a.local_part);
                    return n;
                  });
                }}
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
                    {a.display_name}
                    {a.is_active === false ? (
                      <span className="ml-1.5 text-[10px] font-semibold" style={{ color: "var(--mc-text-faint)" }}>archived</span>
                    ) : null}
                  </div>
                  <div className="text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>{a.mailbox || a.local_part}</div>
                </div>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: "var(--mc-bg-active)", color: "var(--mc-accent)" }}>
                  {allowed.length ? `${allowed.length} ${allowed.length === 1 ? "person" : "people"}` : "owner only until you add someone"}
                </span>
              </button>
              {isOpen && (
                <div className="px-3 pb-3" style={{ borderTop: "1px solid var(--mc-border)" }}>
                  {!users.length ? (
                    <p className="text-[12px] py-3" style={{ color: "var(--mc-text-muted)" }}>
                      No people on Users yet. Add someone on the Users tab, then turn them on here.
                    </p>
                  ) : (
                    <ul className="divide-y" style={{ borderColor: "var(--mc-border)" }}>
                      {users.map((u) => {
                        const g = normalizeGrant(u.agents?.[a.local_part] || blankGrant());
                        const rowBusy = busy === `${u.id}:${a.local_part}`;
                        return (
                          <li key={u.id} className="flex items-start justify-between gap-3 py-2.5">
                            <label className="flex items-start gap-2 min-w-0">
                              <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={g.enabled}
                                disabled={rowBusy}
                                onChange={(e) => void saveGrant(u, a.local_part, { ...g, enabled: e.target.checked })}
                              />
                              <span className="min-w-0">
                                <span className="block text-[13px] font-medium" style={{ color: "var(--mc-text)" }}>
                                  {u.first_name} {u.last_name}
                                </span>
                                <span className="block text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>{u.email}</span>
                              </span>
                            </label>
                            <div className="flex flex-wrap gap-1 justify-end" style={{ opacity: g.enabled ? 1 : 0.4, pointerEvents: g.enabled && !rowBusy ? "auto" : "none" }}>
                              {(["ask", "custom", "all"] as GrantMode[]).map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  style={chip(g.mode === m)}
                                  onClick={() => void saveGrant(u, a.local_part, applyMode(g, m))}
                                >
                                  {m === "ask" ? "Questions" : m === "all" ? "All" : "Custom"}
                                </button>
                              ))}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function selectAll(u: AgentUser, agents: AgentInfo[], on: boolean, set: (u: AgentUser) => void) {
  const agentsMap = { ...u.agents };
  for (const a of agents) {
    agentsMap[a.local_part] = { ...(agentsMap[a.local_part] || blankGrant()), enabled: on };
  }
  set({ ...u, agents: agentsMap });
}

function setAllMode(u: AgentUser, agents: AgentInfo[], mode: GrantMode, set: (u: AgentUser) => void) {
  const agentsMap = { ...u.agents };
  for (const a of agents) {
    const g = agentsMap[a.local_part] || blankGrant();
    if (!g.enabled) continue;
    agentsMap[a.local_part] = applyMode(g, mode);
  }
  set({ ...u, agents: agentsMap });
}

function applyMode(g: Grant, mode: GrantMode): Grant {
  if (mode === "ask") return { ...g, mode, perms: { read: true, write: false, update: false, delete: false } };
  if (mode === "all") return { ...g, mode, perms: { read: true, write: true, update: true, delete: true } };
  return { ...g, mode: "custom", perms: { ...g.perms, write: true, update: false, delete: false, read: true } };
}

function AgentRow({
  agent,
  grant,
  onChange,
}: {
  agent: AgentInfo;
  grant: Grant;
  onChange: (g: Grant) => void;
}) {
  const live = previewFromGrant(grant);
  return (
    <div className="rounded-lg p-2.5" style={{ border: "1px solid var(--mc-border)" }}>
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
          <input
            type="checkbox"
            checked={grant.enabled}
            onChange={(e) => onChange({ ...grant, enabled: e.target.checked })}
          />
          {agent.display_name}
        </label>
        <div className="flex flex-wrap gap-1" style={{ opacity: grant.enabled ? 1 : 0.45, pointerEvents: grant.enabled ? "auto" : "none" }}>
          {(["ask", "custom", "all"] as GrantMode[]).map((m) => (
            <button key={m} style={chip(grant.mode === m)} onClick={() => onChange(applyMode(grant, m))}>
              {m === "ask" ? "Questions only" : m === "all" ? "All" : "Custom"}
            </button>
          ))}
        </div>
      </div>
      {grant.enabled && grant.mode !== "ask" && (
        <div className="flex flex-wrap gap-1 mt-2">
          {(["read", "write", "update", "delete"] as const).map((k) => (
            <button
              key={k}
              style={chip(!!grant.perms[k])}
              onClick={() => {
                const perms = { ...grant.perms, [k]: !grant.perms[k] };
                let mode: GrantMode = "custom";
                if (perms.read && perms.write && perms.update && perms.delete) mode = "all";
                if (!perms.write && !perms.update && !perms.delete) mode = "ask";
                onChange({ ...grant, mode, perms });
              }}
            >
              {k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
      )}
      <div className="text-[10px] font-semibold mt-2 uppercase tracking-wide" style={{ color: "var(--mc-text-faint)" }}>
        What Grok sees (hidden from the sender)
      </div>
      <pre className="am-pre">{live.prompt}</pre>
      <div className="text-[11px] mt-1 break-all" style={{ color: "var(--mc-text-muted)" }}>{live.flags}</div>
    </div>
  );
}

