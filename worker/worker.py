#!/usr/bin/env python3
"""Agent Mail — poll a.*@ mail, run Grok Build jobs, reply with (ID: n - used/500K) subjects."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import traceback
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(os.environ.get("AGENTMAIL_HOME") or (Path.home() / "Library" / "AgentMail"))
CONFIG = ROOT / "config.env"
AGENTS_JSON = ROOT / "agents.json"
WORKSPACES_JSON = ROOT / "workspaces.json"
STATE_DIR = ROOT / "state"
LOG_DIR = ROOT / "logs"
PROCESSED = STATE_DIR / "processed_ids.json"
SESSIONS = STATE_DIR / "sessions.json"
LOCK = STATE_DIR / "worker.lock"
LOG_FILE = LOG_DIR / "worker.log"

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "bin"))
try:
    import access
except ImportError:
    access = None  # type: ignore

CONTEXT_MAX_K = 500  # display denominator
TOKENS_PER_MIN = 2500  # tool-loop estimate; wall-clock is minutes, not seconds
MAX_PARALLEL = 4
ID_RE = re.compile(r"\(ID:\s*(\d+)(?:\s*-\s*[^)]*)?\)", re.I)
ID_ONLY_RE = re.compile(r"\bID:\s*(\d+)\b", re.I)
REPLY_PREFIX_RE = re.compile(r"^(re|fwd|fw)\s*:", re.I)
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)
JOB_SELECT = (
    "id,session_id,agent_local,mailbox,base_subject,stage,email_thread_id,"
    "last_message_id,used_k,used_tokens,received_at,started_at,last_reply_at,"
    "done_at,stuck_at,updated_at,notes,remind_requested_at"
)
REMIND_USER_TEXT = (
    "John tapped Remind on the board — pick this session back up and finish "
    "or say what's blocking."
)
DONE_LINE_RE = re.compile(
    r"\b(this turn is done|this turn'?s done|that'?s done for this turn|done for this turn)\b",
    re.I,
)
VAGUE_FALLBACK = "I looked at this — write back if you want me to go deeper on any piece."
EMPTY_DONE = (
    "This turn is done. I ran the job but didn't have a note to send — nothing useful finished. "
    "Write back with a shorter ask and I'll pick it up."
)
TIMEOUT_PARTIAL = (
    "This turn is done. I ran out of time. What finished is in the note above; "
    "the rest of this turn did not finish. Write back if you want me to keep going."
)
TIMEOUT_EMPTY = (
    "This turn is done. I started but ran out of time — nothing useful finished; "
    "the rest of this turn did not. Reply on this thread and I'll pick it up."
)

STATE_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

_state_lock = threading.RLock()
_log_lock = threading.Lock()
_session_locks_guard = threading.Lock()
_session_locks: dict[int, threading.Lock] = {}
_inflight: set[str] = set()
_inflight_sessions: set[int] = set()
_pool: ThreadPoolExecutor | None = None
_pool_lock = threading.Lock()


def log(msg: str) -> None:
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        with _log_lock:
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


IMAGE_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/tiff",
    "image/bmp",
}
MAX_INBOUND_FILES = 20
MAX_INBOUND_BYTES = 20 * 1024 * 1024


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


def curl_download(url: str, headers: dict[str, str], dest: Path, timeout: int = 120) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["/usr/bin/curl", "-sS", "-L", "-f", "-o", str(dest), "--max-time", str(timeout)]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    cmd.append(url)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 15)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return r.returncode == 0 and dest.exists() and dest.stat().st_size > 0


def safe_filename(name: str) -> str:
    base = Path(str(name or "file")).name
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "file"
    return base[:180]


def is_image_type(content_type: str, filename: str = "") -> bool:
    t = (content_type or "").lower().split(";")[0].strip()
    if t in IMAGE_TYPES or t.startswith("image/"):
        return True
    return bool(re.search(r"\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$", filename or "", re.I))


def maybe_jpeg_preview(path: Path) -> Path:
    if path.suffix.lower() not in (".heic", ".heif"):
        return path
    sips = Path("/usr/bin/sips")
    if not sips.exists():
        return path
    out = path.with_suffix(".jpg")
    try:
        r = subprocess.run(
            [str(sips), "-s", "format", "jpeg", str(path), "--out", str(out)],
            capture_output=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, OSError):
        return path
    if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
        return out
    return path


def storage_object_url(cfg: dict, storage_path: str) -> str:
    base = sb_base(cfg)
    encoded = "/".join(quote(p, safe="") for p in str(storage_path).split("/") if p)
    return f"{base}/storage/v1/object/email-attachments/{encoded}"


def fetch_attachments(cfg: dict, message_id: str) -> list[dict]:
    base = sb_base(cfg)
    if not base or not message_id or not UUID_RE.match(str(message_id)):
        return []
    try:
        code, data = curl_json(
            "GET",
            f"{base}/rest/v1/email_attachments?message_id=eq.{message_id}"
            f"&select=id,filename,content_type,size_bytes,storage_path&order=filename.asc",
            sb_headers(cfg),
        )
        if code == 200 and isinstance(data, list):
            return [row for row in data if isinstance(row, dict)]
    except Exception as e:
        log(f"attachments fetch failed: {e}")
    return []


def format_files_block(files: list[dict]) -> str:
    if not files:
        return "No files were on this email."
    lines = [
        "Attached files (read these with tools so you can see screenshots and documents):"
    ]
    for f in files:
        kind = "image" if f.get("is_image") else "file"
        lines.append(
            f"- {f.get('path')}  ({f.get('filename')}, {kind}, "
            f"{f.get('content_type') or 'unknown'}, {int(f.get('size_bytes') or 0)} bytes)"
        )
    lines.append(
        "If a path is an image or PDF, open it with the file reader before you answer. "
        "Do not skip screenshots."
    )
    return "\n".join(lines)


def materialize_attachments(cfg: dict, message_id: str, dest_dir: Path) -> list[dict]:
    """Download inbound files onto disk so Grok can read screenshots."""
    if not message_id or not UUID_RE.match(str(message_id)):
        return []
    rows = fetch_attachments(cfg, message_id)
    if not rows:
        return []
    dest_dir.mkdir(parents=True, exist_ok=True)
    used_names: set[str] = set()
    out: list[dict] = []
    for row in rows[:MAX_INBOUND_FILES]:
        filename = safe_filename(str(row.get("filename") or "file"))
        if filename in used_names:
            stem = Path(filename).stem
            suffix = Path(filename).suffix
            n = 2
            while f"{stem}-{n}{suffix}" in used_names:
                n += 1
            filename = f"{stem}-{n}{suffix}"
        used_names.add(filename)
        storage_path = str(row.get("storage_path") or "")
        if not storage_path or storage_path.startswith("pending/"):
            continue
        size = int(row.get("size_bytes") or 0)
        if size > MAX_INBOUND_BYTES:
            log(f"skip large file {filename} bytes={size}")
            continue
        dest = dest_dir / filename
        url = storage_object_url(cfg, storage_path)
        if not curl_download(url, sb_headers(cfg), dest):
            log(f"file download failed {filename}")
            continue
        dest = maybe_jpeg_preview(dest)
        out.append(
            {
                "id": row.get("id"),
                "filename": dest.name,
                "path": str(dest),
                "content_type": row.get("content_type") or "",
                "size_bytes": dest.stat().st_size,
                "is_image": is_image_type(str(row.get("content_type") or ""), dest.name),
            }
        )
    return out


def load_processed() -> set[str]:
    with _state_lock:
        if not PROCESSED.exists():
            return set()
        try:
            return set(json.loads(PROCESSED.read_text()))
        except Exception:
            return set()


def save_processed(ids: set[str]) -> None:
    with _state_lock:
        lst = sorted(ids)[-5000:]
        PROCESSED.write_text(json.dumps(lst))


def load_sessions() -> dict:
    with _state_lock:
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
    with _state_lock:
        SESSIONS.write_text(json.dumps(data, indent=2) + "\n")


def session_lock_for(sid: int) -> threading.Lock:
    with _session_locks_guard:
        lock = _session_locks.get(sid)
        if lock is None:
            lock = threading.Lock()
            _session_locks[sid] = lock
        return lock


def get_job_pool() -> ThreadPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=MAX_PARALLEL, thread_name_prefix="am-job")
        return _pool


def touch_lock() -> None:
    try:
        if LOCK.exists():
            LOCK.touch()
        else:
            LOCK.write_text(str(os.getpid()))
    except OSError:
        pass


def mark_processed(mid: str) -> None:
    """Atomically add one id so parallel jobs cannot drop siblings."""
    with _state_lock:
        ids: set[str] = set()
        if PROCESSED.exists():
            try:
                ids = set(json.loads(PROCESSED.read_text()))
            except Exception:
                ids = set()
        ids.add(str(mid))
        PROCESSED.write_text(json.dumps(sorted(ids)[-5000:]))
        _inflight.discard(str(mid))


def inflight_count() -> int:
    with _state_lock:
        return len(_inflight)


def wait_inflight(timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with _state_lock:
            empty = not _inflight
        if empty:
            return True
        time.sleep(0.02)
    return False


def _expand_path(raw: str) -> Path:
    s = (raw or "").strip()
    return Path(os.path.expanduser(s)).resolve() if s else Path()


def workspace_root(cfg: dict) -> Path:
    raw = (cfg.get("WORKSPACE_ROOT") or "").strip()
    return _expand_path(raw) if raw else Path.home() / "Documents"


def load_workspace_map() -> dict[str, dict]:
    """local_part → {workspace, agent_dir?, scope?, display_name?, email?}."""
    out: dict[str, dict] = {}
    if WORKSPACES_JSON.exists():
        try:
            raw = json.loads(WORKSPACES_JSON.read_text())
            if isinstance(raw, dict):
                mapping = raw.get("map") if isinstance(raw.get("map"), dict) else raw
                for k, v in mapping.items():
                    if k in ("WORKSPACE_ROOT", "domain", "map"):
                        continue
                    local = str(k).strip().lower()
                    if isinstance(v, str):
                        out[local] = {"workspace": v}
                    elif isinstance(v, dict):
                        out[local] = dict(v)
        except Exception as e:
            log(f"workspaces.json: {e}")
    if AGENTS_JSON.exists():
        try:
            doc = json.loads(AGENTS_JSON.read_text())
            for a in doc.get("agents") or []:
                local = (a.get("local_part") or "").strip().lower()
                if not local:
                    continue
                cur = out.get(local, {})
                for key in ("workspace", "agent_dir", "scope", "display_name", "email"):
                    if a.get(key) and not cur.get(key):
                        cur[key] = a[key]
                out[local] = cur
        except Exception as e:
            log(f"agents.json: {e}")
    return out


def fetch_cloud_agents(cfg: dict) -> list[dict]:
    """Agent mailboxes live in Settings → Agents (email_addresses)."""
    base = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    if not base or not key:
        return []
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    try:
        code, addrs = curl_json(
            "GET",
            f"{base}/rest/v1/email_addresses?select=address,display_name,is_active,domain_id&order=address.asc",
            headers,
        )
        if code != 200 or not isinstance(addrs, list):
            log(f"cloud agents fetch failed code={code}")
            return []
        code, domains = curl_json("GET", f"{base}/rest/v1/email_domains?select=id,domain", headers)
        dmap: dict = {}
        if code == 200 and isinstance(domains, list):
            dmap = {d.get("id"): d.get("domain") or "" for d in domains if isinstance(d, dict)}
        out: list[dict] = []
        for a in addrs:
            if not isinstance(a, dict) or a.get("is_active") is False:
                continue
            local = str(a.get("address") or "").strip().lower()
            if not (local.startswith("a.") or local.startswith("e.")):
                continue
            domain = dmap.get(a.get("domain_id")) or ""
            slug = local.split(".", 1)[-1].replace(".", " ").title()
            out.append(
                {
                    "local_part": local,
                    "display_name": a.get("display_name") or f"Agent {slug}",
                    "email": f"{local}@{domain}" if domain else local,
                    "domain": domain,
                }
            )
        return out
    except Exception as e:
        log(f"cloud agents error: {e}")
        return []


def resolve_workspace(local: str, overlay: dict, root: Path) -> tuple[str, str]:
    if overlay.get("workspace"):
        ws = str(_expand_path(str(overlay["workspace"])))
        scope = overlay.get("scope") or ("all_documents" if local == "a.main" else "project")
        return ws, str(scope)
    if local == "a.main" or overlay.get("scope") == "all_documents":
        return str(root), "all_documents"
    slug = local.split(".", 1)[-1] if "." in local else local
    for cand in (root / slug, root / local):
        if cand.is_dir():
            return str(cand), "project"
    return str(root / slug), "project"


def load_agents(cfg: dict) -> dict:
    overlay = load_workspace_map()
    root = workspace_root(cfg)
    cloud = fetch_cloud_agents(cfg)
    agents: list[dict] = []
    seen: set[str] = set()

    def add(local: str, base: dict, o: dict) -> None:
        ws, scope = resolve_workspace(local, o, root)
        agent_dir = str(o.get("agent_dir") or (ROOT / "agents" / local))
        if "/Documents/AgentMail/" in agent_dir.replace("\\", "/"):
            agent_dir = str(ROOT / "agents" / local)
        slug = local.split(".", 1)[-1].replace(".", " ").title()
        agents.append(
            {
                "email": o.get("email") or base.get("email") or local,
                "local_part": local,
                "display_name": o.get("display_name") or base.get("display_name") or f"Agent {slug}",
                "workspace": ws,
                "agent_dir": agent_dir,
                "scope": scope,
            }
        )
        seen.add(local)

    for row in cloud:
        add(row["local_part"], row, overlay.get(row["local_part"]) or {})
    for local, o in overlay.items():
        if local in seen:
            continue
        if not (local.startswith("a.") or local.startswith("e.")):
            continue
        add(local, {}, o)

    if not agents and AGENTS_JSON.exists():
        try:
            return json.loads(AGENTS_JSON.read_text())
        except Exception:
            pass
    domain = ""
    if cloud:
        domain = cloud[0].get("domain") or ""
    elif AGENTS_JSON.exists():
        try:
            domain = json.loads(AGENTS_JSON.read_text()).get("domain") or ""
        except Exception:
            domain = ""
    return {"domain": domain, "agents": agents}


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
        m = re.search(r"([ae]\.[a-z0-9._+-]+)@", addr, re.I)
        if not m:
            continue
        local = m.group(1).lower()
        # Agent mailboxes: a.* (classic) + e.* (email-first identities, e.g. e.grokdesk)
        if local.startswith("a.") or local.startswith("e."):
            return local
    return None


def extract_agent_local(*fields) -> str | None:
    for field in fields:
        loc = extract_local(field)
        if loc:
            return loc
    return None


def _norm_email(raw: str) -> str:
    if access:
        return access.normalize_email(raw)
    s = (raw or "").strip().lower()
    m = re.search(r"<([^>]+)>", s)
    return (m.group(1) if m else s).strip("<>\"'")


def is_agent_addr(email: str) -> bool:
    local = (email or "").split("@")[0]
    return bool(re.match(r"^[ae]\.", local or "", re.I))


def emails_from_field(raw) -> list[str]:
    if raw is None or raw == "":
        return []
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            raw = parsed
        except Exception:
            raw = [p.strip() for p in raw.split(",") if p.strip()]
    if not isinstance(raw, list):
        raw = [raw]
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if isinstance(item, dict):
            addr = item.get("email") or item.get("address") or item.get("addr") or ""
        else:
            addr = str(item)
        email = _norm_email(addr)
        if not email or "@" not in email or email in seen or is_agent_addr(email):
            continue
        seen.add(email)
        out.append(email)
    return out


def thread_people(msg: dict, extra: list[str] | None = None) -> list[str]:
    people = (
        emails_from_field(msg.get("from_address"))
        + emails_from_field(msg.get("to_addresses"))
        + emails_from_field(msg.get("cc_addresses"))
        + (extra or [])
    )
    seen: set[str] = set()
    out: list[str] = []
    for e in people:
        if e in seen:
            continue
        seen.add(e)
        out.append(e)
    return out


def parse_trailers(text: str) -> tuple[str, list[str], list[str], str]:
    """Pull trailing TO:/CC:/NOTE: off the reply. Returns (body, to, cc, note)."""
    lines = (text or "").rstrip().splitlines()
    if not lines:
        return "", [], [], ""
    take: list[str] = []
    notes: list[str] = []
    i = len(lines) - 1
    while i >= 0:
        s = lines[i].strip()
        if not s:
            i -= 1
            continue
        if re.match(r"^---\s*(route|end)\s*---$", s, re.I):
            i -= 1
            continue
        if re.match(r"^(TO|CC)\s*:", s, re.I):
            take.append(s)
            i -= 1
            continue
        m = re.match(r"^NOTE\s*:\s*(.*)$", s, re.I)
        if m:
            n = m.group(1).strip()
            if n:
                notes.append(n)
            i -= 1
            continue
        break
    if not take and not notes:
        return (text or "").strip(), [], [], ""
    body = "\n".join(lines[: i + 1]).rstrip()
    to: list[str] = []
    cc: list[str] = []
    for line in reversed(take):
        m = re.match(r"^TO\s*:\s*(.*)$", line, re.I)
        if m:
            to.extend(emails_from_field(m.group(1)))
            continue
        m = re.match(r"^CC\s*:\s*(.*)$", line, re.I)
        if m:
            cc.extend(emails_from_field(m.group(1)))
    note = " ".join(reversed(notes)).strip()
    return body, to, cc, note


def parse_route_block(text: str) -> tuple[str, list[str], list[str]]:
    """Pull a trailing TO:/CC: block off the reply. Returns (body, to, cc)."""
    body, to, cc, _note = parse_trailers(text)
    return body, to, cc


def parse_note_block(text: str) -> tuple[str, str]:
    """Strip a trailing NOTE: card trailer. Returns (body with TO/CC kept, note)."""
    body, to, cc, note = parse_trailers(text)
    if to or cc:
        body = f"{body.rstrip()}\n\nTO: {', '.join(to)}\nCC: {', '.join(cc)}"
    return body, note


def looks_like_waiting_question(text: str) -> bool:
    """Clarifying question only → waiting. Finished work → not waiting."""
    compact = re.sub(r"\s+", " ", text or "").strip()
    if not compact or "?" not in compact:
        return False
    if len(compact) > 900:
        return False
    if re.search(r"\b(shipped|fixed|deployed|merged|committed|patched|installed)\b", compact, re.I):
        return False
    if re.search(r"\b(go deeper|write back if|want me to keep going)\b", compact, re.I):
        return False
    return True


def finish_stage(
    timed_out: bool,
    reply_text: str,
    questions_only: bool = False,
    process_error: bool = False,
) -> str:
    if timed_out or process_error:
        return "stuck"
    if questions_only or looks_like_waiting_question(reply_text):
        return "waiting"
    return "done"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_missing_table(code: int, data: object) -> bool:
    if int(code or 0) == 404:
        return True
    if isinstance(data, dict):
        err = str(data.get("code") or "")
        if err in ("PGRST205", "42P01"):
            return True
        blob = f"{data.get('message') or ''} {data.get('hint') or ''}".lower()
        if "does not exist" in blob or "schema cache" in blob:
            return True
    return False


def as_record(data: object) -> dict | None:
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    if isinstance(data, dict) and not isinstance(data, list) and data.get("id"):
        return data
    return None


def sb_headers(cfg: dict, extra: dict[str, str] | None = None) -> dict[str, str]:
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if extra:
        headers.update(extra)
    return headers


def sb_base(cfg: dict) -> str:
    return (cfg.get("SUPABASE_URL") or "").rstrip("/")


def remind_jobs_url(base: str) -> str:
    return (
        f"{base.rstrip('/')}/rest/v1/agent_jobs"
        f"?remind_requested_at=not.is.null&select={JOB_SELECT}"
        f"&order=remind_requested_at.asc"
    )


def job_upsert_payload(
    stage: str,
    *,
    existing: dict | None,
    agent: dict,
    session_id: int,
    rec: dict | None = None,
    msg: dict | None = None,
    used_k: int | None = None,
    used_tokens: int | None = None,
    notes: str | None = None,
) -> dict:
    """Shape a PostgREST agent_jobs row. received_at only on insert."""
    rec = rec or {}
    msg = msg or {}
    existing = existing or None
    now = now_iso()
    local = (agent.get("local_part") or (existing or {}).get("agent_local") or "").strip().lower()
    payload: dict = {
        "session_id": int(session_id),
        "agent_local": local,
        "stage": stage,
        "updated_at": now,
    }
    mailbox = agent.get("email") or (existing or {}).get("mailbox")
    if mailbox:
        payload["mailbox"] = mailbox
    base = (
        rec.get("base_subject")
        or (existing or {}).get("base_subject")
        or base_subject(msg.get("subject") or "")
    )
    payload["base_subject"] = base or "(no subject)"
    tid = rec.get("email_thread_id") or msg.get("thread_id") or (existing or {}).get("email_thread_id")
    if tid:
        payload["email_thread_id"] = tid
    mid = str(msg.get("id") or "")
    if mid and UUID_RE.match(mid):
        payload["last_message_id"] = mid
    if used_k is not None:
        payload["used_k"] = int(used_k)
    elif existing is None:
        payload["used_k"] = int(rec.get("used_k") or 1)
    if used_tokens is not None:
        payload["used_tokens"] = int(used_tokens)
    elif existing is None:
        payload["used_tokens"] = int(rec.get("used_tokens") or 0)
    if notes is not None and str(notes).strip():
        payload["notes"] = str(notes).strip()[:2000]
    elif existing is None:
        payload["notes"] = ""

    if existing is None:
        payload["received_at"] = now
    if stage == "working" and not (existing or {}).get("started_at"):
        payload["started_at"] = now
    if stage in ("done", "waiting", "stuck"):
        payload["last_reply_at"] = now
    if stage == "done":
        payload["done_at"] = now
    if stage == "stuck":
        payload["stuck_at"] = now
    return payload


def fetch_agent_job(cfg: dict, agent_local: str, session_id: int) -> dict | None:
    base = sb_base(cfg)
    if not base:
        return None
    url = (
        f"{base}/rest/v1/agent_jobs?agent_local=eq.{agent_local}"
        f"&session_id=eq.{int(session_id)}&select={JOB_SELECT}&limit=1"
    )
    code, data = curl_json("GET", url, sb_headers(cfg))
    if is_missing_table(code, data):
        return None
    if code != 200:
        return None
    return as_record(data)


def append_job_event(cfg: dict, job_id: str, kind: str, detail: str | None = None) -> None:
    base = sb_base(cfg)
    if not base or not job_id or not kind:
        return
    try:
        code, data = curl_json(
            "POST",
            f"{base}/rest/v1/agent_job_events",
            sb_headers(cfg, {"Prefer": "return=minimal"}),
            {"job_id": job_id, "kind": kind, "detail": (detail[:2000] if detail else None)},
        )
        if is_missing_table(code, data):
            log("kanban: agent_job_events missing — skip")
    except Exception as e:
        log(f"kanban event failed: {e}")


def write_kanban_stage(
    cfg: dict,
    stage: str,
    *,
    agent: dict,
    session_id: int,
    rec: dict | None = None,
    msg: dict | None = None,
    used_k: int | None = None,
    used_tokens: int | None = None,
    notes: str | None = None,
    extra_events: list[tuple[str, str | None]] | None = None,
) -> dict | None:
    """Upsert agent_jobs + events. Fail open — never raise to the mail path."""
    base = sb_base(cfg)
    if not base or not (cfg.get("SUPABASE_SERVICE_KEY") or ""):
        return None
    try:
        local = (agent.get("local_part") or "").strip().lower()
        existing = fetch_agent_job(cfg, local, session_id)
        payload = job_upsert_payload(
            stage,
            existing=existing,
            agent=agent,
            session_id=session_id,
            rec=rec,
            msg=msg,
            used_k=used_k,
            used_tokens=used_tokens,
            notes=notes,
        )
        headers = sb_headers(cfg, {"Prefer": "return=representation"})
        if existing and existing.get("id"):
            code, data = curl_json(
                "PATCH",
                f"{base}/rest/v1/agent_jobs?id=eq.{existing['id']}",
                headers,
                payload,
            )
        else:
            code, data = curl_json("POST", f"{base}/rest/v1/agent_jobs", headers, payload)
            if code in (409, 400) and not is_missing_table(code, data):
                existing = fetch_agent_job(cfg, local, session_id)
                if existing and existing.get("id"):
                    payload = job_upsert_payload(
                        stage,
                        existing=existing,
                        agent=agent,
                        session_id=session_id,
                        rec=rec,
                        msg=msg,
                        used_k=used_k,
                        used_tokens=used_tokens,
                        notes=notes,
                    )
                    code, data = curl_json(
                        "PATCH",
                        f"{base}/rest/v1/agent_jobs?id=eq.{existing['id']}",
                        headers,
                        payload,
                    )
        if is_missing_table(code, data):
            log("kanban: agent_jobs missing — skip")
            return None
        if code not in (200, 201):
            log(f"kanban write failed code={code} {str(data)[:200]}")
            return existing
        row = as_record(data) or existing
        if not row:
            return None
        job_id = str(row.get("id") or "")
        old_stage = (existing or {}).get("stage")
        if job_id and stage != old_stage:
            append_job_event(cfg, job_id, stage)
        if job_id and notes and str(notes).strip():
            append_job_event(cfg, job_id, "note", str(notes).strip())
        for kind, detail in extra_events or []:
            if job_id and kind:
                append_job_event(cfg, job_id, kind, detail)
        return row
    except Exception as e:
        log(f"kanban write failed: {e}")
        return None


def session_is_inflight(session_id: int) -> bool:
    with _state_lock:
        return int(session_id) in _inflight_sessions


def mark_session_inflight(session_id: int, on: bool) -> None:
    with _state_lock:
        if on:
            _inflight_sessions.add(int(session_id))
        else:
            _inflight_sessions.discard(int(session_id))


def ensure_session_for_job(sessions: dict, agent: dict, job: dict) -> tuple[int, dict]:
    """Reuse job.session_id. Never alloc a new one (Remind must stay on the card)."""
    sid = int(job.get("session_id") or 0)
    if sid <= 0:
        raise ValueError("remind job missing session_id")
    rec = sessions.get("by_id", {}).get(str(sid))
    if rec:
        rec["status"] = "open"
        rec["updated_at"] = now_iso()
        if job.get("email_thread_id") and not rec.get("email_thread_id"):
            rec["email_thread_id"] = job.get("email_thread_id")
        save_sessions(sessions)
        return sid, rec
    rec = {
        "id": sid,
        "agent_local": agent.get("local_part") or job.get("agent_local"),
        "workspace": agent.get("workspace"),
        "display_name": agent.get("display_name"),
        "base_subject": job.get("base_subject") or "(no subject)",
        "email_thread_id": job.get("email_thread_id"),
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "status": "open",
        "used_k": int(job.get("used_k") or 1),
        "used_tokens": int(job.get("used_tokens") or 0),
    }
    sessions.setdefault("by_id", {})[str(sid)] = rec
    if int(sessions.get("next_id") or 1) <= sid:
        sessions["next_id"] = sid + 1
    save_sessions(sessions)
    return sid, rec


def resolve_recipients(
    msg: dict,
    agent_local: str,
    store: dict | None,
    route_to: list[str],
    route_cc: list[str],
    session_people: list[str] | None = None,
) -> tuple[list[str], list[str]]:
    """Only allowlisted people. Default: To writer, CC everyone else already on the thread."""
    writer = _norm_email(msg.get("from_address") or "")
    people = thread_people(msg, session_people)

    def ok(email: str) -> bool:
        if not email or is_agent_addr(email):
            return False
        if access:
            return access.is_allowed(email, agent_local, store)
        return True

    allowed_thread = [e for e in people if ok(e)]
    want_to = [e for e in route_to if ok(e)]
    want_cc = [e for e in route_cc if ok(e) and e not in want_to]

    if want_to or want_cc:
        to = want_to[:]
        cc = want_cc[:]
        if writer and ok(writer) and writer not in to and writer not in cc:
            if to:
                cc.insert(0, writer)
            else:
                to = [writer]
        for e in allowed_thread:
            if e not in to and e not in cc:
                cc.append(e)
    else:
        to = [writer] if writer and ok(writer) else (allowed_thread[:1] if allowed_thread else [])
        cc = [e for e in allowed_thread if e not in to]

    # de-dupe, keep order
    def uniq(seq: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for e in seq:
            if e in seen:
                continue
            seen.add(e)
            out.append(e)
        return out

    to = uniq(to)
    cc = uniq([e for e in cc if e not in to])
    return to, cc


_APOS = r"['\u2019]"
PROCESS_OPEN = re.compile(
    rf"^(i(?:{_APOS}ll| will| am|{_APOS}m)|let me|pulling|checking|confirming|logging|"
    r"looking|reading|searching|fetching|opening|loading|writing|updating|"
    r"skimming|gathering|verifying|starting|working on|investigating|"
    r"querying|refining|releasing|creating|rewriting|taking|found|confirmed|"
    rf"next i(?:{_APOS}ll| will)?|got it[,.]?\s+(?:i{_APOS}ll|let me)|just (?:checked|"
    r"looking|pulled|read)|desk's|code gate|server is up|preview is up|"
    r"build is clean|screenshots are|live checkout)\b",
    re.I,
)
PROCESS_PHRASE = re.compile(
    r"\b(so the (?:reply|status(?: email)?) is accurate|then sending the reply|"
    r"project memory|logging this status|hidden pre-prompt|tool loop)\b",
    re.I,
)
FUTURE_PLAN = re.compile(
    rf"\b(?:i(?:{_APOS}ll| will)|next i(?:{_APOS}ll| will)?|let me)\b",
    re.I,
)
GREET_RE = re.compile(r"^(hey|hi|hello|good (?:morning|afternoon|evening))\b", re.I)
GREET_LINE_RE = re.compile(
    r"^(?:hey|hi|hello|good (?:morning|afternoon|evening))\b[^\n]{0,60},?\s*$",
    re.I | re.M,
)
STATUS_NOTE_RE = re.compile(
    rf"\b(?:got this|i(?:{_APOS}ll) write back when|not done yet|still on |"
    r"still at it|still cooking|hang tight|working it|not lost)\b",
    re.I,
)
SIGNOFF_RE = re.compile(
    r"^(making it happen|on it|that's the short of it|that's the 30k view|"
    r"easy win|all set|back in your court|we're good|done and dusted|"
    r"keep me posted|cheers|thanks|talk soon|got you|will do|still at it|"
    r"give me a bit|back shortly|working it|not lost)\b",
    re.I,
)
JOB_HINTS = re.compile(
    r"\b("
    r"fix|build|ship|deploy|create|add|implement|take over|take them|"
    r"rewrite|update|install|migrate|publish|make|wire|stand up|"
    r"include|generate|design|replace|remove|delete|merge|"
    r"take all|kick|handle|work on|need you to|please do|"
    r"can you (?:fix|build|add|make|ship|run|create)|"
    r"run (?:the|a|it|this)|do (?:it|this|that)"
    r")\b",
    re.I,
)
DONE_CLOSERS = [
    "Making it happen",
    "That's the short of it",
    "That's the 30k view",
    "Easy win",
    "All set",
    "Back in your court",
    "We're good",
    "Done and dusted",
    "On it",
]
ACK_CLOSERS = ["On it", "Working it", "Give me a bit", "Back shortly", "Not lost"]
ACK_AFTER_S = 25


def pick_closer(seed: str, pool: list[str]) -> str:
    n = 0
    for ch in seed:
        n = (n * 31 + ord(ch)) & 0xFFFFFFFF
    return pool[n % len(pool)]


def sender_first_name(from_addr: str, store: dict | None, msg: dict | None = None) -> str:
    email = _norm_email(from_addr)
    if store:
        for u in store.get("users") or []:
            if _norm_email(u.get("email") or "") == email:
                n = (u.get("first_name") or "").strip()
                if n:
                    return n.split()[0]
    name = ((msg or {}).get("from_name") or "").strip()
    if name:
        return name.split()[0]
    return "there"


def looks_like_job(msg: dict, questions_only: bool) -> bool:
    """Real work that will not have a reply in a few seconds."""
    if questions_only:
        return False
    body = plain_text(msg)
    body = re.split(r"\nOn .+ wrote:\n", body, maxsplit=1)[0]
    body = re.sub(r"^>.*$", "", body, flags=re.M)
    compact = re.sub(r"\s+", " ", body).strip()
    text = f"{msg.get('subject') or ''}\n{compact}"
    if not compact:
        return False
    if len(compact) < 100 and compact.endswith("?") and not JOB_HINTS.search(text):
        return False
    if JOB_HINTS.search(text):
        return True
    return len(compact) > 350


def status_note(kind: str, first: str, display: str, topic: str) -> str:
    topic = re.sub(r"\s+", " ", topic or "this").strip()[:90].rstrip(" .") or "this"
    body = f"Got this — I'm on {topic}. I'll write back when it's done."
    closer = pick_closer(topic + "ack", ACK_CLOSERS)
    return f"Hey {first},\n\n{body}\n\n{closer},\n{display}"


def unsquash_sentences(text: str) -> str:
    """Grok often glues status lines: 'accurate.Pulling' → split them."""
    return re.sub(r"([.!?])([A-Z])", r"\1\n\n\2", text or "")


def _is_status_note(chunk: str) -> bool:
    compact = re.sub(r"\s+", " ", chunk or "").strip()
    if not compact:
        return False
    return len(compact) < 320 and bool(STATUS_NOTE_RE.search(compact))


def extract_final_note(text: str) -> str:
    """Grok prints thinking turns to stdout. Keep only the last finished email."""
    text = (text or "").strip()
    if not text:
        return text
    matches = list(GREET_LINE_RE.finditer(text))
    if not matches:
        return text
    for m in reversed(matches):
        chunk = text[m.start() :].strip()
        if _is_status_note(chunk):
            continue
        return chunk
    return text[matches[-1].start() :].strip()


def _is_process(block: str) -> bool:
    first = block.split("\n", 1)[0].strip()
    if re.match(r"^(TO|CC)\s*:", first, re.I):
        return False
    if PROCESS_OPEN.match(first) or PROCESS_PHRASE.search(block):
        return True
    # Mid-job diary: "I'll pull that, then ship." Never the finished note.
    return bool(FUTURE_PLAN.search(block))


def _has_signoff(text: str, display: str) -> bool:
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    if not lines:
        return False
    tail = lines[-3:]
    if any(SIGNOFF_RE.match(ln.rstrip(",")) for ln in tail):
        return True
    disp = (display or "").strip().lower()
    return bool(disp and any(ln.lower() == disp for ln in tail))


def ensure_done_line(text: str) -> str:
    """Finished replies must state this turn is done. Insert before signoff if missing."""
    body = (text or "").strip()
    if not body:
        return body
    if DONE_LINE_RE.search(body):
        return body
    lines = body.splitlines()
    i = len(lines) - 1
    while i >= 0 and not lines[i].strip():
        i -= 1
    name_i = i
    i -= 1
    while i >= 0 and not lines[i].strip():
        i -= 1
    closer_i = i
    if (
        closer_i >= 0
        and name_i > closer_i
        and SIGNOFF_RE.match(lines[closer_i].strip().rstrip(","))
    ):
        insert_at = closer_i
        while insert_at > 0 and not lines[insert_at - 1].strip():
            insert_at -= 1
        lines = lines[:insert_at] + ["", "This turn is done."] + lines[insert_at:]
        return "\n".join(lines).strip()
    return body.rstrip() + "\n\nThis turn is done."


def shape_human_email(text: str, first: str, display: str) -> str:
    """Guarantee Hey First + closer + agent name + this-turn-is-done."""
    body = (text or "").strip()
    first = first or "there"
    display = display or "Agent"
    if not body or body == VAGUE_FALLBACK:
        body = EMPTY_DONE
    if not GREET_RE.match(body):
        body = f"Hey {first},\n\n{body}"
    if not _has_signoff(body, display):
        closer = pick_closer(body, DONE_CLOSERS)
        body = f"{body.rstrip()}\n\n{closer},\n{display}"
    return ensure_done_line(body)


def parse_grok_stdout(raw: str) -> tuple[str, int | None]:
    """Pull reply text (and optional usage) out of grok --output-format json."""
    s = (raw or "").strip()
    if not s:
        return "", None

    def from_obj(data: object) -> tuple[str, int | None] | None:
        if not isinstance(data, dict):
            return None
        if "text" not in data and "sessionId" not in data:
            return None
        text = str(data.get("text") or "")
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        total = usage.get("total_tokens") or usage.get("output_tokens")
        try:
            tokens = int(total) if total is not None else None
        except (TypeError, ValueError):
            tokens = None
        return text, tokens

    try:
        got = from_obj(json.loads(s))
        if got is not None:
            return got
    except json.JSONDecodeError:
        pass
    start = s.rfind("{")
    if start >= 0:
        try:
            got = from_obj(json.loads(s[start:]))
            if got is not None:
                return got
        except json.JSONDecodeError:
            pass
    return s, None


def clean_email_reply(raw: str, first: str = "there", display: str = "Agent") -> str:
    """Keep the last human email. Drop thinking / process narration."""
    text = (raw or "").strip()
    if not text:
        return shape_human_email("", first, display)
    fenced = re.fullmatch(r"```(?:text|markdown|md)?\s*\n(.*)\n```", text, re.S)
    if fenced:
        text = fenced.group(1).strip()
    body_only, route_to, route_cc, card_note = parse_trailers(text)
    text = body_only or text
    text = extract_final_note(text)
    text = unsquash_sentences(text)
    # Drop **Heading:** labels Grok loves — keep the line body
    text = re.sub(r"^\*{0,2}(?:what (?:it was|i did)|status|do this|raw)\*{0,2}:\s*", "", text, flags=re.I | re.M)
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    kept: list[str] = []
    for p in paras:
        lines = [ln.rstrip() for ln in p.splitlines()]
        good = [ln for ln in lines if ln.strip() and not _is_process(ln.strip())]
        if not good:
            continue
        # whole paragraph is process if the opener was
        if _is_process(p) and not any(ln.lstrip().startswith(("-", "*", "•")) for ln in good):
            continue
        kept.append("\n".join(good))
    if not kept:
        kept = [p for p in paras if not _is_process(p)]
    out = re.sub(r"\n{3,}", "\n\n", "\n\n".join(kept)).strip()
    out = shape_human_email(out[:12000], first, display)
    if route_to or route_cc:
        out = f"{out.rstrip()}\n\nTO: {', '.join(route_to)}\nCC: {', '.join(route_cc)}"
    if card_note:
        out = f"{out.rstrip()}\nNOTE: {card_note}"
    return out[:12000]


def reply_html(text: str) -> str:
    import html as html_lib

    blocks: list[str] = []
    para: list[str] = []
    bullets: list[str] = []

    def flush_para() -> None:
        if not para:
            return
        body = "<br>".join(html_lib.escape(x) for x in para)
        blocks.append(f'<p style="margin:0 0 12px">{body}</p>')
        para.clear()

    def flush_bullets() -> None:
        if not bullets:
            return
        items = "".join(f"<li style=\"margin:0 0 4px\">{html_lib.escape(b)}</li>" for b in bullets)
        blocks.append(f'<ul style="margin:0 0 12px;padding-left:20px">{items}</ul>')
        bullets.clear()

    for line in (text or "").splitlines():
        s = line.strip()
        if not s:
            flush_para()
            flush_bullets()
            continue
        m = re.match(r"^[-*•]\s+", s)
        if m:
            flush_para()
            bullets.append(s[m.end() :])
        else:
            flush_bullets()
            para.append(s)
    flush_para()
    flush_bullets()
    return (
        "<div style=\"font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;"
        "font-size:15px;line-height:1.45;color:#111\">"
        + "".join(blocks)
        + "</div>"
    )


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
    tool_tokens = 12_000 + int((wall / 60.0) * TOKENS_PER_MIN)
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
        f"?select=id,domain_id,address_id,from_address,from_name,to_addresses,cc_addresses,subject,body_text,body_html,"
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
    with _state_lock:
        inflight = set(_inflight)
    for msg in data:
        mid = msg.get("id")
        if not mid or mid in processed or str(mid) in inflight:
            continue
        local = extract_agent_local(msg.get("to_addresses"), msg.get("cc_addresses"))
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
        "used_tokens": 0,
    }
    sessions["by_id"][str(sid)] = rec
    save_sessions(sessions)
    return sid, rec


def is_reply_subject(subject: str) -> bool:
    return bool(REPLY_PREFIX_RE.match(strip_id_tag(subject or "").strip()))


def resolve_session(sessions: dict, agent: dict, msg: dict) -> tuple[int, dict, bool]:
    """Return (session_id, record, is_new).

    Same session: (ID: n) + same agent, or Re:/Fwd: of the same base + same agent,
    or same email_thread_id + same base + same agent.
    New session: no ID and a different base_subject — never reuse thread_id alone.
    """
    subj = msg.get("subject") or ""
    local = agent["local_part"]
    sid = parse_session_id(subj)
    if sid is not None and str(sid) in sessions["by_id"]:
        rec = sessions["by_id"][str(sid)]
        if rec.get("agent_local") == local:
            rec["updated_at"] = datetime.now(timezone.utc).isoformat()
            rec["status"] = "open"
            save_sessions(sessions)
            return sid, rec, False

    base = base_subject(subj)
    tid = msg.get("thread_id")

    def same_agent_open(rec: dict) -> bool:
        return rec.get("agent_local") == local and rec.get("status") == "open"

    if is_reply_subject(subj):
        for k, rec in sessions["by_id"].items():
            if same_agent_open(rec) and rec.get("base_subject") == base:
                rec["updated_at"] = datetime.now(timezone.utc).isoformat()
                if tid and not rec.get("email_thread_id"):
                    rec["email_thread_id"] = tid
                save_sessions(sessions)
                return int(k), rec, False

    # Same thread + same base (clients that omit Re:). Never if the base differs.
    if tid:
        for k, rec in sessions["by_id"].items():
            if (
                same_agent_open(rec)
                and rec.get("email_thread_id") == tid
                and rec.get("base_subject") == base
            ):
                rec["updated_at"] = datetime.now(timezone.utc).isoformat()
                save_sessions(sessions)
                return int(k), rec, False

    sid, rec = alloc_session(sessions, agent, msg, base)
    return sid, rec, True


def run_grok(
    cfg: dict,
    agent: dict,
    msg: dict,
    session_id: int,
    is_new: bool,
    grant: dict | None = None,
    store: dict | None = None,
    first_name: str = "there",
    on_slow: Callable[[str], None] | None = None,
    extra_instruction: str = "",
) -> tuple[str, dict]:
    """Run Grok Build for one email. Returns (reply_text, meta).

    meta: {turn_tokens, duration_s, timed_out, returncode}
    on_slow("ack") fires once if the job is still running after ACK_AFTER_S.
    """
    grok = cfg.get("GROK_BIN") or str(Path.home() / ".grok/bin/grok")
    workspace = agent["workspace"]
    max_turns = cfg.get("MAX_TURNS", "40")
    body = plain_text(msg)
    mid = str(msg.get("id") or "")
    files: list[dict] = []
    if mid and UUID_RE.match(mid):
        dest = STATE_DIR / "inbound-files" / str(session_id) / mid
        try:
            files = materialize_attachments(cfg, mid, dest)
        except Exception as e:
            log(f"files failed session={session_id}: {e}")
            files = []
    files_block = format_files_block(files)
    log(
        f"files session={session_id} n={len(files)} "
        f"names={[f.get('filename') for f in files][:8]}"
    )
    subject = msg.get("subject") or "(no subject)"
    from_addr = msg.get("from_address") or ""
    display = agent["display_name"]
    first = first_name or "there"
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

    people_now = thread_people(msg)
    allow_lines = []
    if access:
        allow = access.allowed_people(agent["local_part"], store)
        for p in allow:
            name = f"{p.get('first_name', '')} {p.get('last_name', '')}".strip()
            allow_lines.append(f"- {name} <{p['email']}>" if name else f"- {p['email']}")
    allow_block = "\n".join(allow_lines) or "- (none — only the writer if they are allowed)"
    on_thread = ", ".join(people_now) or "(just the writer)"

    extra = (extra_instruction or "").strip()
    extra_block = f"\n{extra}\n" if extra else ""
    prompt = f"""You are {display}. You write a normal email to a busy coworker. Not an agent log.
Session {session_id} — {"first email" if is_new else "continuation"}.
Their first name is {first}.
{extra_block}
Your stdout IS the email they receive. Print only the finished note, then a routing block.

HARD — one email, nothing else:
- Do the work with tools silently. Print ZERO words until the job is done.
- No thinking. No diary. No "I'll look up". No "next I'll". No status. No play-by-play.
- The worker already sent a "got it" note if this is a long job. Do not write another "I'm on it" or "still working".
- When done, print one normal human email. That is the only thing they should ever see.
- The finished email must say this turn is done. If more work is possible, still say this turn is done, then offer to go deeper.
- Never send a vague "I looked / write back if you want deeper" without a done line.

EMAIL SHAPE (HARD):
Hey {first},

So I looked at {{what they sent}} — {{one-line take}}.

{{2–5 short sentences in plain language. Write like a person talking, not a report.}}

{{whimsical closer that matches the vibe}},
{display}

Altitude:
- Default = 30,000 feet. Greeting + a few short sentences. That is the whole email.
- Bullets are optional. Use them only when a list is actually clearer (options, steps, 3+ parallel items). Never make the whole note a bullet stack.
- Expand ONLY if they said expand / zoom / detail / more on X / walk me through. Then expand that piece only.
- If they did not ask for detail, do not give it.

Voice:
- First line is always "Hey {first}," then a blank line.
- Sign off every time. Vary the closer (Making it happen / On it / That's the short of it / Easy win / Back in your court / All set / That's the 30k view). Never the same one twice in a row if you can help it.
- Simple language. Short sentences. No essay.
- One link if it helps. No URL dumps, no path dumps, no commit dumps.
- No subject line. No markdown headings. No **bold** labels. If you use bullets, use "- " only.
- Do not mention token counts, session IDs, or tool names.

You control To and CC. Only these people may receive mail (allowlist):
{allow_block}

Already on this email: {on_thread}
Writer: {from_addr}

End the reply with exactly:
TO: email
CC: email, email

Rules for routing:
- Default: TO the writer, CC everyone else already on the thread who is allowed.
- If they loop someone in and say talk to them / take it from here: TO that person, CC the writer (and anyone else already on the thread).
- Keep the original person CC'd when you start talking to someone new, unless they asked to be dropped.
- Never invent an address. Never BCC. Never mail anyone not on the allowlist.
- If they name someone who is not on the list, say they need to be added in Settings → Agents first. Do not email them.

Kanban (board in the mail app for this same session — do not mail about it):
- John sees this chain as a card: received → working → waiting → done (stuck on timeout).
- When this turn is done, say so in the email (already required).
- If you need John to answer before you can finish, ask one short question — the card will show Waiting.
- You may leave a short card note (one or two sentences). After the TO/CC block, print exactly:
NOTE: ...
- The worker strips NOTE from the mailed body and writes it on the card. Do not mention the board, the card, or the NOTE line in the email itself.

Workspace (do not mention unless asked): {workspace}
Scope: {"ALL projects under ~/Documents" if scope == "all_documents" else "this project only"}
{hist_block}
New email from: {from_addr}
Subject: {subject}

Email body:
{body}

{files_block}

{lock}

Rules:
{work_rule}
- If unclear, ask one short clarifying question.
- Never invent secrets. Never send mail yourself.
- Prefer finishing with a partial useful answer over running forever.
"""

    append_history(session_id, "user", f"Subject: {subject}\n\n{body}\n\n{files_block}")

    cmd = [grok, "--cwd", workspace]
    if flags.get("always_approve", True):
        cmd += ["--always-approve"]
    cmd += ["--permission-mode", str(flags.get("permission_mode") or "bypassPermissions")]
    if flags.get("disallowed_tools"):
        cmd += ["--disallowed-tools", ",".join(flags["disallowed_tools"])]
    for rule in flags.get("deny_rules") or []:
        cmd += ["--deny", rule]
    cmd += ["--output-format", "json", "--max-turns", str(max_turns), "-p", prompt]
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
    sent_ack = False
    usage_tokens: int | None = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=workspace if Path(workspace).is_dir() else str(Path.home()),
        )
        while True:
            elapsed = time.time() - t0
            if elapsed >= timeout_s:
                proc.kill()
                timed_out = True
                break
            wakes = [timeout_s - elapsed]
            if on_slow and not sent_ack:
                wakes.append(max(0.2, ACK_AFTER_S - elapsed))
            try:
                proc.wait(timeout=min(wakes))
                break
            except subprocess.TimeoutExpired:
                touch_lock()
                elapsed = time.time() - t0
                if on_slow and not sent_ack and elapsed >= ACK_AFTER_S:
                    try:
                        on_slow("ack")
                    except Exception as e:
                        log(f"ack send failed: {e}")
                    sent_ack = True
        out, err = proc.communicate()
        stdout, usage_tokens = parse_grok_stdout(out or "")
        stderr = err or ""
        rc = -1 if timed_out else int(proc.returncode if proc.returncode is not None else -1)
    except Exception as e:
        log(f"grok spawn failed session={session_id}: {e}")
        stdout = ""
        stderr = str(e)
        rc = -1
        usage_tokens = None
    if timed_out:
        log(f"grok TIMEOUT session={session_id} after {timeout_s}s partial_out={len(stdout)} partial_err={len(stderr)}")
    duration_s = time.time() - t0

    if timed_out:
        partial = clean_email_reply(stdout, first, display)
        if partial and len(re.sub(r"\s+", " ", partial)) > 120:
            text = shape_human_email(partial[:11000].rstrip() + "\n\n" + TIMEOUT_PARTIAL, first, display)
        else:
            text = shape_human_email(TIMEOUT_EMPTY, first, display)
    else:
        if rc != 0:
            log(f"grok nonzero rc={rc} err={stderr[:400]}")
        text = clean_email_reply(stdout, first, display)
        if not text.strip() or VAGUE_FALLBACK in text:
            text = shape_human_email(EMPTY_DONE, first, display)

    append_history(session_id, "assistant", text)
    # Subject numerator is this session's wall-clock estimate only.
    # Grok JSON total_tokens is the model window — never paint that as used.
    _ = usage_tokens
    turn_tokens = estimate_turn_tokens(
        prompt, stdout, stderr, duration_s=duration_s, timed_out=timed_out
    )
    process_error = (not timed_out) and rc != 0 and not (stdout or "").strip()
    log(
        f"grok done session={session_id} timed_out={timed_out} "
        f"dur={duration_s:.0f}s turn_tokens≈{turn_tokens} reply_chars={len(text)}"
    )
    return text, {
        "turn_tokens": turn_tokens,
        "duration_s": duration_s,
        "timed_out": timed_out,
        "returncode": rc,
        "process_error": process_error,
    }


def send_reply(
    cfg: dict,
    agent: dict,
    msg: dict,
    reply_text: str,
    subject: str,
    *,
    to: list[str] | None = None,
    cc: list[str] | None = None,
) -> bool:
    from_addr = agent.get("email") or f"{agent['local_part']}@{(load_agents().get('domain') or 'localhost')}"
    from_header = f"{agent['display_name']} <{from_addr}>"
    to_list = [e for e in (to or []) if e]
    cc_list = [e for e in (cc or []) if e and e not in to_list]
    if not to_list:
        fallback = _norm_email(msg.get("from_address") or "")
        if fallback:
            to_list = [fallback]
    if not to_list:
        log("no recipients; skip send")
        return False

    payload = {
        "from": from_header,
        "to": to_list,
        "subject": subject,
        "text": reply_text,
        "html": reply_html(reply_text),
    }
    if cc_list:
        payload["cc"] = cc_list
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
        rid = data.get("id") if isinstance(data, dict) else None
        log(
            f"sent reply session_subj={subject!r} to={to_list} cc={cc_list} "
            f"id={rid}"
        )
        try:
            persist_outbound_reply(cfg, agent, msg, subject, reply_text, to_list, cc_list, rid)
        except Exception as e:
            log(f"persist outbound: {e}")
        return True
    log(f"send failed code={code} {str(data)[:300]}")
    return False


def persist_outbound_reply(
    cfg: dict,
    agent: dict,
    msg: dict,
    subject: str,
    reply_text: str,
    to_list: list[str],
    cc_list: list[str],
    resend_id: str | None,
) -> None:
    """Store the sent agent reply so the Kanban card thread can show it."""
    base = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    if not base or not key:
        return
    from_addr = agent.get("email") or f"{agent['local_part']}@freecoffee.dev"
    payload = {
        "domain_id": msg.get("domain_id"),
        "address_id": msg.get("address_id"),
        "resend_email_id": resend_id,
        "direction": "outbound",
        "from_address": from_addr,
        "from_name": agent.get("display_name") or "Agent",
        "to_addresses": to_list,
        "cc_addresses": cc_list,
        "subject": subject,
        "body_text": reply_text,
        "body_html": reply_html(reply_text),
        "thread_id": msg.get("thread_id"),
        "is_read": True,
        "folder": "agent",
        "received_at": datetime.now(timezone.utc).isoformat(),
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    code, data = curl_json(
        "POST",
        f"{base}/rest/v1/email_messages",
        {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Prefer": "return=minimal",
        },
        payload,
    )
    if code not in (200, 201, 204):
        log(f"persist outbound code={code} {str(data)[:200]}")


def claim_message(cfg: dict, mid: str, via: str) -> bool:
    """Insert handled row first so local + box + cloud-chat cannot double-run."""
    base = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    if not base or not key or not mid:
        return True
    try:
        code, data = curl_json(
            "POST",
            f"{base}/rest/v1/agent_handled_messages",
            {
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Prefer": "return=representation",
            },
            {"message_id": mid, "via": via},
        )
        if code in (200, 201):
            return True
        if code == 409:
            return False
        # unique violation sometimes 400 + 23505
        if isinstance(data, dict) and data.get("code") == "23505":
            return False
        log(f"claim unexpected code={code}")
        return True
    except Exception as e:
        log(f"claim failed: {e}")
        return True


def release_claim(cfg: dict, mid: str) -> None:
    base = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    if not base or not key or not mid:
        return
    try:
        curl_json(
            "DELETE",
            f"{base}/rest/v1/agent_handled_messages?message_id=eq.{mid}",
            {"apikey": key, "Authorization": f"Bearer {key}"},
        )
    except Exception:
        pass


def cloud_already_handled(cfg: dict, mid: str) -> bool:
    base = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    if not base or not key or not mid:
        return False
    try:
        code, data = curl_json(
            "GET",
            f"{base}/rest/v1/agent_handled_messages?message_id=eq.{mid}&select=via",
            {"apikey": key, "Authorization": f"Bearer {key}"},
        )
        return code == 200 and isinstance(data, list) and len(data) > 0
    except Exception:
        return False


def cloud_hands(cfg: dict) -> str:
    base = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    if not base or not key:
        return "auto"
    try:
        code, data = curl_json(
            "GET",
            f"{base}/rest/v1/agent_runtime?id=eq.1&select=hands",
            {"apikey": key, "Authorization": f"Bearer {key}"},
        )
        if code == 200 and isinstance(data, list) and data:
            h = str(data[0].get("hands") or "auto")
            if h in ("local", "api", "auto", "box"):
                return h
    except Exception:
        pass
    return "auto"


def heartbeat(cfg: dict) -> None:
    """Tell Settings → Setup that this machine is alive."""
    base = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SERVICE_KEY") or ""
    if not base or not key:
        return
    now = datetime.now(timezone.utc).isoformat()
    via = (os.environ.get("AGENTMAIL_VIA") or "local").strip().lower()
    field = "box_seen_at" if via == "box" else "worker_seen_at"
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    try:
        body = {field: now, "updated_at": now}
        code, data = curl_json(
            "PATCH",
            f"{base}/rest/v1/agent_runtime?id=eq.1",
            headers,
            body,
        )
        if code in (200, 204) and (data == [] or data is None):
            curl_json(
                "POST",
                f"{base}/rest/v1/agent_runtime",
                headers,
                {"id": 1, "hands": "auto", field: now, "updated_at": now},
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
            "Ask the owner to enable it in Settings → Agents."
        )
    return f"This mailbox is restricted. {name} didn't run your message."


def _mark_processed(mid: str) -> None:
    mark_processed(mid)


def _execute_session_turn(
    cfg: dict,
    agent: dict,
    msg: dict,
    sid: int,
    is_new: bool,
    grant: dict,
    cloud_store: dict | None,
    first: str,
    q_only: bool,
    extra_instruction: str = "",
) -> None:
    local = agent["local_part"]
    mid = msg["id"]
    from_addr = msg.get("from_address") or ""
    display = agent.get("display_name") or "Agent"
    with _state_lock:
        sessions = load_sessions()
        rec = sessions["by_id"].get(str(sid)) or {}
        rec_snap = dict(rec)
    default_to, default_cc = resolve_recipients(
        msg, local, cloud_store, [], [], rec_snap.get("thread_people") or []
    )
    write_kanban_stage(cfg, "working", agent=agent, session_id=sid, rec=rec_snap, msg=msg)

    def send_status(kind: str) -> None:
        with _state_lock:
            live = load_sessions()["by_id"].get(str(sid)) or rec_snap
        topic = live.get("base_subject") or base_subject(msg.get("subject") or "")
        used_k = int(live.get("used_k") or 1)
        subj_s = format_reply_subject(topic, sid, used_k)
        note = status_note(kind, first, display, topic)
        send_reply(cfg, agent, msg, note, subj_s, to=default_to, cc=default_cc)
        append_history(sid, "assistant", note)
        log(f"{kind} sent session={sid} to={default_to}")

    reply, meta = run_grok(
        cfg,
        agent,
        msg,
        sid,
        is_new,
        grant=grant,
        store=cloud_store,
        first_name=first,
        on_slow=send_status if looks_like_job(msg, q_only) else None,
        extra_instruction=extra_instruction,
    )
    history = load_history(sid)
    with _state_lock:
        sessions = load_sessions()
        rec = sessions["by_id"].get(str(sid))
        if rec is None:
            rec = rec_snap
            sessions["by_id"][str(sid)] = rec
        prev_k = int(rec.get("used_k") or 1)
        prev_tokens = int(rec.get("used_tokens") or 0)
        if prev_tokens <= 0 and prev_k > 1:
            prev_tokens = prev_k * 1000
        turn_tokens = int(meta.get("turn_tokens") or 0)
        used_tokens = prev_tokens + turn_tokens
        used_k = estimate_used_k(history, prev_k, used_tokens=used_tokens)
        rec["used_tokens"] = used_tokens
        rec["used_k"] = used_k
        rec["updated_at"] = datetime.now(timezone.utc).isoformat()
        if msg.get("thread_id") and not rec.get("email_thread_id"):
            rec["email_thread_id"] = msg.get("thread_id")
        body, route_to, route_cc, card_note = parse_trailers(reply)
        to_list, cc_list = resolve_recipients(
            msg,
            local,
            cloud_store,
            route_to,
            route_cc,
            rec.get("thread_people") or [],
        )
        rec["thread_people"] = thread_people(msg, (rec.get("thread_people") or []) + to_list + cc_list)
        sessions["by_id"][str(sid)] = rec
        save_sessions(sessions)
        topic = rec.get("base_subject") or base_subject(msg.get("subject") or "")
        rec_live = dict(rec)
    mailed = body or reply
    subj = format_reply_subject(topic, sid, used_k)
    sent = send_reply(cfg, agent, msg, mailed, subj, to=to_list, cc=cc_list)
    stage = finish_stage(
        bool(meta.get("timed_out")),
        mailed,
        questions_only=q_only,
        process_error=bool(meta.get("process_error")) or not sent,
    )
    extras: list[tuple[str, str | None]] = []
    if sent:
        extras.append(("reply", subj))
    write_kanban_stage(
        cfg,
        stage,
        agent=agent,
        session_id=sid,
        rec=rec_live,
        msg=msg,
        used_k=used_k,
        used_tokens=used_tokens,
        notes=card_note or None,
        extra_events=extras,
    )

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
                "stage": stage,
                "subject": subj,
                "msg_id": mid,
                "from": from_addr,
                "reply_preview": mailed[:2000],
                "at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
    )


def _run_claimed_job(
    cfg: dict,
    agent: dict,
    msg: dict,
    sid: int,
    is_new: bool,
    grant: dict,
    cloud_store: dict | None,
    first: str,
    q_only: bool,
    extra_instruction: str = "",
) -> None:
    mid = msg["id"]
    try:
        mark_session_inflight(sid, True)
        with session_lock_for(sid):
            _execute_session_turn(
                cfg,
                agent,
                msg,
                sid,
                is_new,
                grant,
                cloud_store,
                first,
                q_only,
                extra_instruction=extra_instruction,
            )
    except Exception as e:
        log(f"process error msg={str(mid)[:8]}: {e}")
        traceback.print_exc()
        rec = None
        try:
            with _state_lock:
                rec = load_sessions()["by_id"].get(str(sid))
            write_kanban_stage(cfg, "stuck", agent=agent, session_id=sid, rec=rec, msg=msg)
        except Exception:
            pass
        release_claim(cfg, str(mid))
    finally:
        mark_session_inflight(sid, False)
        _mark_processed(mid)
        touch_lock()


def fetch_message_by_id(cfg: dict, mid: str) -> dict | None:
    base = sb_base(cfg)
    if not base or not mid or not UUID_RE.match(str(mid)):
        return None
    try:
        code, data = curl_json(
            "GET",
            f"{base}/rest/v1/email_messages?id=eq.{mid}"
            f"&select=id,from_address,from_name,to_addresses,cc_addresses,subject,"
            f"body_text,body_html,thread_id,resend_email_id,received_at,direction&limit=1",
            sb_headers(cfg),
        )
        if code == 200:
            return as_record(data)
    except Exception as e:
        log(f"kanban fetch message failed: {e}")
    return None


def fetch_remind_jobs(cfg: dict) -> list[dict]:
    base = sb_base(cfg)
    if not base or not (cfg.get("SUPABASE_SERVICE_KEY") or ""):
        return []
    try:
        code, data = curl_json("GET", remind_jobs_url(base), sb_headers(cfg))
        if is_missing_table(code, data):
            log("kanban: agent_jobs missing — skip remind")
            return []
        if code != 200 or not isinstance(data, list):
            if code not in (200, 404):
                log(f"kanban remind fetch failed code={code}")
            return []
        return [j for j in data if isinstance(j, dict)]
    except Exception as e:
        log(f"kanban remind fetch failed: {e}")
        return []


def claim_remind(cfg: dict, job_id: str) -> bool:
    """Clear remind_requested_at if still set. Empty PATCH result = lost the race."""
    base = sb_base(cfg)
    if not base or not job_id:
        return False
    try:
        now = now_iso()
        code, data = curl_json(
            "PATCH",
            f"{base}/rest/v1/agent_jobs?id=eq.{job_id}&remind_requested_at=not.is.null",
            sb_headers(cfg, {"Prefer": "return=representation"}),
            {"remind_requested_at": None, "updated_at": now},
        )
        if is_missing_table(code, data):
            return False
        if code not in (200, 201):
            return False
        return as_record(data) is not None
    except Exception as e:
        log(f"kanban claim remind failed: {e}")
        return False


def _run_remind_job(
    cfg: dict,
    agent: dict,
    job: dict,
    cloud_store: dict | None,
) -> None:
    sid = int(job.get("session_id") or 0)
    job_id = str(job.get("id") or "")
    try:
        mark_session_inflight(sid, True)
        with session_lock_for(sid):
            with _state_lock:
                sessions = load_sessions()
                sid, rec = ensure_session_for_job(sessions, agent, job)
            src = fetch_message_by_id(cfg, str(job.get("last_message_id") or ""))
            msg = dict(src or {})
            msg["body_text"] = REMIND_USER_TEXT
            msg["body_html"] = ""
            msg["subject"] = msg.get("subject") or f"Re: {rec.get('base_subject') or job.get('base_subject') or '(no subject)'}"
            msg["_agent_local"] = agent["local_part"]
            if not msg.get("id"):
                msg["id"] = f"remind-{job_id or sid}"
            if job.get("email_thread_id") and not msg.get("thread_id"):
                msg["thread_id"] = job.get("email_thread_id")
            if not msg.get("from_address"):
                people = rec.get("thread_people") or []
                if people:
                    msg["from_address"] = people[0]
            from_addr = msg.get("from_address") or ""
            first = sender_first_name(from_addr, cloud_store, msg) if from_addr else "there"
            grant: dict = {"enabled": True, "mode": "all"}
            q_only = False
            if access and from_addr:
                auth = access.authorize(from_addr, agent["local_part"], cloud_store)
                if auth.get("ok") and auth.get("grant"):
                    grant = auth["grant"]
                    q_only = bool(access.grok_invocation(grant).get("questions_only"))
            log(f"remind session={sid} agent={agent['local_part']} job={job_id[:8]}")
            _execute_session_turn(
                cfg,
                agent,
                msg,
                sid,
                False,
                grant,
                cloud_store,
                first,
                q_only,
                extra_instruction=REMIND_USER_TEXT,
            )
    except Exception as e:
        log(f"remind error session={sid}: {e}")
        traceback.print_exc()
        try:
            write_kanban_stage(cfg, "stuck", agent=agent, session_id=sid, rec=None, msg=None)
        except Exception:
            pass
    finally:
        mark_session_inflight(sid, False)
        touch_lock()


def process_reminds(cfg: dict, agents: dict[str, dict], cloud_store: dict | None) -> None:
    jobs = fetch_remind_jobs(cfg)
    if not jobs:
        return
    pool = get_job_pool()
    for job in jobs:
        sid = int(job.get("session_id") or 0)
        local = str(job.get("agent_local") or "").strip().lower()
        agent = agents.get(local)
        job_id = str(job.get("id") or "")
        if not agent or sid <= 0 or not job_id:
            log(f"remind skip bad job session={sid} agent={local}")
            continue
        if session_is_inflight(sid):
            log(f"remind skip inflight session={sid}")
            continue
        if not claim_remind(cfg, job_id):
            log(f"remind skip unclaimed job={job_id[:8]}")
            continue
        fut = pool.submit(_run_remind_job, cfg, agent, job, cloud_store)
        fut.add_done_callback(
            lambda f: (log(f"remind thread error: {f.exception()}") if f.exception() else None)
        )


def process_once(cfg: dict) -> None:
    """Claim new mail and dispatch Grok jobs. Returns while other sessions still run."""
    touch_lock()
    agents_doc = load_agents(cfg)
    agents = by_local(agents_doc)
    processed = load_processed()
    cloud_store = None
    if access:
        access.ensure_store()
        cloud_store = fetch_allowlist(cfg)

    process_reminds(cfg, agents, cloud_store)

    msgs = fetch_new_messages(cfg, list(agents.keys()), processed)
    if not msgs:
        return

    log(f"found {len(msgs)} new agent mail(s)")
    pool = get_job_pool()
    for msg in msgs:
        mid = msg["id"]
        with _state_lock:
            if str(mid) in _inflight:
                continue
        if cloud_already_handled(cfg, str(mid)):
            log(f"skip already-handled msg={str(mid)[:8]}")
            _mark_processed(mid)
            continue
        local = msg["_agent_local"]
        agent = agents.get(local)
        if not agent:
            _mark_processed(mid)
            continue
        from_addr = msg.get("from_address") or ""
        if access:
            auth = access.authorize(from_addr, local, cloud_store)
        else:
            trust_raw = cfg.get("TRUSTED_SENDERS", "")
            patterns = [p.strip() for p in trust_raw.split(",") if p.strip()]
            auth = {"ok": trusted(from_addr, patterns), "reason": "legacy", "grant": {"enabled": True, "mode": "all"}}
        if auth.get("ok") and cloud_hands(cfg) == "api":
            grant = auth.get("grant") or {}
            perms = grant.get("perms") or {}
            ask = grant.get("mode") == "ask" or not any(perms.get(k) for k in ("write", "update", "delete"))
            if ask:
                log(f"skip ask-only; hands=api msg={str(mid)[:8]}")
                _mark_processed(mid)
                continue
        if not auth.get("ok"):
            reason = auth.get("reason") or "unknown"
            log(f"block {reason} from={from_addr} agent={local} msg={str(mid)[:8]}")
            if reason == "no_agent":
                try:
                    base = base_subject(msg.get("subject") or "")
                    send_reply(cfg, agent, msg, deny_reply(agent, reason), f"Re: {base}")
                except Exception as e:
                    log(f"deny-reply failed: {e}")
            _mark_processed(mid)
            continue
        via = (os.environ.get("AGENTMAIL_VIA") or "local").strip().lower()
        if not claim_message(cfg, str(mid), via):
            log(f"skip claimed msg={str(mid)[:8]}")
            _mark_processed(mid)
            continue
        with _state_lock:
            if str(mid) in _inflight:
                continue
            sessions = load_sessions()
            sid, _rec, is_new = resolve_session(sessions, agent, msg)
            _inflight.add(str(mid))
        write_kanban_stage(cfg, "received", agent=agent, session_id=sid, rec=_rec, msg=msg)
        grant = auth.get("grant") or {}
        first = sender_first_name(from_addr, cloud_store, msg)
        q_only = False
        if access:
            q_only = bool(access.grok_invocation(grant).get("questions_only"))
        log(f"dispatch session={sid} new={is_new} agent={local} msg={str(mid)[:8]}")
        fut = pool.submit(
            _run_claimed_job,
            cfg,
            agent,
            msg,
            sid,
            is_new,
            grant,
            cloud_store,
            first,
            q_only,
        )
        fut.add_done_callback(
            lambda f: (log(f"job thread error: {f.exception()}") if f.exception() else None)
        )


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
    log(f"email worker start poll={poll}s pid={os.getpid()} sessions=on parallel={MAX_PARALLEL}")
    try:
        boot_agents = load_agents(cfg)
        log(f"agents n={len(boot_agents.get('agents') or [])} workspaces={WORKSPACES_JSON.exists()} overlay={AGENTS_JSON.exists()}")
    except Exception as e:
        log(f"agents boot: {e}")
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
                touch_lock()
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
