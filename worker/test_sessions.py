"""P1: session identity, context tag, done signaling, parallel vs serial."""

from __future__ import annotations

import importlib.util
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="am-test-")
os.environ["AGENTMAIL_HOME"] = _TMP

_WORKER_PY = Path(__file__).resolve().parent / "worker.py"
_spec = importlib.util.spec_from_file_location("agentmail_worker", _WORKER_PY)
assert _spec and _spec.loader
worker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(worker)


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
        self.assertNotIn(worker.EMPTY_DONE, out)
        self.assertIn("did not finish", out.lower())
        self.assertTrue(out.startswith("Hey John"))
        self.assertFalse(worker.DONE_LINE_RE.search(out))

    def test_vague_string_replaced(self):
        out = worker.shape_human_email(worker.VAGUE_FALLBACK, "John", "Agent NokNok")
        self.assertNotIn(worker.VAGUE_FALLBACK, out)
        self.assertNotIn(worker.EMPTY_DONE, out)
        self.assertIn("did not finish", out.lower())

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


_MID = "11111111-1111-1111-1111-111111111111"


class KanbanPayload(unittest.TestCase):
    def test_received_payload_shape_new_row(self):
        rec = {"base_subject": "Ship the kanban", "email_thread_id": "tid-1", "used_k": 1, "used_tokens": 0}
        msg = {"id": _MID, "thread_id": "tid-1", "subject": "Ship the kanban"}
        p = worker.job_upsert_payload(
            "received", existing=None, agent=_agent(), session_id=3, rec=rec, msg=msg
        )
        self.assertEqual(p["stage"], "received")
        self.assertEqual(p["session_id"], 3)
        self.assertEqual(p["agent_local"], "a.noknok")
        self.assertEqual(p["base_subject"], "Ship the kanban")
        self.assertEqual(p["email_thread_id"], "tid-1")
        self.assertEqual(p["last_message_id"], _MID)
        self.assertEqual(p["mailbox"], "a.noknok@freecoffee.dev")
        self.assertIn("received_at", p)
        self.assertNotIn("started_at", p)
        self.assertNotIn("done_at", p)
        self.assertNotIn("stuck_at", p)
        self.assertEqual(p["used_k"], 1)

    def test_received_does_not_overwrite_received_at(self):
        existing = {
            "id": "job-1",
            "stage": "done",
            "received_at": "2026-01-01T00:00:00+00:00",
            "agent_local": "a.noknok",
            "base_subject": "Ship the kanban",
        }
        p = worker.job_upsert_payload(
            "received",
            existing=existing,
            agent=_agent(),
            session_id=3,
            rec={"base_subject": "Ship the kanban"},
            msg={"id": _MID},
        )
        self.assertEqual(p["stage"], "received")
        self.assertNotIn("received_at", p)

    def test_working_sets_started_at_once(self):
        rec = {"base_subject": "Ship"}
        p = worker.job_upsert_payload(
            "working", existing=None, agent=_agent(), session_id=3, rec=rec, msg={"id": _MID}
        )
        self.assertEqual(p["stage"], "working")
        self.assertIn("started_at", p)
        existing = {**p, "id": "job-1", "started_at": p["started_at"]}
        p2 = worker.job_upsert_payload(
            "working", existing=existing, agent=_agent(), session_id=3, rec=rec
        )
        self.assertNotIn("started_at", p2)
        self.assertNotIn("received_at", p2)

    def test_done_waiting_stuck_timestamps_and_tokens(self):
        existing = {
            "id": "job-1",
            "stage": "working",
            "received_at": "2026-01-01T00:00:00+00:00",
            "started_at": "2026-01-01T00:01:00+00:00",
            "agent_local": "a.noknok",
            "base_subject": "Ship",
        }
        rec = {"base_subject": "Ship"}
        done = worker.job_upsert_payload(
            "done",
            existing=existing,
            agent=_agent(),
            session_id=3,
            rec=rec,
            used_k=12,
            used_tokens=12_400,
        )
        self.assertEqual(done["stage"], "done")
        self.assertIn("done_at", done)
        self.assertIn("last_reply_at", done)
        self.assertEqual(done["used_k"], 12)
        self.assertEqual(done["used_tokens"], 12_400)
        self.assertNotIn("received_at", done)

        waiting = worker.job_upsert_payload(
            "waiting", existing=existing, agent=_agent(), session_id=3, rec=rec
        )
        self.assertEqual(waiting["stage"], "waiting")
        self.assertIn("last_reply_at", waiting)
        self.assertNotIn("done_at", waiting)

        stuck = worker.job_upsert_payload(
            "stuck", existing=existing, agent=_agent(), session_id=3, rec=rec
        )
        self.assertEqual(stuck["stage"], "stuck")
        self.assertIn("stuck_at", stuck)

    def test_stage_mapping(self):
        self.assertEqual(worker.finish_stage(True, "Hey, which repo?"), "stuck")
        self.assertEqual(worker.finish_stage(False, "x", process_error=True), "stuck")
        self.assertEqual(
            worker.finish_stage(False, "Which branch should I use?"), "waiting"
        )
        # questions_only is waiting even without a '?'
        self.assertEqual(
            worker.finish_stage(False, "Looked it up.", questions_only=True), "waiting"
        )
        self.assertEqual(
            worker.finish_stage(
                False, "Shipped the fix. This turn is done. Want me to go deeper?"
            ),
            "done",
        )
        self.assertEqual(
            worker.finish_stage(False, "Shipped the login. This turn is done."), "done"
        )
        self.assertEqual(
            worker.finish_stage(False, worker.STUCK_EMPTY, unfinished=True), "stuck"
        )
        self.assertEqual(worker.finish_stage(False, worker.EMPTY_DONE), "stuck")
        self.assertEqual(
            worker.finish_stage(False, worker.status_note("died", "John", "Agent", "x")),
            "stuck",
        )


class HonestStatus(unittest.TestCase):
    def test_pulse_and_died_notes(self):
        pulse = worker.status_note("pulse", "John", "Agent NokNok", "Chat problems")
        self.assertIn("Still on", pulse)
        self.assertIn("Still working", pulse)
        self.assertTrue(pulse.startswith("Hey John"))
        died = worker.status_note("died", "John", "Agent NokNok", "Chat problems")
        self.assertIn("died", died.lower())
        self.assertIn("didn't finish", died.lower())

    def test_unfinished_stub(self):
        self.assertTrue(worker.is_unfinished_stub(worker.EMPTY_DONE))
        self.assertTrue(worker.is_unfinished_stub(worker.STUCK_EMPTY))
        self.assertFalse(worker.is_unfinished_stub("Hey John,\n\nShipped the fix. This turn is done."))

    def test_thread_headers_chain(self):
        rec = {"rfc_ids": ["aaa", "<bbb>"]}
        msg = {"resend_email_id": "ccc"}
        h = worker.thread_headers(msg, rec)
        self.assertEqual(h["In-Reply-To"], "<ccc>")
        self.assertIn("<aaa>", h["References"])
        self.assertIn("<bbb>", h["References"])
        self.assertIn("<ccc>", h["References"])

    def test_pulse_skip_newer_inbound(self):
        agent = _agent()
        newer = [
            {
                "id": "msg-new",
                "_agent_local": "a.noknok",
                "subject": "Re: Chat problems (ID: 7 - 1/500K)",
                "thread_id": "tid-1",
            }
        ]
        orig = worker.fetch_new_messages
        worker.fetch_new_messages = lambda *a, **k: newer
        try:
            self.assertTrue(worker.newer_mail_for_session({}, agent, 7, "msg-old"))
            self.assertFalse(worker.newer_mail_for_session({}, agent, 7, "msg-new"))
            self.assertFalse(worker.newer_mail_for_session({}, agent, 9, "msg-old"))
        finally:
            worker.fetch_new_messages = orig

        worker.save_sessions(
            {
                "next_id": 8,
                "by_id": {
                    "7": {
                        "id": 7,
                        "email_thread_id": "tid-1",
                        "base_subject": "Chat problems",
                    }
                },
            }
        )
        untagged = [
            {
                "id": "msg-reply",
                "_agent_local": "a.noknok",
                "subject": "Re: Chat problems",
                "thread_id": "tid-1",
            }
        ]
        worker.fetch_new_messages = lambda *a, **k: untagged
        try:
            self.assertTrue(worker.newer_mail_for_session({}, agent, 7, "msg-old"))
            worker.fetch_new_messages = lambda *a, **k: []
            self.assertFalse(worker.newer_mail_for_session({}, agent, 7, "msg-old"))
        finally:
            worker.fetch_new_messages = orig

    def test_spawn_fail_died_not_empty_done(self):
        orig = worker.subprocess.Popen

        def boom(*_a, **_k):
            raise OSError("no grok")

        worker.subprocess.Popen = boom
        try:
            text, meta = worker.run_grok(
                {"GROK_BIN": "/no/such/grok", "GROK_TIMEOUT": "30", "MAX_TURNS": "8"},
                _agent(),
                {
                    "id": "local-1",
                    "subject": "Chat problems",
                    "from_address": "john@x.com",
                    "body_text": "hi",
                },
                7,
                True,
                first_name="John",
            )
        finally:
            worker.subprocess.Popen = orig
        self.assertIn("died", text.lower())
        self.assertNotIn(worker.EMPTY_DONE, text)
        self.assertTrue(meta.get("process_error"))
        self.assertTrue(meta.get("unfinished"))
        self.assertEqual(
            worker.finish_stage(
                bool(meta.get("timed_out")),
                text,
                process_error=bool(meta.get("process_error")),
                unfinished=bool(meta.get("unfinished")),
            ),
            "stuck",
        )

    def test_max_turns_default_120(self):
        self.assertEqual(worker.DEFAULT_MAX_TURNS, 120)
        self.assertEqual(worker.MAX_CONTINUES, 2)


class NoteTrailer(unittest.TestCase):
    def test_note_after_to_cc_stripped_from_mail(self):
        raw = (
            "Hey John,\n\nShipped the fix.\n\nThis turn is done.\n\nAll set,\nAgent NokNok\n\n"
            "TO: john@x.com\nCC:\nNOTE: waiting on DNS"
        )
        body, to, cc, note = worker.parse_trailers(raw)
        self.assertEqual(note, "waiting on DNS")
        self.assertEqual(to, ["john@x.com"])
        self.assertEqual(cc, [])
        self.assertNotIn("NOTE:", body)
        self.assertNotIn("waiting on DNS", body)
        self.assertNotIn("TO:", body)
        self.assertIn("Shipped the fix", body)

    def test_note_only_trailer(self):
        raw = "Hey John,\n\nWhich repo?\n\nAll set,\nAgent\n\nNOTE: need the path"
        body, _to, _cc, note = worker.parse_trailers(raw)
        self.assertEqual(note, "need the path")
        self.assertNotIn("NOTE:", body)
        self.assertIn("Which repo?", body)

    def test_clean_then_strip_does_not_mail_note(self):
        raw = (
            "Hey John,\n\nShipped the fix.\n\nThis turn is done.\n\nAll set,\nAgent NokNok\n\n"
            "TO: john@x.com\nCC:\nNOTE: card says waiting on DNS"
        )
        cleaned = worker.clean_email_reply(raw, "John", "Agent NokNok")
        self.assertIn("NOTE: card says waiting on DNS", cleaned)
        mailed, _to, _cc, note = worker.parse_trailers(cleaned)
        self.assertEqual(note, "card says waiting on DNS")
        self.assertNotIn("NOTE:", mailed)
        self.assertNotIn("card says waiting on DNS", mailed)

    def test_parse_note_block_keeps_to_cc(self):
        raw = "Hey John,\n\nHi.\n\nTO: john@x.com\nCC:\nNOTE: short card"
        body, note = worker.parse_note_block(raw)
        self.assertEqual(note, "short card")
        self.assertIn("TO: john@x.com", body)
        self.assertNotIn("NOTE:", body)


class RemindSession(unittest.TestCase):
    def test_remind_query_is_postgrest_not_pages(self):
        url = worker.remind_jobs_url("https://sxjtpprtaascxafddddg.supabase.co")
        self.assertIn("/rest/v1/agent_jobs", url)
        self.assertIn("remind_requested_at=not.is.null", url)
        self.assertNotIn("/api/email/agent-jobs", url)

    def test_remind_does_not_alloc_new_session_id(self):
        sessions = _empty_sessions()
        agent = _agent()
        sid, rec, _ = worker.resolve_session(
            sessions, agent, {"subject": "Ship the kanban", "thread_id": "t-r"}
        )
        next_before = sessions["next_id"]
        called: list[int] = []
        orig = worker.alloc_session

        def boom(*_a, **_k):
            called.append(1)
            raise AssertionError("alloc_session must not run on remind")

        worker.alloc_session = boom  # type: ignore
        try:
            job = {
                "session_id": sid,
                "agent_local": "a.noknok",
                "base_subject": rec["base_subject"],
                "email_thread_id": "t-r",
            }
            got, rec2 = worker.ensure_session_for_job(sessions, agent, job)
            self.assertEqual(got, sid)
            self.assertEqual(rec2["id"], sid)
            self.assertEqual(sessions["next_id"], next_before)
            self.assertFalse(called)
        finally:
            worker.alloc_session = orig

    def test_remind_rehydrates_same_id_when_local_missing(self):
        sessions = _empty_sessions()
        sessions["next_id"] = 9
        agent = _agent()
        job = {
            "session_id": 4,
            "agent_local": "a.noknok",
            "base_subject": "Old card",
            "used_k": 12,
            "used_tokens": 12_000,
            "email_thread_id": "tid-old",
        }
        sid, rec = worker.ensure_session_for_job(sessions, agent, job)
        self.assertEqual(sid, 4)
        self.assertEqual(rec["id"], 4)
        self.assertEqual(rec["base_subject"], "Old card")
        self.assertNotEqual(sid, 9)
        self.assertEqual(sessions["by_id"]["4"]["id"], 4)
        self.assertGreater(sessions["next_id"], 4)

    def test_missing_table_fail_open(self):
        self.assertTrue(worker.is_missing_table(404, None))
        self.assertTrue(worker.is_missing_table(400, {"code": "PGRST205"}))
        self.assertTrue(worker.is_missing_table(404, {"code": "42P01"}))
        self.assertFalse(worker.is_missing_table(200, [{"id": "x"}]))

        def fake_curl(_method, url, _headers, _body=None):
            return 404, {"code": "PGRST205", "message": "Could not find the table"}

        orig = worker.curl_json
        worker.curl_json = fake_curl  # type: ignore
        try:
            row = worker.write_kanban_stage(
                {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_KEY": "k"},
                "received",
                agent=_agent(),
                session_id=1,
                rec={"base_subject": "Hi"},
                msg={"id": _MID},
            )
            self.assertIsNone(row)
        finally:
            worker.curl_json = orig


class InboundFiles(unittest.TestCase):
    def test_safe_filename_strips_paths(self):
        self.assertEqual(worker.safe_filename("../../x.png"), "x.png")
        self.assertEqual(worker.safe_filename("My Shot 1.PNG"), "My_Shot_1.PNG")
        self.assertTrue(worker.safe_filename("") )

    def test_is_image_type(self):
        self.assertTrue(worker.is_image_type("image/png", "a.png"))
        self.assertTrue(worker.is_image_type("", "shot.HEIC"))
        self.assertTrue(worker.is_image_type("image/jpeg; charset=binary", "x.jpg"))
        self.assertFalse(worker.is_image_type("application/pdf", "a.pdf"))

    def test_format_files_block_empty(self):
        self.assertIn("No files", worker.format_files_block([]))

    def test_format_files_block_paths(self):
        block = worker.format_files_block(
            [
                {
                    "path": "/tmp/a.png",
                    "filename": "a.png",
                    "content_type": "image/png",
                    "size_bytes": 12,
                    "is_image": True,
                }
            ]
        )
        self.assertIn("/tmp/a.png", block)
        self.assertIn("screenshot", block.lower())
        self.assertIn("file reader", block.lower())

    def test_storage_object_url_encodes_segments(self):
        url = worker.storage_object_url(
            {"SUPABASE_URL": "https://example.supabase.co"},
            "freecoffee.dev/abc/My Shot.png",
        )
        self.assertIn("/object/email-attachments/freecoffee.dev/", url)
        self.assertIn("My%20Shot.png", url)


if __name__ == "__main__":
    unittest.main()
