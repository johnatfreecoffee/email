#!/usr/bin/env python3
"""Agent Mail — poll a.*@ mail, run Grok Build jobs, reply with (ID: n - used/500K) subjects."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path.home() / "Library" / "AgentMail"
CONFIG = ROOT / "config.env"
AGENTS_JSON = ROOT / "agents.json"
STATE_DIR = ROOT / "state"
LOG_DIR = ROOT / "logs"
PROCESSED = STATE_DIR / "processed_ids.json"
SESSIONS = STATE_DIR / "sessions.json"
LOCK = STATE_DIR / "worker.lock"
LOG_FILE = LOG_DIR / "worker.log"

sys.path.insert(0, str(ROOT / "bin"))
try:
    import access
except ImportError:
    access = None  # type: ignore

CONTEXT_MAX_K = 500  # display denominator
ID_RE = re.compile(r"\(ID:\s*(\d+)(?:\s*-\s*[^)]*)?\)", re.I)
ID_ONLY_RE = re.compile(r"\bID:\s*(\d+)\b", re.I)

STATE_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_config() -> dict[str, str]:
    cfg: dict[str, str] = {}
    if not CONFIG.exists():
        raise SystemExit(f"missing {CONFIG}")
    for line in CONFIG.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg


def curl_json(method: str, url: str, headers: dict[str, str], body: dict | None = None) -> tuple[int, object]:
    cmd = ["/usr/bin/curl", "-sS", "-X", method, url, "-w", "\n%{http_code}"]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"curl failed: {r.stderr.strip()}")
    out = r.stdout.rstrip("\n")
    if "\n" not in out:
        return 0, out
    body_s, code_s = out.rsplit("\n", 1)
    try:
        code = int(code_s)
    except ValueError:
        code = 0
    if not body_s:
        return code, None
    try:
        return code, json.loads(body_s)
    except json.JSONDecodeError:
        return code, body_s


def load_processed() -> set[str]:
    if not PROCESSED.exists():
        return set()
    try:
        return set(json.loads(PROCESSED.read_text()))
    except Exception:
        return set()


def save_processed(ids: set[str]) -> None:
    lst = sorted(ids)[-5000:]
    PROCESSED.write_text(json.dumps(lst))


def load_sessions() -> dict:
    if not SESSIONS.exists():
        return {"next_id": 1, "by_id": {}}
    try:
        data = json.loads(SESSIONS.read_text())
        data.setdefault("next_id", 1)
        data.setdefault("by_id", {})
        return data
    except Exception:
        return {"next_id": 1, "by_id": {}}


def save_sessions(data: dict) -> None:
    SESSIONS.write_text(json.dumps(data, indent=2) + "\n")


def load_agents() -> dict:
    return json.loads(AGENTS_JSON.read_text())


def by_local(agents: dict) -> dict[str, dict]:
    return {a["local_part"]: a for a in agents["agents"]}


def trusted(from_addr: str, patterns: list[str]) -> bool:
    fa = (from_addr or "").lower()
    if not fa:
        return False
    for p in patterns:
        p = p.lower().strip()
        if not p:
            continue
        if p.startswith("@") and fa.endswith(p):
            return True
        if p in fa:
            return True
    return False


def extract_local(to_field) -> str | None:
    if to_field is None:
        return None
    items = to_field if isinstance(to_field, list) else [to_field]
    for item in items:
        if isinstance(item, dict):
            addr = item.get("email") or item.get("address") or item.get("addr") or ""
        else:
            addr = str(item)
        m = re.search(r"([a-z0-9._+-]+)@freecoffee\.dev", addr, re.I)
        if not m:
            continue
        local = m.group(1).lower()
        # Agent mailboxes: a.* (classic) + e.* (email-first identities, e.g. e.grokdesk)
        if local.startswith("a.") or local.startswith("e."):
            return local
    return None


def plain_text(msg: dict) -> str:
    t = msg.get("body_text") or ""
    if t.strip():
        return t.strip()
    html = msg.get("body_html") or ""
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def strip_id_tag(subject: str) -> str:
    s = ID_RE.sub("", subject or "")
    s = re.sub(r"\s{2,}", " ", s).strip()
    s = re.sub(r"\s+$", "", s)
    return s


def parse_session_id(subject: str) -> int | None:
    if not subject:
        return None
    m = ID_RE.search(subject) or ID_ONLY_RE.search(subject)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def base_subject(subject: str) -> str:
    s = strip_id_tag(subject or "")
    # collapse Re: Re:
    while True:
        n = re.sub(r"^(re|fwd|fw)\s*:\s*", "", s, flags=re.I).strip()
        if n == s:
            break
        s = n
    return s or "(no subject)"


def format_reply_subject(base: str, session_id: int, used_k: int) -> str:
    used_k = max(1, min(int(used_k), CONTEXT_MAX_K))
    return f"Re: {base} (ID: {session_id} - {used_k}/{CONTEXT_MAX_K}K)"


def tokens_to_used_k(used_tokens: int) -> int:
    """Convert accumulated token estimate → subject numerator (K)."""
    import math

    return max(1, min(CONTEXT_MAX_K, int(math.ceil(max(0, int(used_tokens)) / 1000.0))))


def estimate_turn_tokens(
    prompt: str,
    stdout: str,
    stderr: str,
    *,
    duration_s: float,
    timed_out: bool,
) -> int:
    """Estimate tokens burned THIS Grok Build turn.

    Email history alone is tiny (a few hundred tokens), so a naive char count
    of stored reply text stays stuck at 2–3/500K. Real cost is the agent loop
    (system + tools + file reads) which we don't persist — approximate it from
    wall-clock + prompt/output size. Monotonic accumulation lives on the
    session record (used_tokens), not re-derived from history each time.
    """
    text = f"{prompt or ''}{stdout or ''}{stderr or ''}"
    text_tokens = max(0, int(len(text) / 3.0))
    # Tool-loop baseline + ~2.5k tokens per minute of agent wall time
    wall = max(0.0, float(duration_s or 0.0))
    tool_tokens = 12_000 + int(wall * 2_500)
    # Timed-out runs almost always burned a large window — floor so the
    # subject actually advances instead of looking frozen.
    if timed_out:
        tool_tokens = max(tool_tokens, 60_000)
    # Floor so even a quick "ok" turn shows non-trivial progress
    return max(text_tokens + tool_tokens, 3_000)


def estimate_used_k(history: list[dict], prev_used_k: int = 1, used_tokens: int | None = None) -> int:
    """Prefer cumulative used_tokens; fall back to history-only for old sessions."""
    if used_tokens is not None and int(used_tokens) > 0:
        return max(tokens_to_used_k(int(used_tokens)), int(prev_used_k or 1))

    import math

    total_chars = 0
    user_turns = 0
    for h in history:
        total_chars += len(str(h.get("role", ""))) + len(str(h.get("text", "")))
        if str(h.get("role", "")).lower() == "user":
            user_turns += 1
    user_turns = max(1, user_turns)
    # Legacy path: still better than the old 1.2K/turn (which capped at ~2–3K)
    tokens = (total_chars / 3.0) + (user_turns * 25_000) + 12_000
    used_k = max(1, int(math.ceil(tokens / 1000.0)))
    used_k = max(used_k, int(prev_used_k or 1))
    return min(used_k, CONTEXT_MAX_K)


def fetch_new_messages(cfg: dict, agent_locals: list[str], processed: set[str]) -> list[dict]:
    base = cfg["SUPABASE_URL"].rstrip("/")
    url = (
        f"{base}/rest/v1/email_messages"
        f"?select=id,address_id,from_address,from_name,to_addresses,subject,body_text,body_html,"
        f"thread_id,resend_email_id,received_at,direction,folder,is_spam,is_trash,is_archived"
        f"&direction=eq.inbound&is_spam=eq.false&is_trash=eq.false"
        f"&order=received_at.desc&limit=40"
    )
    code, data = curl_json(
        "GET",
        url,
        {
            "apikey": cfg["SUPABASE_SERVICE_KEY"],
            "Authorization": f"Bearer {cfg['SUPABASE_SERVICE_KEY']}",
        },
    )
    if code != 200 or not isinstance(data, list):
        log(f"fetch failed code={code} data={str(data)[:200]}")
        return []

    out = []
    agent_set = set(agent_locals)
    for msg in data:
        mid = msg.get("id")
        if not mid or mid in processed:
            continue
        local = extract_local(msg.get("to_addresses"))
        if not local or local not in agent_set:
            continue
        msg["_agent_local"] = local
        out.append(msg)
    out.reverse()
    return out


def history_path(session_id: int) -> Path:
    p = STATE_DIR / "session_history"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{session_id}.jsonl"


def load_history(session_id: int) -> list[dict]:
    path = history_path(session_id)
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def append_history(session_id: int, role: str, text: str) -> None:
    path = history_path(session_id)
    with path.open("a") as f:
        f.write(json.dumps({"role": role, "text": text, "at": datetime.now(timezone.utc).isoformat()}) + "\n")


def alloc_session(sessions: dict, agent: dict, msg: dict, base: str) -> tuple[int, dict]:
    sid = int(sessions["next_id"])
    sessions["next_id"] = sid + 1
    rec = {
        "id": sid,
        "agent_local": agent["local_part"],
        "workspace": agent["workspace"],
        "display_name": agent["display_name"],
        "base_subject": base,
        "email_thread_id": msg.get("thread_id"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "status": "open",
        "used_k": 1,
    }
    sessions["by_id"][str(sid)] = rec
    save_sessions(sessions)
    return sid, rec


def resolve_session(sessions: dict, agent: dict, msg: dict) -> tuple[int, dict, bool]:
    """Return (session_id, record, is_new)."""
    subj = msg.get("subject") or ""
    sid = parse_session_id(subj)
    if sid is not None and str(sid) in sessions["by_id"]:
        rec = sessions["by_id"][str(sid)]
        # only continue if same agent mailbox
        if rec.get("agent_local") == agent["local_part"]:
            rec["updated_at"] = datetime.now(timezone.utc).isoformat()
            rec["status"] = "open"
            save_sessions(sessions)
            return sid, rec, False

    # match open session by email thread_id + agent
    tid = msg.get("thread_id")
    if tid:
        for k, rec in sessions["by_id"].items():
            if (
                rec.get("agent_local") == agent["local_part"]
                and rec.get("email_thread_id") == tid
                and rec.get("status") == "open"
            ):
                rec["updated_at"] = datetime.now(timezone.utc).isoformat()
                save_sessions(sessions)
                return int(k), rec, False

    base = base_subject(subj)
    sid, rec = alloc_session(sessions, agent, msg, base)
    return sid, rec, True


def run_grok(
    cfg: dict,
    agent: dict,
    msg: dict,
    session_id: int,
    is_new: bool,
    grant: dict | None = None,
) -> tuple[str, dict]:
    """Run Grok Build for one email. Returns (reply_text, meta).

    meta: {turn_tokens, duration_s, timed_out, returncode}
    """
    grok = cfg.get("GROK_BIN") or str(Path.home() / ".grok/bin/grok")
    workspace = agent["workspace"]
    max_turns = cfg.get("MAX_TURNS", "40")
    body = plain_text(msg)
    subject = msg.get("subject") or "(no subject)"
    from_addr = msg.get("from_address") or ""
    display = agent["display_name"]
    scope = agent.get("scope") or "project"
    # Default 45 min — complex audits (mycart non-public pages) regularly blew
    # the old 15 min (900s) hard kill and only returned the timeout stub.
    timeout_s = int(cfg.get("GROK_TIMEOUT", "2700"))
    flags = access.grok_invocation(grant or {"enabled": True, "mode": "all"}) if access else {
        "permission_mode": "bypassPermissions",
        "always_approve": True,
        "disallowed_tools": [],
        "deny_rules": [],
        "prompt_lock": "",
        "questions_only": False,
    }

    history = load_history(session_id)
    hist_block = ""
    if history:
        parts = []
        for h in history[-40:]:  # last 40 turns max in prompt
            parts.append(f"{h.get('role', '?').upper()}:\n{h.get('text', '')}")
        hist_block = "\n\n--- Prior turns this session ---\n" + "\n\n".join(parts) + "\n--- End prior ---\n"

    lock = flags.get("prompt_lock") or ""
    work_rule = (
        access.work_rule(bool(flags.get("questions_only")))
        if access
        else (
            "- QUESTIONS ONLY. Do not change any files. Answer, then stop."
            if flags.get("questions_only")
            else "- Do the work in the workspace with tools when they ask for code/project work, then summarize."
        )
    )

    prompt = f"""You are {display}, an email coding agent for John Romano (session ID {session_id}).

This is {"a BRAND NEW session — first email" if is_new else "a CONTINUATION of session " + str(session_id)}.
You MUST produce a useful email reply body (plain text). No subject line. No wrapping the whole reply in code fences.
Be concise like a staff engineer texting a busy CEO.

Workspace: {workspace}
Scope: {"ALL projects under ~/Documents" if scope == "all_documents" else "this project only"}
{hist_block}
New email from: {from_addr}
Subject: {subject}

Email body:
{body}

{lock}

Rules:
{work_rule}
- If unclear, ask one short clarifying question.
- Never invent secrets. Never send mail yourself — your stdout IS the email reply body.
- Keep the reply under ~400 words unless they asked for detail.
- Do not mention token counts unless asked.
- Prefer finishing with a partial useful answer over running forever. If time is tight, ship what you have.
"""

    append_history(session_id, "user", f"Subject: {subject}\n\n{body}")

    cmd = [grok, "--cwd", workspace]
    if flags.get("always_approve", True):
        cmd += ["--always-approve"]
    cmd += ["--permission-mode", str(flags.get("permission_mode") or "bypassPermissions")]
    if flags.get("disallowed_tools"):
        cmd += ["--disallowed-tools", ",".join(flags["disallowed_tools"])]
    for rule in flags.get("deny_rules") or []:
        cmd += ["--deny", rule]
    cmd += ["--max-turns", str(max_turns), "-p", prompt]
    env = os.environ.copy()
    env["PATH"] = f"/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:{Path.home()}/.grok/bin:" + env.get("PATH", "")
    log(
        f"grok start session={session_id} new={is_new} agent={agent['local_part']} "
        f"msg={str(msg.get('id'))[:8]} timeout={timeout_s}s max_turns={max_turns} "
        f"perm={flags.get('permission_mode')} ask_only={flags.get('questions_only')}"
    )
    t0 = time.time()
    timed_out = False
    stdout = ""
    stderr = ""
    rc = -1
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=env,
            cwd=workspace if Path(workspace).is_dir() else str(Path.home()),
        )
        stdout = r.stdout or ""
        stderr = r.stderr or ""
        rc = r.returncode
    except subprocess.TimeoutExpired as e:
        timed_out = True
        # Python keeps partial capture on the exception when available
        stdout = (e.stdout or "") if isinstance(e.stdout, str) else (e.stdout or b"").decode("utf-8", "replace")
        stderr = (e.stderr or "") if isinstance(e.stderr, str) else (e.stderr or b"").decode("utf-8", "replace")
        log(f"grok TIMEOUT session={session_id} after {timeout_s}s partial_out={len(stdout)} partial_err={len(stderr)}")
    duration_s = time.time() - t0

    if timed_out:
        partial = stdout.strip()
        if partial and len(partial) > 80:
            text = (
                partial[:11000]
                + "\n\n—\nHit the agent time limit mid-run. Partial answer above; "
                "reply on this thread to continue."
            )
        else:
            text = (
                f"Started work but hit the {timeout_s // 60}-minute agent time limit "
                "before a full answer was ready. Reply again on this thread and I'll continue."
            )
    else:
        if rc != 0:
            log(f"grok nonzero rc={rc} err={stderr[:400]}")
        text = stdout.strip()
        if not text:
            text = "Got it. I ran the job but produced no text — reply again with a shorter ask."
        text = text[:12000]

    append_history(session_id, "assistant", text)
    turn_tokens = estimate_turn_tokens(
        prompt, stdout, stderr, duration_s=duration_s, timed_out=timed_out
    )
    log(
        f"grok done session={session_id} timed_out={timed_out} "
        f"dur={duration_s:.0f}s turn_tokens≈{turn_tokens} reply_chars={len(text)}"
    )
    return text, {
        "turn_tokens": turn_tokens,
        "duration_s": duration_s,
        "timed_out": timed_out,
        "returncode": rc,
    }


def send_reply(cfg: dict, agent: dict, msg: dict, reply_text: str, subject: str) -> bool:
    from_addr = f"{agent['local_part']}@freecoffee.dev"
    from_header = f"{agent['display_name']} <{from_addr}>"
    to_addr = msg.get("from_address")
    if not to_addr:
        log("no from_address; skip send")
        return False

    payload = {
        "from": from_header,
        "to": [to_addr],
        "subject": subject,
        "text": reply_text,
    }
    # Thread for Apple Mail / Gmail / our app — use angle-bracket Message-IDs
    headers = {}
    rid = msg.get("resend_email_id")
    if rid:
        mid = rid if str(rid).startswith("<") else f"<{rid}>"
        headers["In-Reply-To"] = mid
        headers["References"] = mid
    if headers:
        payload["headers"] = headers

    code, data = curl_json(
        "POST",
        "https://api.resend.com/emails",
        {
            "Authorization": f"Bearer {cfg['RESEND_API_KEY']}",
            "Content-Type": "application/json",
        },
        payload,
    )
    if code in (200, 201):
        log(f"sent reply session_subj={subject!r} id={data.get('id') if isinstance(data, dict) else data}")
        return True
    log(f"send failed code={code} {str(data)[:300]}")
    return False


def heartbeat(cfg: dict) -> None:
    """Tell Settings → Setup that this machine is alive."""
    base = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    if not base or not key:
        return
    now = datetime.now(timezone.utc).isoformat()
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    try:
        code, data = curl_json(
            "PATCH",
            f"{base}/rest/v1/agent_runtime?id=eq.1",
            headers,
            {"worker_seen_at": now, "updated_at": now, "hands": "local"},
        )
        if code in (200, 204) and (data == [] or data is None):
            curl_json(
                "POST",
                f"{base}/rest/v1/agent_runtime",
                headers,
                {"id": 1, "hands": "local", "worker_seen_at": now, "updated_at": now},
            )
    except Exception as e:
        log(f"heartbeat failed: {e}")


def fetch_allowlist(cfg: dict) -> dict | None:
    """Prefer Settings → Agents (Supabase). Fall back to local JSON."""
    if not access:
        return None
    base = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    if not base or not key:
        return None
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    try:
        code, senders = curl_json("GET", f"{base}/rest/v1/agent_senders?select=*", headers)
        if code != 200 or not isinstance(senders, list):
            log(f"allowlist fetch senders failed code={code}")
            return None
        code, grants = curl_json("GET", f"{base}/rest/v1/agent_sender_grants?select=*", headers)
        if code != 200 or not isinstance(grants, list):
            log(f"allowlist fetch grants failed code={code}")
            return None
        store = access.store_from_cloud_rows(senders, grants)
        log(f"allowlist cloud users={len(store.get('users') or [])}")
        return store
    except Exception as e:
        log(f"allowlist fetch error: {e}")
        return None


def deny_reply(agent: dict, reason: str) -> str:
    name = agent.get("display_name") or agent.get("local_part") or "this agent"
    if access:
        return access.deny_message(name, reason)
    if reason == "no_agent":
        return (
            f"This mailbox is restricted. Your address isn't allowed to talk to {name}. "
            "Ask John to enable it in Agent Mail Users."
        )
    return f"This mailbox is restricted. {name} didn't run your message."


def process_once(cfg: dict) -> None:
    agents_doc = load_agents()
    agents = by_local(agents_doc)
    processed = load_processed()
    sessions = load_sessions()
    cloud_store = None
    if access:
        access.ensure_store()
        cloud_store = fetch_allowlist(cfg)

    msgs = fetch_new_messages(cfg, list(agents.keys()), processed)
    if not msgs:
        return

    log(f"found {len(msgs)} new agent mail(s)")
    for msg in msgs:
        mid = msg["id"]
        local = msg["_agent_local"]
        agent = agents.get(local)
        if not agent:
            processed.add(mid)
            continue
        from_addr = msg.get("from_address") or ""
        if access:
            auth = access.authorize(from_addr, local, cloud_store)
        else:
            trust_raw = cfg.get("TRUSTED_SENDERS", "@freecoffee.dev")
            patterns = [p.strip() for p in trust_raw.split(",") if p.strip()]
            auth = {"ok": trusted(from_addr, patterns), "reason": "legacy", "grant": {"enabled": True, "mode": "all"}}
        if not auth.get("ok"):
            reason = auth.get("reason") or "unknown"
            log(f"block {reason} from={from_addr} agent={local} msg={str(mid)[:8]}")
            if reason == "no_agent":
                try:
                    base = base_subject(msg.get("subject") or "")
                    send_reply(cfg, agent, msg, deny_reply(agent, reason), f"Re: {base}")
                except Exception as e:
                    log(f"deny-reply failed: {e}")
            processed.add(mid)
            save_processed(processed)
            continue
        try:
            sid, rec, is_new = resolve_session(sessions, agent, msg)
            reply, meta = run_grok(cfg, agent, msg, sid, is_new, grant=auth.get("grant"))
            history = load_history(sid)
            prev_k = int(rec.get("used_k") or 1)
            prev_tokens = int(rec.get("used_tokens") or 0)
            # Prefer cumulative used_tokens (real agent-loop estimate). Seed
            # from prev_k*1000 so old sessions don't reset the counter.
            if prev_tokens <= 0 and prev_k > 1:
                prev_tokens = prev_k * 1000
            turn_tokens = int(meta.get("turn_tokens") or 0)
            used_tokens = prev_tokens + turn_tokens
            used_k = estimate_used_k(history, prev_k, used_tokens=used_tokens)
            rec["used_tokens"] = used_tokens
            rec["used_k"] = used_k
            rec["updated_at"] = datetime.now(timezone.utc).isoformat()
            # Keep email_thread_id sticky so later mails on same thread continue
            if msg.get("thread_id") and not rec.get("email_thread_id"):
                rec["email_thread_id"] = msg.get("thread_id")
            sessions["by_id"][str(sid)] = rec
            save_sessions(sessions)

            subj = format_reply_subject(rec.get("base_subject") or base_subject(msg.get("subject") or ""), sid, used_k)
            send_reply(cfg, agent, msg, reply, subj)

            tdir = Path(agent["agent_dir"]) / "threads"
            tdir.mkdir(parents=True, exist_ok=True)
            (tdir / f"{sid}-{mid}.json").write_text(
                json.dumps(
                    {
                        "session_id": sid,
                        "is_new": is_new,
                        "used_k": used_k,
                        "used_tokens": used_tokens,
                        "turn_tokens": turn_tokens,
                        "timed_out": bool(meta.get("timed_out")),
                        "duration_s": meta.get("duration_s"),
                        "subject": subj,
                        "msg_id": mid,
                        "from": from_addr,
                        "reply_preview": reply[:2000],
                        "at": datetime.now(timezone.utc).isoformat(),
                    },
                    indent=2,
                )
            )
        except Exception as e:
            log(f"process error msg={str(mid)[:8]}: {e}")
            traceback.print_exc()
        finally:
            processed.add(mid)
            save_processed(processed)


def acquire_lock() -> bool:
    try:
        if LOCK.exists():
            age = time.time() - LOCK.stat().st_mtime
            if age < 1800:
                try:
                    pid = int(LOCK.read_text().strip() or "0")
                    os.kill(pid, 0)
                    return False
                except (ProcessLookupError, ValueError, PermissionError, OSError):
                    pass
        LOCK.write_text(str(os.getpid()))
        return True
    except OSError:
        return True


def main() -> int:
    cfg = load_config()
    poll = int(cfg.get("POLL_SECONDS", "30"))
    log(f"Agent Mail worker start poll={poll}s pid={os.getpid()} sessions=on")
    try:
        store = fetch_allowlist(cfg)
        if store is not None:
            log(f"allowlist source=supabase users={len(store.get('users') or [])}")
        else:
            log("allowlist source=local-json (cloud unavailable)")
    except Exception as e:
        log(f"allowlist boot check: {e}")
    if not acquire_lock():
        log("another worker holds lock; exiting")
        return 0
    try:
        while True:
            try:
                heartbeat(cfg)
                process_once(cfg)
            except Exception as e:
                log(f"loop error: {e}")
                traceback.print_exc()
            time.sleep(poll)
    finally:
        try:
            if LOCK.exists() and LOCK.read_text().strip() == str(os.getpid()):
                LOCK.unlink()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
