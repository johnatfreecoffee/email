"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import type { SettingsTab } from "@/lib/settings";
import type { EmailDomain } from "../email-layout";

type Hands = "machine" | "box" | "chat";
type Tile = { id: string; ok: boolean; configured: boolean; detail: string };

const HANDS: Array<{ id: Hands; title: string; body: string; next: string }> = [
  {
    id: "machine",
    title: "This computer",
    body: "A small worker on your Mac or Linux box. It can read and edit project folders when you allow it.",
    next: "Install the worker, then leave this computer on when you want them to work.",
  },
  {
    id: "box",
    title: "Cloud box",
    body: "Same worker, in Docker, on a machine that stays on. Good if your laptop sleeps.",
    next: "See worker/BOX.md. Same allowlist as this computer.",
  },
  {
    id: "chat",
    title: "Questions only (cloud)",
    body: "Replies when your computer is off. Cannot edit files. Needs an xAI key on the email app.",
    next: "Set XAI_API_KEY on the Pages project. Code changes wait until This computer or Cloud box is online.",
  },
];

const TILE_LABEL: Record<string, string> = {
  resend: "Mail sending",
  supabase: "Database",
  cloudflare: "DNS helper",
  domain: "Your domain",
  machine: "This computer",
  chat: "Cloud questions",
  box: "Cloud box",
};

const SETUP_KEY = "email.agent-setup";

function loadSetup(): { hands: Hands | null; done: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(SETUP_KEY) || "{}") as { hands?: Hands; done?: boolean };
    return { hands: raw.hands || null, done: !!raw.done };
  } catch {
    return { hands: null, done: false };
  }
}

function saveSetup(next: { hands: Hands | null; done: boolean }) {
  localStorage.setItem(SETUP_KEY, JSON.stringify(next));
}

export function SetupTab({
  domains,
  onOpenTab,
  onRefreshDomains,
}: {
  domains: EmailDomain[];
  onOpenTab: (tab: SettingsTab) => void;
  onRefreshDomains: () => void;
}) {
  const saved = loadSetup();
  const [step, setStep] = useState(saved.done ? 5 : 0);
  const [hands, setHands] = useState<Hands | null>(saved.hands);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; mailbox: string; display_name: string }>>([]);
  const [domainId, setDomainId] = useState(domains[0]?.id || "");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        apiFetch("/api/email/agent-setup"),
        apiFetch("/api/email/agent-mailboxes"),
      ]);
      const sd = await s.json();
      const ad = await a.json();
      if (s.ok) setTiles(sd.tiles || []);
      if (a.ok) setAgents(ad.agents || []);
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!domainId && domains[0]?.id) setDomainId(domains[0].id);
  }, [domains, domainId]);

  const domainOk = tiles.find((t) => t.id === "domain")?.ok;
  const machineOk = tiles.find((t) => t.id === "machine")?.ok;
  const chatOk = tiles.find((t) => t.id === "chat")?.ok;
  const boxOk = tiles.find((t) => t.id === "box")?.ok;

  async function createFirst() {
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
      setAgents(data.agents || []);
      onRefreshDomains();
      setStep(4);
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    saveSetup({ hands, done: true });
    setStep(5);
  }

  const picked = HANDS.find((h) => h.id === hands);

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden space-y-4">
      {step === 0 && (
        <div className="space-y-3">
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>Set up email agents</h3>
          <p className="text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>
            An agent is a mailbox like <span className="font-medium">a.marketing@yourdomain</span>. People you allow can email it. Grok answers. Everyone else is ignored.
          </p>
          <p className="text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>
            This walkthrough picks how they run. You can change it any time.
          </p>
          <button className="am-btn" onClick={() => setStep(1)}>Get started</button>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>How should they work?</h3>
          <div className="grid gap-2">
            {HANDS.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => setHands(h.id)}
                className="text-left rounded-[12px] p-3"
                style={{
                  border: `1px solid ${hands === h.id ? "var(--mc-accent)" : "var(--mc-border)"}`,
                  backgroundColor: hands === h.id ? "var(--mc-bg-active)" : "var(--mc-bg-tertiary)",
                }}
              >
                <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>{h.title}</div>
                <div className="text-[12px] leading-5" style={{ color: "var(--mc-text-muted)" }}>{h.body}</div>
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button className="am-ghost" onClick={() => setStep(0)}>Back</button>
            <button className="am-btn" disabled={!hands} onClick={() => setStep(2)}>Continue</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>Which domain?</h3>
          <p className="text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>
            Agents live on a domain you already receive mail on. {domainOk ? "You have one." : "Add one in Accounts first."}
          </p>
          {domains.length ? (
            <select className="am-in" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>{d.domain}</option>
              ))}
            </select>
          ) : (
            <button className="am-btn" onClick={() => onOpenTab("accounts")}>Add a domain</button>
          )}
          <div className="flex gap-2">
            <button className="am-ghost" onClick={() => setStep(1)}>Back</button>
            <button className="am-btn" disabled={!domainId} onClick={() => setStep(agents.length ? 4 : 3)}>Continue</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>Create your first agent</h3>
          <p className="text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>
            Name is what you see. Short id becomes the mailbox: a.marketing@yourdomain.
          </p>
          <input className="am-in" placeholder="Name — Marketing" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            className="am-in"
            placeholder="Short id — marketing  (we add a.)"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
          />
          {err && <p className="text-[12px]" style={{ color: "#dc2626" }}>{err}</p>}
          <div className="flex gap-2">
            <button className="am-ghost" onClick={() => setStep(2)}>Back</button>
            <button className="am-btn" disabled={busy} onClick={() => void createFirst()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create agent"}
            </button>
            <button className="am-ghost" onClick={() => setStep(4)}>Skip for now</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-3">
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>Who can email them?</h3>
          <p className="text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>
            Only people on Users can write an agent. Anyone else is ignored — Grok never starts. Add people on the Agents tab.
          </p>
          {picked && (
            <div className="rounded-[10px] p-3 text-[12px] leading-5" style={{ backgroundColor: "var(--mc-bg-tertiary)", color: "var(--mc-text-muted)" }}>
              <span className="font-semibold" style={{ color: "var(--mc-text)" }}>{picked.title}.</span> {picked.next}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button className="am-ghost" onClick={() => setStep(3)}>Back</button>
            <button className="am-btn" onClick={finish}>Finish</button>
            <button className="am-ghost" onClick={() => onOpenTab("agents")}>Open Agents</button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="space-y-3">
          <h3 className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>Your setup</h3>
          <p className="text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>
            Change this any time. Green means that piece is connected.
          </p>
          {picked && (
            <p className="text-[13px] leading-5" style={{ color: "var(--mc-text)" }}>
              Running as <span className="font-semibold">{picked.title}</span>. {picked.next}
            </p>
          )}
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {tiles.map((t) => (
              <div key={t.id} className="rounded-[12px] p-3 min-w-0" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold truncate" style={{ color: "var(--mc-text)" }}>
                    {TILE_LABEL[t.id] || t.id}
                  </span>
                  {t.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                  ) : (
                    <span className="text-[10px] font-bold" style={{ color: "#dc2626" }}>Off</span>
                  )}
                </div>
                <div className="text-[11px] mt-1 break-words" style={{ color: "var(--mc-text-muted)" }}>{t.detail}</div>
              </div>
            ))}
          </div>
          {hands === "machine" && !machineOk && (
            <pre className="am-howto-pre">./scripts/install-local-worker.sh{`\n`}# Linux: ./scripts/install-local-worker-linux.sh</pre>
          )}
          {hands === "chat" && !chatOk && (
            <p className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>Add XAI_API_KEY to the email-app Pages project.</p>
          )}
          {hands === "box" && !boxOk && (
            <p className="text-[12px]" style={{ color: "var(--mc-text-muted)" }}>Follow worker/BOX.md, then come back — this tile turns green when the box heartbeats.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button className="am-ghost" onClick={() => { saveSetup({ hands, done: false }); setStep(1); }}>Change how they run</button>
            <button className="am-btn" onClick={() => onOpenTab("agents")}>Create or edit agents</button>
            <button className="am-ghost" onClick={() => onOpenTab("howto")}>How it works</button>
          </div>
        </div>
      )}

      <style>{`
        .am-in { width:100%; border:1px solid var(--mc-border); background:var(--mc-bg); color:var(--mc-text); border-radius:8px; padding:7px 10px; font-size:13px; outline:none; }
        .am-btn { border:0; border-radius:8px; padding:7px 12px; background:var(--mc-accent); color:#fff; font-weight:600; font-size:13px; }
        .am-ghost { background:transparent; color:var(--mc-text); border:1px solid var(--mc-border); border-radius:8px; padding:4px 9px; font-size:12px; }
        .am-howto-pre { margin:0; padding:10px 12px; border-radius:10px; background:#111827; color:#e5e7eb; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; overflow-x:hidden; }
      `}</style>
    </div>
  );
}
