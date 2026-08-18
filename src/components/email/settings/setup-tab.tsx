"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import type { SettingsTab } from "@/lib/settings";
import type { EmailDomain } from "../email-layout";

type Path = "mail" | "machine" | "box" | "chat";
type Step = "welcome" | "path" | "database" | "mail" | "domain" | "signin" | "hands" | "extras" | "done";
type Tile = { id: string; ok: boolean; configured: boolean; detail: string };

const PATHS: Array<{ id: Path; title: string; body: string }> = [
  {
    id: "mail",
    title: "Mail only",
    body: "Read and send email in the browser. No agents.",
  },
  {
    id: "machine",
    title: "Mail + agents on this computer",
    body: "A worker on your Mac or Linux box answers a.* mail and can edit folders you allow.",
  },
  {
    id: "box",
    title: "Mail + agents on a cloud box",
    body: "Same worker in Docker on a machine that stays on. Use this if your laptop sleeps.",
  },
  {
    id: "chat",
    title: "Mail + agents, questions in the cloud",
    body: "When the worker is off, Grok can still answer questions. It cannot edit files until a worker is online.",
  },
];

const TILE_META: Record<string, { label: string; required: (p: Path) => boolean; optional?: boolean }> = {
  supabase: { label: "Database", required: () => true },
  migrations: { label: "Tables", required: () => true },
  resend: { label: "Resend", required: () => true },
  inbound: { label: "Inbound webhook", required: () => true },
  cloudflare: { label: "Cloudflare DNS", required: () => false, optional: true },
  domain: { label: "Domain", required: () => true },
  auth: { label: "Sign-in", required: () => true },
  push: { label: "Web push", required: () => false, optional: true },
  junk: { label: "Junk LLM", required: () => false, optional: true },
  machine: { label: "This computer", required: (p) => p === "machine" },
  box: { label: "Cloud box", required: (p) => p === "box" },
  chat: { label: "Cloud questions", required: (p) => p === "chat" },
};

const SETUP_KEY = "email.stack-setup";

function loadSetup(): { path: Path | null; done: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(SETUP_KEY) || "{}") as { path?: Path; done?: boolean };
    return { path: raw.path || null, done: !!raw.done };
  } catch {
    return { path: null, done: false };
  }
}

function saveSetup(next: { path: Path | null; done: boolean }) {
  localStorage.setItem(SETUP_KEY, JSON.stringify(next));
}

function tile(tiles: Tile[], id: string): Tile | undefined {
  return tiles.find((t) => t.id === id);
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
  const [step, setStep] = useState<Step>(saved.done ? "done" : "welcome");
  const [path, setPath] = useState<Path | null>(saved.path);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const inboundUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api/email/inbound` : "https://YOUR_PAGES_URL/api/email/inbound";

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch("/api/email/agent-setup");
      const data = await res.json();
      if (res.ok) setTiles(data.tiles || []);
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 12000);
    return () => clearInterval(t);
  }, [refresh]);

  const picked = PATHS.find((p) => p.id === path);
  const wantsAgents = path === "machine" || path === "box" || path === "chat";

  const remaining = useMemo(() => {
    if (!path) return tiles.filter((t) => TILE_META[t.id]?.required("mail") && !t.ok);
    return tiles.filter((t) => {
      const meta = TILE_META[t.id];
      if (!meta) return false;
      if (meta.optional) return false;
      return meta.required(path) && !t.ok;
    });
  }, [tiles, path]);

  function goNext(from: Step) {
    if (from === "welcome") return setStep("path");
    if (from === "path") return setStep("database");
    if (from === "database") return setStep("mail");
    if (from === "mail") return setStep("domain");
    if (from === "domain") return setStep("signin");
    if (from === "signin") return setStep(wantsAgents ? "hands" : "extras");
    if (from === "hands") return setStep("extras");
    saveSetup({ path, done: true });
    setStep("done");
  }

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden space-y-4">
      {step === "welcome" && (
        <Block title="Set up this mail app">
          <p>
            Clone it, fill a few keys, and this walkthrough tells you only what you need — mail only, or mail plus agents on this computer, a cloud box, or cloud questions.
          </p>
          <p>
            Nothing here is locked. Skip a step, come back, change how you run it later. Green tiles mean that piece is connected.
          </p>
          <button className="am-btn" onClick={() => goNext("welcome")}>Get started</button>
        </Block>
      )}

      {step === "path" && (
        <Block title="How will you run it?">
          <div className="grid gap-2">
            {PATHS.map((p) => (
              <Choice key={p.id} on={path === p.id} title={p.title} body={p.body} onClick={() => setPath(p.id)} />
            ))}
          </div>
          <Nav back={() => setStep("welcome")} next={() => goNext("path")} nextOff={!path} />
        </Block>
      )}

      {step === "database" && (
        <Block title="Database (Supabase)">
          <p>One free Supabase project holds mail, people, and agent grants. Create a project, then paste the URL and service role key into your env.</p>
          <Code>{`# .env.local and Pages Functions secrets
SUPABASE_URL=https://YOUR_REF.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
NEXT_PUBLIC_SUPABASE_URL=  # same URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=`}</Code>
          <p>Then run every file in <code>migrations/</code> in the Supabase SQL editor (top to bottom is fine).</p>
          <Status tiles={tiles} ids={["supabase", "migrations"]} />
          <Nav back={() => setStep("path")} next={() => goNext("database")} />
        </Block>
      )}

      {step === "mail" && (
        <Block title="Send and receive (Resend)">
          <p>Resend sends mail and receives it. Create an API key, then point inbound at this app.</p>
          <Code>{`RESEND_API_KEY=re_...

# Resend dashboard → Webhooks → add
${inboundUrl}
# events: email.received, email.sent`}</Code>
          <p>Local dev uses a tunnel or the deployed Pages URL — Resend cannot POST to localhost.</p>
          <Status tiles={tiles} ids={["resend", "inbound"]} />
          <Nav back={() => setStep("database")} next={() => goNext("mail")} />
        </Block>
      )}

      {step === "domain" && (
        <Block title="Your domain">
          <p>Add the domain you want mail on. If the domain is on Cloudflare and you set a token, we write MX/SPF/DKIM for you. Otherwise add the records Resend shows.</p>
          <Code>{`CLOUDFLARE_API_TOKEN=   # optional, Zone + DNS
CLOUDFLARE_ACCOUNT_ID=  # optional`}</Code>
          <Status tiles={tiles} ids={["cloudflare", "domain"]} />
          <div className="flex flex-wrap gap-2">
            <button className="am-ghost" type="button" onClick={() => onOpenTab("accounts")}>Open Accounts</button>
            <button className="am-ghost" type="button" onClick={() => void refresh()}>Recheck</button>
          </div>
          <Nav back={() => setStep("mail")} next={() => goNext("domain")} />
        </Block>
      )}

      {step === "signin" && (
        <Block title="Sign-in">
          <p>This is a single-owner app. Set the email and password you will type at the login screen, plus a shared API secret (same value on the server and in NEXT_PUBLIC_).</p>
          <Code>{`MC_API_SECRET=long-random-string
NEXT_PUBLIC_MC_API_SECRET=long-random-string   # same value
NEXT_PUBLIC_OWNER_EMAIL=you@example.com
NEXT_PUBLIC_OWNER_PASSWORD=...`}</Code>
          <p>Rebuild the frontend after changing NEXT_PUBLIC_* — those are baked in at build time.</p>
          <Status tiles={tiles} ids={["auth"]} />
          <Nav back={() => setStep("domain")} next={() => goNext("signin")} />
        </Block>
      )}

      {step === "hands" && path === "machine" && (
        <Block title="This computer (agent worker)">
          <p>The browser cannot run Grok on your files. A small worker on this machine polls mail and does the work.</p>
          <Code>{`./scripts/install-local-worker.sh          # Mac
# ./scripts/install-local-worker-linux.sh  # Linux

# script copies worker/config.env.example if missing:
#   ~/Library/AgentMail/config.env   (Mac)
#   ~/.local/share/agentmail/config.env
# fill SUPABASE_*, RESEND_API_KEY, GROK_BIN
# optional WORKSPACE_ROOT=~/Documents
# optional ~/Library/AgentMail/workspaces.json  →  { "a.dev": "~/src/my-app" }`}</Code>
          <p>Leave the computer awake when you want agents to run. Create mailboxes under the Agents tab — the worker reads them from the database. Only add workspaces.json if a mailbox should open a folder that is not WORKSPACE_ROOT/name.</p>
          <Status tiles={tiles} ids={["machine"]} />
          <Nav back={() => setStep("signin")} next={() => goNext("hands")} />
        </Block>
      )}

      {step === "hands" && path === "box" && (
        <Block title="Cloud box (agent worker)">
          <p>Same worker, in Docker, on a box that stays on. Privileged — treat keys like production. Do not expose it to the public internet.</p>
          <Code>{`cd worker
docker build -t agentmail-box .
# see worker/BOX.md and worker/fly.toml
# env: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, AGENT_MAIL_DOMAIN`}</Code>
          <p>This tile turns green when the box heartbeats. Agents themselves are created on the Agents tab.</p>
          <Status tiles={tiles} ids={["box"]} />
          <Nav back={() => setStep("signin")} next={() => goNext("hands")} />
        </Block>
      )}

      {step === "hands" && path === "chat" && (
        <Block title="Cloud questions">
          <p>If the worker is offline, questions-only senders still get a reply. No file tools. Code asks wait for This computer or Cloud box.</p>
          <Code>{`XAI_API_KEY=xai-...   # Pages Functions secret`}</Code>
          <Status tiles={tiles} ids={["chat"]} />
          <Nav back={() => setStep("signin")} next={() => goNext("hands")} />
        </Block>
      )}

      {step === "extras" && (
        <Block title="Optional extras">
          <p>Skip these if you want. Turn them on later.</p>
          <p><span className="font-semibold">Web push</span> — alerts when mail arrives and the tab is closed.</p>
          <Code>{`npx web-push generate-vapid-keys --json
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
NEXT_PUBLIC_VAPID_PUBLIC_KEY=   # same public key`}</Code>
          <p><span className="font-semibold">Junk assist</span> — optional OpenRouter key for smarter spam. Heuristics work without it.</p>
          <Code>{`OPENROUTER_KEY=`}</Code>
          <Status tiles={tiles} ids={["push", "junk"]} />
          <Nav back={() => setStep(wantsAgents ? "hands" : "signin")} next={() => goNext("extras")} nextLabel="Finish" />
        </Block>
      )}

      {step === "done" && (
        <Block title="Your setup">
          <p>
            {picked ? <>Running as <span className="font-semibold">{picked.title}</span>.</> : "Pick how you run it to filter these tiles."}
            {" "}Green is connected. You can change the path any time.
          </p>
          {remaining.length > 0 && (
            <p>Still needed: {remaining.map((t) => TILE_META[t.id]?.label || t.id).join(", ")}.</p>
          )}
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {tiles.filter((t) => {
              if (!path) return true;
              const meta = TILE_META[t.id];
              if (!meta) return true;
              return meta.required(path) || meta.optional || t.ok || t.configured;
            }).map((t) => (
              <div key={t.id} className="rounded-[12px] p-3 min-w-0" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold truncate" style={{ color: "var(--mc-text)" }}>
                    {TILE_META[t.id]?.label || t.id}
                  </span>
                  {t.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                  ) : (
                    <span className="text-[10px] font-bold" style={{ color: TILE_META[t.id]?.optional ? "var(--mc-text-faint)" : "#dc2626" }}>
                      {TILE_META[t.id]?.optional ? "Optional" : "Off"}
                    </span>
                  )}
                </div>
                <div className="text-[11px] mt-1 break-words" style={{ color: "var(--mc-text-muted)" }}>{t.detail}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="am-ghost" type="button" onClick={() => { saveSetup({ path, done: false }); setStep("path"); }}>
              Change how it runs
            </button>
            <button className="am-ghost" type="button" onClick={() => onOpenTab("accounts")}>Accounts</button>
            {wantsAgents && (
              <button className="am-btn" type="button" onClick={() => onOpenTab("agents")}>Set up agents</button>
            )}
            <button className="am-ghost" type="button" onClick={() => onOpenTab("howto")}>How it works</button>
            <button className="am-ghost" type="button" onClick={() => { void refresh(); onRefreshDomains(); }}>Recheck</button>
          </div>
        </Block>
      )}

      <style>{SETUP_CSS}</style>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 min-w-0">
      <h3 className="text-[15px] font-semibold" style={{ color: "var(--mc-text)" }}>{title}</h3>
      <div className="space-y-3 text-[13px] leading-5" style={{ color: "var(--mc-text-muted)" }}>{children}</div>
    </div>
  );
}

function Choice({ on, title, body, onClick }: { on: boolean; title: string; body: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-[12px] p-3"
      style={{
        border: `1px solid ${on ? "var(--mc-accent)" : "var(--mc-border)"}`,
        backgroundColor: on ? "var(--mc-bg-active)" : "var(--mc-bg-tertiary)",
      }}
    >
      <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>{title}</div>
      <div className="text-[12px] leading-5" style={{ color: "var(--mc-text-muted)" }}>{body}</div>
    </button>
  );
}

function Nav({
  back,
  next,
  nextOff,
  nextLabel = "Continue",
}: {
  back: () => void;
  next: () => void;
  nextOff?: boolean;
  nextLabel?: string;
}) {
  return (
    <div className="flex gap-2 pt-1">
      <button className="am-ghost" type="button" onClick={back}>Back</button>
      <button className="am-btn" type="button" disabled={nextOff} onClick={next}>{nextLabel}</button>
    </div>
  );
}

function Status({ tiles, ids }: { tiles: Tile[]; ids: string[] }) {
  return (
    <ul className="space-y-1">
      {ids.map((id) => {
        const t = tile(tiles, id);
        const ok = t?.ok;
        return (
          <li key={id} className="flex items-start gap-2 text-[12px]">
            {ok ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
            ) : (
              <span className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 rounded-full border" style={{ borderColor: "var(--mc-border)" }} />
            )}
            <span className="min-w-0 break-words" style={{ color: "var(--mc-text)" }}>
              {TILE_META[id]?.label || id}
              {t?.detail ? <span style={{ color: "var(--mc-text-muted)" }}> — {t.detail}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="am-setup-pre">{children}</pre>;
}

const SETUP_CSS = `
  .am-btn { border:0; border-radius:8px; padding:7px 12px; background:var(--mc-accent); color:#fff; font-weight:600; font-size:13px; }
  .am-ghost { background:transparent; color:var(--mc-text); border:1px solid var(--mc-border); border-radius:8px; padding:4px 9px; font-size:12px; }
  .am-setup-pre { margin:0; padding:10px 12px; border-radius:10px; background:#111827; color:#e5e7eb; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; overflow-x:hidden; max-width:100%; }
`;
