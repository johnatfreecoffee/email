"""P1 tests: session identity, context tag, done signaling, parallel vs serial.

Must set AGENTMAIL_HOME before importing worker.py (import mkdirs state).
"""

from __future__ import annotations

import importlib.util
import os
import re
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

_TMP = tempfile.mkdtemp(prefix="am-test-")
os.environ["AGENTMAIL_HOME"] = _TMP

_WORKER_PY = Path(__file__).resolve().parent / "worker.py"
_spec = importlib.util.spec_from_file_location("agentmail_worker", _WORKER_PY)
assert _spec and _spec.loader
worker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(worker)


def _agent(local: str = "a.test") -> dict:
    d = Path(_TMP) / "agents" / local
    d.mkdir(parents=True, exist_ok=True)
    return {
        "local_part": local,
        "workspace": str(_TMP),
        "display_name": "Agent Test",
        "agent_dir": str(d),
        "email": f"{local}@example.com",
        "scope": "project",
    }


def _msg(mid: str, subject: str, thread: str = "t1") -> dict:
    return {
        "id": mid,
        "subject": subject,
        "thread_id": thread,
        "from_address": "john@example.com",
        "from_name": "John",
        "to_addresses": ["a.test@example.com"],
        "body_text": "please fix the login now",
    }


def _empty_sessions() -> dict:
    return {"next_id": 1, "by_id": {}}


class SessionIdentity(unittest.TestCase):
    def test_new_subject_different_base_not_reused_by_thread_id(self) -> None:
        sessions = _empty_sessions()
        agent = _agent()
        sid1, rec1, new1 = worker.resolve_session(
            sessions, agent, {"subject": "Ship the kanban", "thread_id": "tid-1"}
        )
        self.assertTrue(new1)
        self.assertEqual(rec1["base_subject"], "Ship the kanban")
        sid2, rec2, new2 = worker.resolve_session(
            sessions, agent, {"subject": "Totally different ask", "thread_id": "tid-1"}
        )
        self.assertTrue(new2)
        self.assertNotEqual(sid1, sid2)
        self.assertEqual(rec2["base_subject"], "Totally different ask")

    def test_id_tag_same_agent_continues(self) -> None:
        sessions = _empty_sessions()
        agent = _agent()
        sid1, _, _ = worker.resolve_session(
            sessions, agent, {"subject": "Help with inbox", "thread_id": "t-a"}
        )
        sid2, rec, is_new = worker.resolve_session(
            sessions,
            agent,
            {"subject": f"Re: Help with inbox (ID: {sid1} - 12/500K)", "thread_id": "other"},
        )
        self.assertFalse(is_new)
        self.assertEqual(sid1, sid2)
        self.assertEqual(rec["id"], sid1)

    def test_id_tag_other_agent_is_new(self) -> None:
        sessions = _empty_sessions()
        sid1, _, _ = worker.resolve_session(
            sessions, _agent("a.noknok"), {"subject": "Help", "thread_id": "t-a"}
        )
        sid2, _, is_new = worker.resolve_session(
            sessions,
            _agent("a.email"),
            {"subject": f"Re: Help (ID: {sid1} - 2/500K)", "thread_id": "t-a"},
        )
        self.assertTrue(is_new)
        self.assertNotEqual(sid1, sid2)

    def test_re_same_base_same_agent(self) -> None:
        sessions = _empty_sessions()
        agent = _agent()
        sid1, _, _ = worker.resolve_session(
            sessions, agent, {"subject": "Fix the pager", "thread_id": "t-new"}
        )
        sid2, _, is_new = worker.resolve_session(
            sessions, agent, {"subject": "Re: Fix the pager", "thread_id": "t-other"}
        )
        self.assertFalse(is_new)
        self.assertEqual(sid1, sid2)

    def test_fwd_same_base_same_agent(self) -> None:
        sessions = _empty_sessions()
        agent = _agent()
        sid1, _, _ = worker.resolve_session(
            sessions, agent, {"subject": "Fix the pager", "thread_id": "t-new"}
        )
        sid2, _, is_new = worker.resolve_session(
            sessions, agent, {"subject": "Fwd: Fix the pager", "thread_id": "t-fwd"}
        )
        self.assertFalse(is_new)
        self.assertEqual(sid1, sid2)

    def test_brand_new_same_title_without_re_is_new_session(self) -> None:
        sessions = _empty_sessions()
        agent = _agent()
        sid1, _, _ = worker.resolve_session(
            sessions, agent, {"subject": "Help", "thread_id": "t1"}
        )
        sid2, _, is_new = worker.resolve_session(
            sessions, agent, {"subject": "Help", "thread_id": "t2"}
        )
        self.assertTrue(is_new)
        self.assertNotEqual(sid1, sid2)

    def test_same_thread_same_base_without_re_continues(self) -> None:
        sessions = _empty_sessions()
        agent = _agent()
        sid1, _, _ = worker.resolve_session(
            sessions, agent, {"subject": "Fix the pager", "thread_id": "tid-9"}
        )
        sid2, _, is_new = worker.resolve_session(
            sessions, agent, {"subject": "Fix the pager", "thread_id": "tid-9"}
        )
        self.assertFalse(is_new)
        self.assertEqual(sid1, sid2)


class ContextTag(unittest.TestCase):
    def test_sixty_seconds_is_per_minute_not_per_second(self) -> None:
        tokens = worker.estimate_turn_tokens("", "", "", duration_s=60, timed_out=False)
        self.assertEqual(tokens, 12_000 + 2_500)
        self.assertLess(tokens, 50_000)
        self.assertNotEqual(tokens, 12_000 + 150_000)

    def test_two_minute_job_not_500(self) -> None:
        tokens = worker.estimate_turn_tokens("p", "out", "", duration_s=120, timed_out=False)
        self.assertLess(worker.tokens_to_used_k(tokens), 500)
        self.assertLess(tokens, 40_000)

    def test_new_session_starts_small(self) -> None:
        self.assertEqual(worker.tokens_to_used_k(0), 1)
        self.assertEqual(worker.tokens_to_used_k(800), 1)
        self.assertLess(worker.estimate_used_k([], 1, used_tokens=3_000), 10)

    def test_short_turn_cannot_paint_500(self) -> None:
        tokens = worker.estimate_turn_tokens("short", "ok", "", duration_s=5, timed_out=False)
        self.assertLess(worker.tokens_to_used_k(tokens), 50)

    def test_accumulated_can_reach_500(self) -> None:
        self.assertEqual(worker.tokens_to_used_k(500_000), 500)
        self.assertEqual(worker.tokens_to_used_k(499_000), 499)
        subj = worker.format_reply_subject("Fix login", 1, worker.tokens_to_used_k(12_000 + 2_500))
        self.assertEqual(subj, "Re: Fix login (ID: 1 - 15/500K)")

    def test_run_grok_ignores_total_tokens(self) -> None:
        text, usage = worker.parse_grok_stdout(
            '{"text":"Hey John,\\n\\nHi.","usage":{"total_tokens":500000}}'
        )
        self.assertEqual(usage, 500000)
        self.assertIn("Hey John", text)
        est = worker.estimate_turn_tokens("p", text, "", duration_s=8, timed_out=False)
        self.assertNotEqual(worker.tokens_to_used_k(est), 500)


class DoneSignaling(unittest.TestCase):
    def test_empty_body_not_vague_fallback(self) -> None:
        out = worker.shape_human_email("", "John", "Agent Test")
        self.assertNotIn(worker.VAGUE_FALLBACK, out)
        self.assertNotEqual(worker.EMPTY_DONE, worker.VAGUE_FALLBACK)
        self.assertRegex(out, worker.DONE_LINE_RE)
        self.assertTrue(out.startswith("Hey John"))
        self.assertRegex(out, re.compile(r"nothing useful finished|didn.?t have a note", re.I))

    def test_vague_string_replaced(self) -> None:
        out = worker.shape_human_email(worker.VAGUE_FALLBACK, "John", "Agent Test")
        self.assertNotIn(worker.VAGUE_FALLBACK, out)
        self.assertRegex(out, worker.DONE_LINE_RE)

    def test_timeout_copy_says_finished_vs_not(self) -> None:
        for blob in (worker.TIMEOUT_EMPTY, worker.TIMEOUT_PARTIAL, worker.EMPTY_DONE):
            self.assertNotIn(worker.VAGUE_FALLBACK, blob)
            self.assertRegex(blob, worker.DONE_LINE_RE)
            self.assertRegex(blob, re.compile(r"finish", re.I))
        self.assertRegex(worker.TIMEOUT_PARTIAL, re.compile(r"what finished|the rest", re.I))
        shaped = worker.shape_human_email(worker.TIMEOUT_EMPTY, "John", "Agent Test")
        self.assertRegex(shaped, worker.DONE_LINE_RE)
        self.assertNotIn(worker.VAGUE_FALLBACK, shaped)

    def test_ensure_done_inserts_before_signoff(self) -> None:
        raw = "Hey John,\n\nShipped the fix.\n\nAll set,\nAgent Test"
        out = worker.ensure_done_line(raw)
        self.assertIn("This turn is done.", out)
        self.assertLess(out.find("This turn is done."), out.find("All set"))

    def test_ensure_done_does_not_duplicate(self) -> None:
        raw = "Hey John,\n\nThis turn is done. Shipped it.\n\nAll set,\nAgent Test"
        out = worker.ensure_done_line(raw)
        self.assertEqual(out.lower().count("this turn is done"), 1)
        thats = "Hey John,\n\nThat's done for this turn.\n\nOn it,\nAgent Test"
        self.assertEqual(worker.ensure_done_line(thats), thats)


class ParallelSessions(unittest.TestCase):
    def setUp(self) -> None:
        worker.wait_inflight(2)
        with worker._state_lock:
            worker._inflight.clear()
        worker.save_sessions({"next_id": 1, "by_id": {}})
        worker.save_processed(set())
        self.agent = _agent()

    def tearDown(self) -> None:
        worker.wait_inflight(5)
        with worker._state_lock:
            worker._inflight.clear()

    def _submit(self, msg: dict, sid: int, is_new: bool):
        with worker._state_lock:
            worker._inflight.add(str(msg["id"]))
        return worker.get_job_pool().submit(
            worker._run_claimed_job,
            {},
            self.agent,
            msg,
            sid,
            is_new,
            {"enabled": True, "mode": "all"},
            None,
            "John",
            False,
        )

    def test_different_sessions_overlap(self) -> None:
        events: list[tuple[str, int, float]] = []
        gate = threading.Lock()

        def fake_grok(cfg, agent, msg, session_id, is_new, **kwargs):
            with gate:
                events.append(("start", session_id, time.time()))
            time.sleep(0.4)
            with gate:
                events.append(("end", session_id, time.time()))
            return (
                "Hey John,\n\nThis turn is done.\n\nOn it,\nAgent Test",
                {"turn_tokens": 4000, "duration_s": 0.4, "timed_out": False, "returncode": 0},
            )

        sessions = _empty_sessions()
        m1 = _msg("p-a", "Fix login", "ta")
        m2 = _msg("p-b", "Deploy API", "tb")
        s1, _, _ = worker.resolve_session(sessions, self.agent, m1)
        s2, _, _ = worker.resolve_session(sessions, self.agent, m2)
        self.assertNotEqual(s1, s2)

        with patch.object(worker, "run_grok", fake_grok), patch.object(
            worker, "send_reply", lambda *a, **k: True
        ):
            f1 = self._submit(m1, s1, True)
            f2 = self._submit(m2, s2, True)
            f1.result(timeout=5)
            f2.result(timeout=5)

        starts = [e[2] for e in events if e[0] == "start"]
        ends = [e[2] for e in events if e[0] == "end"]
        self.assertEqual(len(starts), 2)
        self.assertEqual(len(ends), 2)
        self.assertLess(max(starts), min(ends), "jobs should overlap in time")

    def test_same_session_runs_serially(self) -> None:
        events: list[tuple[str, str, float]] = []
        gate = threading.Lock()

        def fake_grok(cfg, agent, msg, session_id, is_new, **kwargs):
            mid = str(msg.get("id"))
            with gate:
                events.append(("start", mid, time.time()))
            time.sleep(0.25)
            with gate:
                events.append(("end", mid, time.time()))
            return (
                "Hey John,\n\nThis turn is done.\n\nOn it,\nAgent Test",
                {"turn_tokens": 4000, "duration_s": 0.25, "timed_out": False, "returncode": 0},
            )

        sessions = _empty_sessions()
        m1 = _msg("s-a", "Fix login", "t1")
        sid, _, _ = worker.resolve_session(sessions, self.agent, m1)
        m2 = _msg("s-b", f"Re: Fix login (ID: {sid})", "t1")

        with patch.object(worker, "run_grok", fake_grok), patch.object(
            worker, "send_reply", lambda *a, **k: True
        ):
            f1 = self._submit(m1, sid, True)
            f2 = self._submit(m2, sid, False)
            f1.result(timeout=5)
            f2.result(timeout=5)

        ordered = sorted(events, key=lambda e: e[2])
        self.assertEqual([e[0] for e in ordered], ["start", "end", "start", "end"])

    def test_process_once_returns_before_grok_finishes(self) -> None:
        started = threading.Event()
        release = threading.Event()

        def fake_grok(*a, **k):
            started.set()
            release.wait(4)
            return (
                "Hey John,\n\nThis turn is done.\n\nOn it,\nAgent Test",
                {"turn_tokens": 4000, "duration_s": 0.2, "timed_out": False, "returncode": 0},
            )

        agent = self.agent
        msg = _msg("wait-1", "Fix login", "tw")
        msg["_agent_local"] = agent["local_part"]
        auth_ok = {"ok": True, "reason": "ok", "grant": {"enabled": True, "mode": "all"}}

        with ExitStack() as stack:
            stack.enter_context(patch.object(worker, "run_grok", fake_grok))
            stack.enter_context(patch.object(worker, "send_reply", lambda *a, **k: True))
            stack.enter_context(
                patch.object(worker, "load_agents", lambda cfg: {"domain": "ex.com", "agents": [agent]})
            )
            stack.enter_context(patch.object(worker, "fetch_new_messages", lambda *a, **k: [msg]))
            stack.enter_context(patch.object(worker, "cloud_already_handled", lambda *a, **k: False))
            stack.enter_context(patch.object(worker, "claim_message", lambda *a, **k: True))
            stack.enter_context(patch.object(worker, "cloud_hands", lambda cfg: "local"))
            stack.enter_context(patch.object(worker, "fetch_allowlist", lambda cfg: None))
            if worker.access is not None:
                stack.enter_context(patch.object(worker.access, "ensure_store", lambda: {}))
                stack.enter_context(patch.object(worker.access, "authorize", lambda *a, **k: auth_ok))
                stack.enter_context(
                    patch.object(worker.access, "grok_invocation", lambda g: {"questions_only": False})
                )
            t0 = time.time()
            worker.process_once({"TRUSTED_SENDERS": "john@example.com"})
            elapsed = time.time() - t0
            self.assertLess(elapsed, 0.4)
            self.assertTrue(started.wait(2))
            self.assertGreater(worker.inflight_count(), 0)
            release.set()
            self.assertTrue(worker.wait_inflight(5))


if __name__ == "__main__":
    unittest.main()
