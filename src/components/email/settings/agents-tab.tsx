"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import {
  type Grant,
  type GrantMode,
  blankGrant,
  howItWorks,
  normalizeGrant,
  previewFromGrant,
} from "@/lib/agent-access";

interface AgentInfo {
  local_part: string;
  display_name: string;
}

interface AgentUser {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  archived: boolean;
  agents: Record<string, Grant>;
}

type SubTab = "active" | "archived" | "how" | "setup";

const chip = (on: boolean): React.CSSProperties => ({
  border: `1px solid ${on ? "var(--mc-accent)" : "var(--mc-border)"}`,
  backgroundColor: on ? "var(--mc-bg-active)" : "transparent",
  color: on ? "var(--mc-accent)" : "var(--mc-text)",
  borderRadius: 999,
  padding: "3px 9px",
  fontSize: 12,
  fontWeight: on ? 600 : 500,
});

export function AgentsTab() {
  const [tab, setTab] = useState<SubTab>("active");
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

  const load = useCallback(async () => {
    if (tab === "how" || tab === "setup") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch(`/api/email/agent-users?tab=${tab === "archived" ? "archived" : "active"}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setUsers(data.users || []);
      setAgents(data.agents || []);
      setNeedsMigration(!!data.needs_migration);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  function draftFor(u: AgentUser): AgentUser {
    if (drafts[u.id]) return drafts[u.id];
    const agentsMap: Record<string, Grant> = {};
    for (const a of agents) agentsMap[a.local_part] = blankGrant();
    Object.assign(agentsMap, u.agents || {});
    for (const k of Object.keys(agentsMap)) agentsMap[k] = normalizeGrant(agentsMap[k]);
    return { ...u, agents: agentsMap };
  }

  function setDraft(id: string, next: AgentUser) {
    setDrafts((prev) => ({ ...prev, [id]: next }));
  }

  const shown = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return users.filter((u) => {
      const d = drafts[u.id] || u;
      const blob = `${d.first_name} ${d.last_name} ${d.email}`.toLowerCase();
      return !needle || blob.includes(needle);
    });
  }, [users, drafts, q]);

  async function addUser() {
    setNerr("");
    const agentsMap: Record<string, Grant> = {};
    for (const a of agents) agentsMap[a.local_part] = blankGrant();
    const res = await apiFetch("/api/email/agent-users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ first_name: nfirst, last_name: nlast, email: nemail, agents: agentsMap }),
    });
    const data = await res.json();
    if (!res.ok) {
      setNerr(data.error || "failed");
      return;
    }
    setNfirst("");
    setNlast("");
    setNemail("");
    setUsers((prev) => [...prev, data.user]);
    setOpen((s) => new Set(s).add(data.user.id));
  }

  async function saveUser(id: string) {
    const d = drafts[id];
    if (!d) return;
    const res = await apiFetch(`/api/email/agent-users?id=${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(d),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "save failed");
      return;
    }
    setUsers((prev) => prev.map((u) => (u.id === id ? data.user : u)));
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function archiveOrRestore(id: string, action: "archive" | "restore") {
    await apiFetch(`/api/email/agent-users?id=${id}&action=${action}`, { method: "POST" });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    await load();
  }

  if (tab === "how") {
    return (
      <div>
        <SubTabs tab={tab} setTab={setTab} />
        <HowPanel />
      </div>
    );
  }

  if (tab === "setup") {
    return (
      <div>
        <SubTabs tab={tab} setTab={setTab} />
        <SetupPanel />
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
        <div className="mb-3 grid gap-2" style={{ gridTemplateColumns: "1fr 1fr 1.4fr auto" }}>
          <input className="am-in" placeholder="First" value={nfirst} onChange={(e) => setNfirst(e.target.value)} />
          <input className="am-in" placeholder="Last" value={nlast} onChange={(e) => setNlast(e.target.value)} />
          <input className="am-in" placeholder="email@example.com" value={nemail} onChange={(e) => setNemail(e.target.value)} />
          <button className="am-btn" onClick={addUser}>Add</button>
        </div>
      )}
      {nerr && <div className="text-[12px] mb-2" style={{ color: "#dc2626" }}>{nerr}</div>}
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
      ) : error ? (
        <div className="text-[13px]" style={{ color: "#dc2626" }}>{error}</div>
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
              onToggle={() => {
                const d = draftFor(u);
                setDrafts((prev) => (prev[u.id] ? prev : { ...prev, [u.id]: d }));
                setOpen((s) => {
                  const n = new Set(s);
                  if (n.has(u.id)) n.delete(u.id);
                  else n.add(u.id);
                  return n;
                });
              }}
              onChange={(next) => setDraft(u.id, next)}
              onSave={() => saveUser(u.id)}
              onArchive={() => archiveOrRestore(u.id, tab === "archived" ? "restore" : "archive")}
            />
          ))}
        </div>
      )}
      <style>{`
        .am-in { width:100%; border:1px solid var(--mc-border); background:var(--mc-bg); color:var(--mc-text); border-radius:8px; padding:7px 10px; font-size:13px; outline:none; }
        .am-btn { border:0; border-radius:8px; padding:7px 12px; background:var(--mc-accent); color:#fff; font-weight:600; font-size:13px; }
        .am-ghost { background:transparent; color:var(--mc-text); border:1px solid var(--mc-border); border-radius:8px; padding:4px 9px; font-size:12px; }
        .am-pre { margin:8px 0 0; padding:10px 12px; border-radius:10px; background:#111827; color:#e5e7eb; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; overflow:auto; max-height:220px; }
      `}</style>
    </div>
  );
}

function SubTabs({ tab, setTab }: { tab: SubTab; setTab: (t: SubTab) => void }) {
  const items: Array<[SubTab, string]> = [
    ["active", "Users"],
    ["archived", "Archive"],
    ["setup", "Setup"],
    ["how", "How it works"],
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
  onToggle,
  onChange,
  onSave,
  onArchive,
}: {
  u: AgentUser;
  agents: AgentInfo[];
  open: boolean;
  archived: boolean;
  onToggle: () => void;
  onChange: (u: AgentUser) => void;
  onSave: () => void;
  onArchive: () => void;
}) {
  return (
    <div className="rounded-[10px] overflow-hidden" style={{ border: "1px solid var(--mc-border)", backgroundColor: "var(--mc-bg-elevated)" }}>
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer" onClick={onToggle}>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>
            {u.first_name} {u.last_name}
          </div>
          <div className="text-[11px] truncate" style={{ color: "var(--mc-text-muted)" }}>{u.email}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: "var(--mc-bg-active)", color: "var(--mc-accent)" }}>
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
          <div className="grid gap-2 my-3" style={{ gridTemplateColumns: "1fr 1fr 1.4fr" }}>
            <input className="am-in" value={u.first_name} onChange={(e) => onChange({ ...u, first_name: e.target.value })} />
            <input className="am-in" value={u.last_name} onChange={(e) => onChange({ ...u, last_name: e.target.value })} />
            <input className="am-in" value={u.email} onChange={(e) => onChange({ ...u, email: e.target.value })} />
          </div>
          <div className="flex flex-wrap gap-2 mb-2">
            <button className="am-ghost" onClick={() => selectAll(u, agents, true, onChange)}>Select all agents</button>
            <button className="am-ghost" onClick={() => selectAll(u, agents, false, onChange)}>Deselect all</button>
            <button className="am-ghost" onClick={() => setAllMode(u, agents, "ask", onChange)}>All → questions only</button>
            <button className="am-ghost" onClick={() => setAllMode(u, agents, "all", onChange)}>All → full access</button>
          </div>
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
          <div className="flex justify-end mt-3">
            <button className="am-btn" onClick={onSave}>Save</button>
          </div>
        </div>
      )}
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
      <div className="text-[11px] mt-1" style={{ color: "var(--mc-text-muted)" }}>{live.flags}</div>
    </div>
  );
}

function SetupPanel() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch("/api/email/agent-runtime");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setOnline(!!data.online);
      setSeen(data.worker_seen_at || null);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const status = online === null ? "Checking…" : online ? "Online" : "Offline";
  const color = online === null ? "var(--mc-text-muted)" : online ? "#15803d" : "#dc2626";

  return (
    <div>
      <p className="text-[12px] mb-3" style={{ color: "var(--mc-text-muted)" }}>
        Hands run on a machine, not in the browser. Install the worker, then this tile turns green.
      </p>
      <div className="rounded-[12px] p-4" style={{ border: "1px solid var(--mc-border)", backgroundColor: "var(--mc-bg-tertiary)" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>This machine</div>
            <div className="text-[12px] mt-0.5" style={{ color: "var(--mc-text-muted)" }}>
              Local Grok worker. Can read and change project files.
            </div>
          </div>
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ color, border: `1px solid ${color}` }}>
            {status}
          </span>
        </div>
        <div className="text-[12px] mt-3" style={{ color: "var(--mc-text-muted)" }}>
          Last beat: {seen ? new Date(seen).toLocaleString() : "never"}
        </div>
        <pre className="am-pre mt-3">{`# from the email repo
./scripts/install-local-worker.sh     # Mac
./scripts/install-local-worker-linux.sh
./scripts/uninstall-local-worker.sh`}</pre>
        {err && <div className="text-[12px] mt-2" style={{ color: "#dc2626" }}>{err}</div>}
      </div>
      <p className="text-[11px] mt-3" style={{ color: "var(--mc-text-faint)" }}>
        Cloud chat and Cloud box tiles come in later phases. Offline here means no code-changing agent until the worker is back.
      </p>
    </div>
  );
}

function HowPanel() {
  const how = howItWorks();
  return (
    <div>
      <h3 className="text-[13px] font-semibold mb-2" style={{ color: "var(--mc-text)" }}>The flow</h3>
      <div className="grid gap-2 mb-4">
        {how.flow.map((s) => (
          <div key={s.n} className="flex gap-3 rounded-[10px] p-3" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
            <div className="h-6 w-6 rounded-full flex items-center justify-center text-[12px] font-bold text-white flex-shrink-0" style={{ backgroundColor: "var(--mc-accent)" }}>
              {s.n}
            </div>
            <div>
              <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>{s.title}</div>
              <div className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>{s.body}</div>
            </div>
          </div>
        ))}
      </div>
      <h3 className="text-[13px] font-semibold mb-2" style={{ color: "var(--mc-text)" }}>When it never hits Grok</h3>
      <div className="grid gap-2 mb-4 md:grid-cols-3">
        {how.stops.map((s) => (
          <div key={s.id} className="rounded-[10px] p-3" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
            <div className="text-[11px] font-bold mb-1" style={{ color: "#dc2626" }}>Grok does not run</div>
            <div className="text-[13px] font-semibold mb-1" style={{ color: "var(--mc-text)" }}>{s.title}</div>
            <pre className="am-pre">{s.reply}</pre>
          </div>
        ))}
      </div>
      <h3 className="text-[13px] font-semibold mb-2" style={{ color: "var(--mc-text)" }}>The actual pre-prompt Grok gets</h3>
      <div className="grid gap-3">
        {([
          ["Questions only", how.previews.ask],
          ["Custom (read + write)", how.previews.custom],
          ["All", how.previews.all],
        ] as const).map(([title, p]) => (
          <div key={title} className="rounded-[10px] p-3" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
            <div className="flex items-center gap-2 mb-1">
              <Bot className="h-4 w-4" style={{ color: "var(--mc-accent)" }} />
              <span className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>{title}</span>
            </div>
            <pre className="am-pre">{p.prompt}</pre>
            <div className="text-[11px] mt-1" style={{ color: "var(--mc-text-muted)" }}>{p.flags}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
