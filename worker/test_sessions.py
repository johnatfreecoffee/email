"""P1: session identity, context tag, done signaling, parallel vs serial."""

from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="am-test-")
os.environ["AGENTMAIL_HOME"] = _TMP

import worker  # noqa: E402


def _agent(local: str = "a.noknok") -> dict:
    return {
        "local_part": local,
        "workspace": "/tmp",
        "display_name": "Agent NokNok",
        "agent_dir": str(Path(_TMP) / "agent"),
        "email": f"{local}@freecoffee.dev",
    }


def _empty_sessions() -> dict:
    return {"next_id": 1, "by_id": {}}


class SessionIdentity(unittest.TestCase):
    def test_new_subject_different_base_not_reused_by_thread_id(self):
        sessions = _empty_sessions()
        agent = _agent()
        first = {
            "subject": "Ship the kanban",
            "thread_id": "tid-1",
            "from_address": "john@x.com",
        }
        sid1, rec1, new1 = worker.resolve_session(sessions, agent, first)
        self.assertTrue(new1)
        self.assertEqual(rec1["base_subject"], "Ship the kanban")
        second = {
            "subject": "Totally different ask",
            "thread_id": "tid-1",
            "from_address": "john@x.com",
        }
        sid2, rec2, new2 = worker.resolve_session(sessions, agent, second)
        self.assertTrue(new2)
        self.assertNotEqual(sid1, sid2)
        self.assertEqual(rec2["base_subject"], "Totally different ask")

    def test_id_tag_same_agent_continues(self):
        sessions = _empty_sessions()
        agent = _agent()
        sid1, _, _ = worker.resolve_session(
            sessions, agent, {"subject": "Help with inbox", "thread_id": "t-a"}
        )
        sid2, rec, is_new = worker.resolve_session(
            sessions,
            agent,
            {"subject": f"Re: Help with inbox (ID: {sid1} - 12/500K)", "thread_id": "t-a"},
        )
        self.assertFalse(is_new)
        self.assertEqual(sid1, sid2)
        self.assertEqual(rec["id"], sid1)

    def test_id_tag_other_agent_is_new(self):
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

    def test_re_same_base_same_agent(self):
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

    def test_brand_new_same_title_without_re_is_new_session(self):
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

    def test_same_thread_same_base_without_re_continues(self):
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
    def test_sixty_seconds_is_not_500k(self):
        tokens = worker.estimate_turn_tokens("hi", "hey", "", duration_s=60, timed_out=False)
        self.assertLess(tokens, 50_000)
        self.assertGreater(tokens, 12_000)
        # per-minute: 12k + 2500, not per-second 12k+150k
        self.assertLess(tokens, 20_000)

    def test_two_minute_job_not_500(self):
        tokens = worker.estimate_turn_tokens("p", "out", "", duration_s=120, timed_out=False)
        used_k = worker.tokens_to_used_k(tokens)
        self.assertLess(used_k, 500)
        self.assertLess(tokens, 40_000)

    def test_new_session_starts_small(self):
        self.assertEqual(worker.tokens_to_used_k(0), 1)
        self.assertEqual(worker.tokens_to_used_k(800), 1)
        self.assertLess(worker.estimate_used_k([], 1, used_tokens=3_000), 10)

    def test_short_turn_cannot_paint_500(self):
        tokens = worker.estimate_turn_tokens("short", "ok", "", duration_s=5, timed_out=False)
        self.assertLess(worker.tokens_to_used_k(tokens), 50)

    def test_accumulated_can_reach_500(self):
        self.assertEqual(worker.tokens_to_used_k(500_000), 500)
        self.assertEqual(worker.tokens_to_used_k(499_000), 499)

    def test_run_grok_ignores_total_tokens(self):
        # parse still returns usage; run_grok must not use it as used_k
        text, usage = worker.parse_grok_stdout('{"text":"Hey John,\\n\\nHi.","usage":{"total_tokens":500000}}')
        self.assertEqual(usage, 500000)
        self.assertIn("Hey John", text)
        # the subject path uses estimate_turn_tokens, not usage
        est = worker.estimate_turn_tokens("p", text, "", duration_s=8, timed_out=False)
        self.assertNotEqual(worker.tokens_to_used_k(est), 500)


class DoneSignaling(unittest.TestCase):
    def test_empty_body_not_vague_fallback(self):
        out = worker.shape_human_email("", "John", "Agent NokNok")
        self.assertNotIn(worker.VAGUE_FALLBACK, out)
        self.assertRegex(out, worker.DONE_LINE_RE)
        self.assertTrue(out.startswith("Hey John"))

    def test_vague_string_replaced(self):
        out = worker.shape_human_email(worker.VAGUE_FALLBACK, "John", "Agent NokNok")
        self.assertNotIn(worker.VAGUE_FALLBACK, out)
        self.assertRegex(out, worker.DONE_LINE_RE)

    def test_ensure_done_inserts_before_signoff(self):
        raw = "Hey John,\n\nShipped the fix.\n\nAll set,\nAgent NokNok"
        out = worker.ensure_done_line(raw)
        self.assertIn("This turn is done.", out)
        self.assertLess(out.find("This turn is done."), out.find("All set"))

    def test_ensure_done_does_not_duplicate(self):
        raw = "Hey John,\n\nThis turn is done. Shipped it.\n\nAll set,\nAgent NokNok"
        out = worker.ensure_done_line(raw)
        self.assertEqual(out.lower().count("this turn is done"), 1)

    def test_timeout_copy_says_finished_vs_not(self):
        timed = worker.shape_human_email(
            "This turn is done. I started but ran out of time, so nothing finished cleanly. "
            "Reply on this thread and I'll pick it up.",
            "John",
            "Agent NokNok",
        )
        self.assertRegex(timed, worker.DONE_LINE_RE)
        self.assertIn("ran out of time", timed.lower())
        self.assertNotIn(worker.VAGUE_FALLBACK, timed)


class ParallelSessions(unittest.TestCase):
    def test_different_sessions_overlap(self):
        order: list[str] = []
        barrier = threading.Barrier(2)

        def job(label: str) -> None:
            order.append(f"{label}-start")
            barrier.wait(timeout=2)
            time.sleep(0.25)
            order.append(f"{label}-end")

        def run(sid: int, label: str) -> None:
            with worker.session_lock_for(sid):
                job(label)

        t1 = threading.Thread(target=run, args=(1, "a"))
        t2 = threading.Thread(target=run, args=(2, "b"))
        t0 = time.time()
        t1.start()
        t2.start()
        t1.join(timeout=3)
        t2.join(timeout=3)
        elapsed = time.time() - t0
        self.assertTrue(t1.is_alive() is False and t2.is_alive() is False)
        self.assertLess(elapsed, 0.45)
        self.assertEqual(sorted(order[:2]), ["a-start", "b-start"])

    def test_same_session_serial(self):
        def job() -> None:
            time.sleep(0.2)

        def run() -> None:
            with worker.session_lock_for(99):
                job()

        t1 = threading.Thread(target=run)
        t2 = threading.Thread(target=run)
        t0 = time.time()
        t1.start()
        t2.start()
        t1.join(timeout=3)
        t2.join(timeout=3)
        elapsed = time.time() - t0
        self.assertGreaterEqual(elapsed, 0.38)


if __name__ == "__main__":
    unittest.main()
