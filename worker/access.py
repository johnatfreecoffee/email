#!/usr/bin/env python3
"""Allowlist + per-agent permission gate for Agent Mail.

Authoritative store: ~/Library/AgentMail/state/allowed_users.json
The worker hard-blocks before Grok is spawned.
"""

from __future__ import annotations

import fcntl
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path.home() / "Library" / "AgentMail"
STATE_DIR = ROOT / "state"
USERS_PATH = STATE_DIR / "allowed_users.json"
AGENTS_JSON = ROOT / "agents.json"
LOCK_PATH = STATE_DIR / "allowed_users.lock"

EMAIL_RE = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$", re.I)
ANGLE_EMAIL_RE = re.compile(r"<([^>]+)>")

PERMS = ("read", "write", "update", "delete")
MODES = ("ask", "all", "custom")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_email(addr: str) -> str:
    raw = (addr or "").strip().lower()
    if not raw:
        return ""
    m = ANGLE_EMAIL_RE.search(raw)
    if m:
        raw = m.group(1).strip().lower()
    raw = raw.split()[-1] if " " in raw else raw
    return raw.strip("<>\"'")


def valid_email(addr: str) -> bool:
    return bool(EMAIL_RE.match(normalize_email(addr)))


def empty_perms() -> dict[str, bool]:
    return {k: False for k in PERMS}


def all_perms() -> dict[str, bool]:
    return {k: True for k in PERMS}


def normalize_perms(raw) -> dict[str, bool]:
    src = raw if isinstance(raw, dict) else {}
    return {k: bool(src.get(k)) for k in PERMS}


def infer_mode(perms: dict[str, bool], mode: str | None = None) -> str:
    if mode == "ask":
        return "ask"
    if mode == "all" or all(perms.get(k) for k in PERMS):
        return "all"
    if not any(perms.get(k) for k in ("write", "update", "delete")):
        return "ask"
    return "custom"


def default_grant(*, enabled: bool = False, mode: str = "ask") -> dict:
    if mode == "all":
        perms = all_perms()
    elif mode == "ask":
        perms = {"read": True, "write": False, "update": False, "delete": False}
    else:
        perms = empty_perms()
        perms["read"] = True
    return {"enabled": bool(enabled), "mode": infer_mode(perms, mode), "perms": perms}


def load_agent_catalog() -> list[dict]:
    if not AGENTS_JSON.exists():
        return []
    try:
        doc = json.loads(AGENTS_JSON.read_text())
    except Exception:
        return []
    out = []
    for a in doc.get("agents") or []:
        local = (a.get("local_part") or "").strip().lower()
        if not local:
            continue
        out.append(
            {
                "local_part": local,
                "email": a.get("email") or f"{local}@{(doc.get('domain') or 'example.com')}",
                "display_name": a.get("display_name") or local,
            }
        )
    return out


def _blank_store() -> dict:
    return {"version": 1, "updated_at": now_iso(), "users": []}


def _lock():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    fh = LOCK_PATH.open("a+")
    fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
    return fh


def load_store() -> dict:
    if not USERS_PATH.exists():
        return _blank_store()
    try:
        data = json.loads(USERS_PATH.read_text())
    except Exception:
        return _blank_store()
    if not isinstance(data, dict):
        return _blank_store()
    data.setdefault("version", 1)
    data.setdefault("users", [])
    return data


def save_store(data: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = now_iso()
    tmp = USERS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(USERS_PATH)


def ensure_store() -> dict:
    """Create an empty local allowlist file if missing. Cloud grants are source of truth."""
    fh = _lock()
    try:
        data = load_store()
        if not USERS_PATH.exists():
            save_store(data)
        return data
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()


def find_user(email: str, store: dict | None = None) -> dict | None:
    want = normalize_email(email)
    if not want:
        return None
    data = store if store is not None else load_store()
    for u in data.get("users") or []:
        if normalize_email(u.get("email", "")) == want:
            return u
    return None


def authorize(from_addr: str, agent_local: str, store: dict | None = None) -> dict:
    """Hard gate. ok=False means the worker must not spawn Grok."""
    data = store if store is not None else load_store()
    user = find_user(from_addr, data)
    local = (agent_local or "").strip().lower()
    if not user:
        return {"ok": False, "reason": "unknown", "user": None, "grant": None}
    if user.get("archived"):
        return {"ok": False, "reason": "archived", "user": user, "grant": None}
    grant = (user.get("agents") or {}).get(local)
    if not grant or not grant.get("enabled"):
        return {"ok": False, "reason": "no_agent", "user": user, "grant": None}
    grant = normalize_grant(grant)
    return {"ok": True, "reason": "ok", "user": user, "grant": grant}


def normalize_grant(raw) -> dict:
    if not isinstance(raw, dict):
        return default_grant(enabled=False, mode="ask")
    mode = raw.get("mode") if raw.get("mode") in MODES else None
    perms = normalize_perms(raw.get("perms"))
    if mode == "all":
        perms = all_perms()
    elif mode == "ask":
        perms = {"read": True, "write": False, "update": False, "delete": False}
    mode = infer_mode(perms, mode)
    return {"enabled": bool(raw.get("enabled")), "mode": mode, "perms": perms}


def grok_invocation(grant: dict) -> dict:
    """Map a grant onto Grok CLI flags + a prompt lock.

    deny rules still apply under --always-approve.
    """
    g = normalize_grant(grant)
    perms = g["perms"]
    mode = g["mode"]
    questions_only = mode == "ask" or not any(perms.get(k) for k in ("write", "update", "delete"))

    disallowed: list[str] = []
    deny: list[str] = []

    if questions_only or not perms.get("write"):
        disallowed.append("write")
        deny.append("Write(*)")
    if questions_only or not perms.get("update"):
        disallowed.append("search_replace")
        deny.append("Edit(*)")
    if questions_only or not perms.get("delete"):
        deny.extend(["Bash(rm *)", "Bash(rmdir *)", "Bash(unlink *)"])

    if questions_only:
        permission_mode = "plan"
        prompt_lock = (
            "HARD PERMISSION LOCK — QUESTIONS ONLY.\n"
            "This sender may only ask questions. You MUST NOT create, edit, update, "
            "or delete any files. You MUST NOT run mutating shell commands "
            "(no install, no git write, no rm, no redirect-to-file). "
            "Read-only inspection is allowed if needed to answer. "
            "If they ask you to change code, refuse in one sentence and explain "
            "they only have question access."
        )
    elif mode == "all":
        permission_mode = "bypassPermissions"
        disallowed = []
        deny = []
        prompt_lock = "This sender has full code access (read/write/update/delete) for this agent."
    else:
        permission_mode = "dontAsk"
        bits = [k for k in PERMS if perms.get(k)]
        prompt_lock = (
            "HARD PERMISSION LOCK — LIMITED CODE ACCESS.\n"
            f"Allowed for this sender: {', '.join(bits) or 'read only'}.\n"
            "You MUST NOT perform a disallowed action. "
            "If they ask for something outside this grant, refuse and say which permission is missing."
        )

    # unique, stable order
    seen: set[str] = set()
    disallow_u = []
    for t in disallowed:
        if t not in seen:
            seen.add(t)
            disallow_u.append(t)

    return {
        "mode": mode,
        "perms": perms,
        "questions_only": questions_only,
        "permission_mode": permission_mode,
        "always_approve": True,
        "disallowed_tools": disallow_u,
        "deny_rules": deny,
        "prompt_lock": prompt_lock,
    }


ASK_WORK_RULE = "- QUESTIONS ONLY. Do not change any files. Answer, then stop."
CODE_WORK_RULE = "- Do the work in the workspace with tools when they ask for code/project work, then summarize."
COMMON_RULES = [
    "- If unclear, ask one short clarifying question.",
    "- Never invent secrets. Never send mail yourself — your stdout IS the email reply body.",
    "- Keep the reply under ~400 words unless they asked for detail.",
    "- Do not mention token counts unless asked.",
    "- Prefer finishing with a partial useful answer over running forever. If time is tight, ship what you have.",
]


def work_rule(questions_only: bool) -> str:
    return ASK_WORK_RULE if questions_only else CODE_WORK_RULE


def deny_message(agent_name: str, reason: str) -> str:
    name = agent_name or "this agent"
    if reason == "no_agent":
        return (
            f"This mailbox is restricted. Your address isn't allowed to talk to {name}. "
            "Ask the owner to enable it in Settings → Agents."
        )
    return f"This mailbox is restricted. {name} didn't run your message."


def preview_pack(grant: dict | None = None, *, enabled: bool | None = None) -> dict:
    """What Grok actually gets — used by the dashboard so the UI cannot drift."""
    raw = dict(grant or {})
    if enabled is not None:
        raw["enabled"] = enabled
    on = bool(raw.get("enabled", True))
    if not on:
        return {
            "grok_runs": False,
            "reason": "unchecked",
            "title": "This agent is unchecked",
            "what": "Their email never reaches Grok for this mailbox. No reply.",
            "prompt_lock": "",
            "work_rule": "",
            "rules": [],
            "permission_mode": None,
            "disallowed_tools": [],
            "deny_rules": [],
        }
    flags = grok_invocation(raw)
    wr = work_rule(bool(flags["questions_only"]))
    return {
        "grok_runs": True,
        "reason": "ok",
        "title": "Grok starts",
        "what": "Hidden lock + rules are prepended. Sender never sees this block.",
        "prompt_lock": flags["prompt_lock"],
        "work_rule": wr,
        "rules": [wr, *COMMON_RULES],
        "permission_mode": flags["permission_mode"],
        "disallowed_tools": flags["disallowed_tools"],
        "deny_rules": flags["deny_rules"],
        "mode": flags["mode"],
        "perms": flags["perms"],
        "questions_only": flags["questions_only"],
    }


def how_it_works() -> dict:
    ask = preview_pack({"enabled": True, "mode": "ask"})
    full = preview_pack({"enabled": True, "mode": "all"})
    custom = preview_pack(
        {
            "enabled": True,
            "mode": "custom",
            "perms": {"read": True, "write": True, "update": False, "delete": False},
        }
    )
    return {
        "flow": [
            {
                "n": 1,
                "title": "Email hits an agent mailbox",
                "body": "Someone writes an a.* / e.* agent address. The worker on the hands machine picks it up.",
            },
            {
                "n": 2,
                "title": "Are they on Users?",
                "body": "From-address is checked against this app’s list. Not on the list → stop. Grok never starts. No reply. They get silence.",
            },
            {
                "n": 3,
                "title": "Are they in Archive?",
                "body": "Archived people are still in the file but treated as off. Same as not on the list: no Grok, no reply.",
            },
            {
                "n": 4,
                "title": "Is this agent checked for them?",
                "body": "On the list but this agent is unchecked → Grok still does not start. They get a short denial email (below). Other checked agents still work.",
            },
            {
                "n": 5,
                "title": "Grok starts with a hidden pre-prompt",
                "body": "Only then do we spawn Grok. We prepend a lock the sender never sees, plus tool blocks (write/edit/rm) so it cannot ignore the note.",
            },
        ],
        "stops": [
            {
                "id": "unknown",
                "title": "Not on the list",
                "grok": False,
                "reply": "None — silent. We do not confirm the mailbox exists.",
            },
            {
                "id": "archived",
                "title": "In Archive",
                "grok": False,
                "reply": "None — silent. Restore them on the Archive tab to turn them back on.",
            },
            {
                "id": "no_agent",
                "title": "On the list, this agent unchecked",
                "grok": False,
                "reply": deny_message("Agent NokNok", "no_agent"),
            },
        ],
        "previews": {"ask": ask, "all": full, "custom": custom},
        "locks": {
            "ask": ask["prompt_lock"],
            "all": full["prompt_lock"],
            "custom": (
                "HARD PERMISSION LOCK — LIMITED CODE ACCESS.\n"
                "Allowed for this sender: {bits}.\n"
                "You MUST NOT perform a disallowed action. "
                "If they ask for something outside this grant, refuse and say which permission is missing."
            ),
        },
        "work_rules": {"ask": ASK_WORK_RULE, "code": CODE_WORK_RULE},
        "common_rules": COMMON_RULES,
    }


def public_user(user: dict) -> dict:
    agents = {}
    for k, v in (user.get("agents") or {}).items():
        agents[k] = normalize_grant(v)
    return {
        "id": user.get("id"),
        "first_name": user.get("first_name") or "",
        "last_name": user.get("last_name") or "",
        "email": normalize_email(user.get("email") or ""),
        "archived": bool(user.get("archived")),
        "created_at": user.get("created_at"),
        "updated_at": user.get("updated_at"),
        "agents": agents,
    }


def _normalize_agents_payload(raw) -> dict:
    catalog = {a["local_part"] for a in load_agent_catalog()}
    out = {}
    src = raw if isinstance(raw, dict) else {}
    for local, grant in src.items():
        key = (local or "").strip().lower()
        if key not in catalog:
            continue
        out[key] = normalize_grant(grant)
    for local in catalog:
        if local not in out:
            out[local] = default_grant(enabled=False, mode="ask")
    return out


def upsert_user(payload: dict, user_id: str | None = None) -> tuple[dict | None, str | None]:
    first = (payload.get("first_name") or "").strip()
    last = (payload.get("last_name") or "").strip()
    email = normalize_email(payload.get("email") or "")
    if not first:
        return None, "first name is required"
    if not last:
        return None, "last name is required"
    if not valid_email(email):
        return None, "valid email is required"

    fh = _lock()
    try:
        data = load_store()
        users = data.setdefault("users", [])
        existing = None
        if user_id:
            existing = next((u for u in users if u.get("id") == user_id), None)
            if not existing:
                return None, "user not found"
        clash = next(
            (
                u
                for u in users
                if normalize_email(u.get("email", "")) == email
                and (not existing or u.get("id") != existing.get("id"))
            ),
            None,
        )
        if clash:
            return None, "that email is already on the list"
        agents = _normalize_agents_payload(payload.get("agents"))
        if existing:
            existing["first_name"] = first
            existing["last_name"] = last
            existing["email"] = email
            existing["agents"] = agents
            existing["updated_at"] = now_iso()
            save_store(data)
            return public_user(existing), None
        rec = {
            "id": str(uuid.uuid4()),
            "first_name": first,
            "last_name": last,
            "email": email,
            "archived": False,
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "agents": agents,
        }
        users.append(rec)
        save_store(data)
        return public_user(rec), None
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()


def set_archived(user_id: str, archived: bool) -> tuple[dict | None, str | None]:
    fh = _lock()
    try:
        data = load_store()
        user = next((u for u in data.get("users") or [] if u.get("id") == user_id), None)
        if not user:
            return None, "user not found"
        user["archived"] = bool(archived)
        user["updated_at"] = now_iso()
        save_store(data)
        return public_user(user), None
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()


def store_from_cloud_rows(senders: list[dict], grants: list[dict]) -> dict:
    by_id: dict[str, dict] = {}
    for s in senders:
        sid = str(s.get("id") or "")
        if not sid:
            continue
        by_id[sid] = {
            "id": sid,
            "first_name": s.get("first_name") or "",
            "last_name": s.get("last_name") or "",
            "email": normalize_email(s.get("email") or ""),
            "archived": bool(s.get("archived")),
            "created_at": s.get("created_at"),
            "updated_at": s.get("updated_at"),
            "agents": {},
        }
    for g in grants:
        sid = str(g.get("sender_id") or "")
        if sid not in by_id:
            continue
        local = (g.get("agent_local") or "").strip().lower()
        if not local:
            continue
        by_id[sid]["agents"][local] = normalize_grant(g)
    return {"version": 2, "source": "supabase", "users": list(by_id.values())}


def list_users(*, archived: bool) -> list[dict]:
    data = ensure_store()
    rows = [public_user(u) for u in data.get("users") or [] if bool(u.get("archived")) == archived]
    rows.sort(key=lambda u: ((u.get("last_name") or "").lower(), (u.get("first_name") or "").lower()))
    return rows
