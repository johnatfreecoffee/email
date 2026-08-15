"use client";

import { Bot } from "lucide-react";
import { howItWorks } from "@/lib/agent-access";

export function HowToTab() {
  const how = howItWorks();
  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <p className="text-[13px] mb-3 leading-5" style={{ color: "var(--mc-text-muted)" }}>
        This app is your mail. Settings → Setup walks every integration (database, Resend, domain, sign-in, worker). Agents are optional mailboxes on top.
      </p>
      <p className="text-[13px] mb-4 leading-5" style={{ color: "var(--mc-text-muted)" }}>
        An agent is just a mailbox. Someone emails it. If they are allowed, Grok answers. If they are not, nothing happens.
      </p>

      <h3 className="text-[13px] font-semibold mb-2" style={{ color: "var(--mc-text)" }}>The flow</h3>
      <div className="grid gap-2 mb-5">
        {how.flow.map((s) => (
          <div key={s.n} className="flex gap-3 rounded-[10px] p-3 min-w-0" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
            <div
              className="h-6 w-6 rounded-full flex items-center justify-center text-[12px] font-bold text-white flex-shrink-0"
              style={{ backgroundColor: "var(--mc-accent)" }}
            >
              {s.n}
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>{s.title}</div>
              <div className="text-[12px] leading-5" style={{ color: "var(--mc-text-muted)" }}>{s.body}</div>
            </div>
          </div>
        ))}
      </div>

      <h3 className="text-[13px] font-semibold mb-2" style={{ color: "var(--mc-text)" }}>When Grok never starts</h3>
      <div className="grid gap-2 mb-5 sm:grid-cols-3">
        {how.stops.map((s) => (
          <div key={s.id} className="rounded-[10px] p-3 min-w-0" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
            <div className="text-[11px] font-bold mb-1" style={{ color: "#dc2626" }}>Grok does not run</div>
            <div className="text-[13px] font-semibold mb-1" style={{ color: "var(--mc-text)" }}>{s.title}</div>
            <p className="text-[12px] leading-5 break-words" style={{ color: "var(--mc-text-muted)" }}>{s.reply}</p>
          </div>
        ))}
      </div>

      <h3 className="text-[13px] font-semibold mb-2" style={{ color: "var(--mc-text)" }}>What Grok is told (hidden from the sender)</h3>
      <div className="grid gap-3">
        {([
          ["Questions only", how.previews.ask],
          ["Custom (read + write)", how.previews.custom],
          ["All", how.previews.all],
        ] as const).map(([title, p]) => (
          <div key={title} className="rounded-[10px] p-3 min-w-0" style={{ backgroundColor: "var(--mc-bg-tertiary)" }}>
            <div className="flex items-center gap-2 mb-1">
              <Bot className="h-4 w-4 flex-shrink-0" style={{ color: "var(--mc-accent)" }} />
              <span className="text-[13px] font-semibold" style={{ color: "var(--mc-text)" }}>{title}</span>
            </div>
            <pre className="am-howto-pre">{p.prompt}</pre>
            <div className="text-[11px] mt-1 break-all" style={{ color: "var(--mc-text-muted)" }}>{p.flags}</div>
          </div>
        ))}
      </div>
      <style>{`
        .am-howto-pre {
          margin: 8px 0 0;
          padding: 10px 12px;
          border-radius: 10px;
          background: #111827;
          color: #e5e7eb;
          font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: break-word;
          overflow-x: hidden;
          max-width: 100%;
          max-height: 220px;
          overflow-y: auto;
        }
      `}</style>
    </div>
  );
}
