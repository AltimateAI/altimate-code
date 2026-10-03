#!/usr/bin/env python3
"""Unpaid regression checks: python3 v1bench/selftest.py."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import lib
import common as C
import analyze_v1
import check_output
import eval_v1
import bootstrap_bench
import tasks_lib

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("topic_driver", HERE / "topic_switch/run_topic_switch.py")
topic = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(topic)


class HarnessTests(unittest.TestCase):
    def test_counters_and_control_source(self):
        lesson = {"id": "L-abcd", "text": "A lesson"}
        for value in (-1, 1.5, True, "3"):
            with self.assertRaises(ValueError):
                lib.lesson_record(dict(lesson, helpful=value))
        self.assertEqual(lib.lesson_record(lesson)["helpful"], 0)
        with self.assertRaises(SystemExit):
            lib.parse_arm("none:pool-50.jsonl")

    def test_watchdog_missing_tool_count(self):
        wd = lib.Watchdog()
        for _ in range(3):
            wd.note({"pass": False, "error": "setup failed"})
        self.assertTrue(wd.tripped)

    def test_vague_recall_and_no_lesson_baseline(self):
        for task in tasks_lib.load_dir(tasks_lib.VAGUE_DIR).values():
            needed = tasks_lib.NEEDS[task["base_task"]]
            self.assertEqual(tasks_lib.recall(task["id"], needed), 1.0)
            self.assertEqual(tasks_lib.recall(task["id"], []), 0.0)
            with patch.object(C, "run_task", return_value={"task": task["id"]}), \
                    patch.object(lib, "read_shown") as read_shown:
                rec = eval_v1.run_one({"task": task, "arm_obj": lib.parse_arm("vague:none")})
            read_shown.assert_not_called()
            self.assertEqual(rec["retrieval"]["needed"], needed)
            self.assertEqual(rec["retrieval"]["recall"], 0.0)
            self.assertEqual(rec["n_lessons"], 0)
        self.assertIsNone(tasks_lib.recall("control-customers-vip", []))

    def test_analysis_labels_across_directories(self):
        records = [{"_dir": d, "arm": arm} for d in ("one", "two") for arm in ("baseline", "other")]
        key = lambda r: r["_dir"] + "/" + r["arm"]
        self.assertEqual(list(analyze_v1.group(records, key, ["baseline"])),
                         ["one/baseline", "two/baseline"])
        self.assertEqual(list(analyze_v1.group(records, key, ["two/other", "baseline"])),
                         ["two/other", "one/baseline", "two/baseline"])
        self.assertEqual(list(analyze_v1.group(records, lambda r: r["arm"], ["baseline"])), ["baseline"])

    def test_compression_ids_and_scope(self):
        for prefix in ("n50", "real4"):
            forms = [lib.parse_playbook_md((HERE / "playbooks" / f"{prefix}-{form}.md").read_text())
                     for form in ("long", "short")]
            self.assertEqual([r["id"] for r in forms[0]], [r["id"] for r in forms[1]])
            for lesson in forms[1]:
                if lesson["id"] in ("L-2fe6", "L-8201"):
                    self.assertIn("staging", lesson["text"].lower())

    def test_exact_output_keys(self):
        tasks = [t for t in C.load_tasks().values() if t["split"] in ("heldout", "control")]
        records = [{"task": t["id"], "run_idx": 0, "arm": "test", "completed": True, "pass": False} for t in tasks]
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "eval.jsonl"
            def write(rs):
                out.write_text("".join(json.dumps(r) + "\n" for r in rs))
            write(records)
            self.assertTrue(check_output.complete(out, "test", "eval", 1))
            write(records[:-1] + [records[0]])
            self.assertFalse(check_output.complete(out, "test", "eval", 1))
            records[0]["completed"] = False
            write(records)
            self.assertFalse(check_output.complete(out, "test", "eval", 1))

    def test_full_eval_retry_replaces_partial(self):
        task = next(t for t in C.load_tasks().values() if t["split"] == "heldout")
        def run_specs(specs, parallel, on_done=None, fn=None):
            recs = [{"task": s["task"]["id"], "run_idx": s["run_idx"]} for s in specs]
            for rec in recs:
                on_done(rec)
            return recs, False
        with tempfile.TemporaryDirectory() as d, patch.object(C, "select_tasks", return_value=[task]), \
                patch.object(tasks_lib, "install"), patch.object(lib, "run_specs", side_effect=run_specs):
            out = Path(d) / "eval.jsonl"
            out.write_text('{"old": true}\n')
            eval_v1.evaluate(d, "none", "test", runs=1, out=str(out))
            self.assertEqual(len(C.read_jsonl(out)), 1)
            self.assertEqual(C.read_jsonl(out)[0]["task"], task["id"])
            run = Path(d) / "run"
            run.mkdir()
            sentinel = Path(d) / "sentinel"
            sentinel.write_text("keep")
            linked = run / "eval.jsonl"
            linked.symlink_to(sentinel)
            with self.assertRaises(ValueError):
                eval_v1.evaluate(str(run), "none", "test", runs=1, out=str(linked))
            self.assertEqual(sentinel.read_text(), "keep")
            bootstrap_out = run / "eval" / "bootstrap-lessons.jsonl"
            bootstrap_out.parent.mkdir()
            bootstrap_out.write_text('{"stale":true}\n')
            with patch.object(sys, "argv", ["bootstrap", "--run-dir", str(run), "--model", "test/model"]), \
                    patch.object(lib, "preflight"), patch.object(C, "require_dbt", side_effect=RuntimeError("missing dbt")):
                with self.assertRaises(RuntimeError):
                    bootstrap_bench.main()
            self.assertEqual(bootstrap_out.read_text(), "")

    def test_analysis_missing_checks_and_support(self):
        report = analyze_v1.eval_tables({"arm": [
            {"task": "heldout-invoices", "split": "heldout", "checks": {"C1": True}},
            {"task": "heldout-invoices", "split": "heldout", "checks": {}, "error": "setup"},
        ]})
        self.assertIn("| arm | 1/2 |", report)
        topic_report = analyze_v1.topic_tables({"arm": [{"request2": "heldout-support-tickets", "pass": True,
                                                       "same_session": True, "checks": {"C1": True}}]})
        self.assertIn("req2 support pass", topic_report)
        self.assertIn("1/1", topic_report)
        self.assertFalse(analyze_v1.topic_pass({"pass": True, "same_session": False}))

    def test_synthetic_task_inherits_split(self):
        cfg = json.loads((HERE / "topic_switch/tasks.json").read_text())
        base = C.load_tasks()
        for session in cfg["sessions"]:
            self.assertIn("split", base[session["request2"]])

    def test_topic_incomplete_and_resumption(self):
        with tempfile.TemporaryDirectory() as d:
            os.mkdir(os.path.join(d, "logs"))
            task = next(t for t in C.load_tasks().values() if t["split"] == "heldout")
            spec = {"run_dir": d, "session": {"id": "test-session"}, "t1": {"id": "one", "prompt": "explain"},
                    "t2": task, "arm": "none", "run_idx": 0, "arm_obj": lib.parse_arm("none"),
                    "model": "test/model", "prompt2": "build"}
            r1 = {"workdir": d, "session_id": "s1", "completed": False, "timed_out": True}
            with patch.object(C, "run_task", return_value=r1), patch.object(topic, "agent_turn") as turn2:
                rec = topic.run_session(spec)
                self.assertFalse(rec["pass"])
                turn2.assert_not_called()
            r1["completed"] = True
            r1["timed_out"] = False
            ev = {"session_id": "fresh-session", "tokens": {}, "cost": 0, "tool_calls": 1, "steps": 1,
                  "tools": {}, "tool_inputs": []}
            with patch.object(C, "run_task", return_value=r1), \
                    patch.object(topic, "agent_turn", return_value=(0, False, 123.25, 4.5)), \
                    patch.object(C, "parse_events", return_value=ev), patch.object(C, "user_env", return_value={}), \
                    patch.object(C, "run_verify", return_value={"pass": True, "score": 1.0,
                                                                 "checks": [{"name": "C1", "ok": True}]}):
                rec = topic.run_session(spec)
                self.assertFalse(rec["pass"])
                self.assertEqual(rec["score"], 0.0)
                self.assertFalse(any(rec["checks"].values()))
                self.assertEqual(rec["t_req2_start"], 123250)
                self.assertEqual(rec["turn2"]["duration"], 4.5)
            ev["session_id"] = "s1"
            with patch.object(C, "run_task", return_value=r1), \
                    patch.object(topic, "agent_turn", return_value=(0, False, 123.25, 4.5)), \
                    patch.object(C, "parse_events", return_value=ev), patch.object(C, "user_env", return_value={}), \
                    patch.object(C, "agent_completed", return_value=True), \
                    patch.object(C, "run_verify", return_value={"error": "unparsable verifier", "checks": []}):
                rec = topic.run_session(spec)
                self.assertFalse(rec["completed"])
                self.assertEqual(rec["error"], "unparsable verifier")
            neutral = subprocess.run(topic.NOOP_VERIFY, capture_output=True, text=True, check=True)
            self.assertTrue(json.loads(neutral.stdout)["checks"])

    def test_topic_launch_time_excludes_lock_queue(self):
        clock = {"now": 10.0}
        class DelayedLock:
            def __enter__(self):
                clock["now"] = 20.0
            def __exit__(self, *args):
                pass
        with tempfile.TemporaryDirectory() as d, patch.object(C, "_spawn_lock", DelayedLock()), \
                patch.object(topic.time, "time", side_effect=lambda: clock["now"]), \
                patch.object(topic.time, "sleep"), patch.object(topic.subprocess, "Popen") as popen:
            proc = popen.return_value
            proc.returncode = 0
            proc.wait.side_effect = lambda **kw: clock.update(now=25.0)
            result = topic.agent_turn({}, d, os.path.join(d, "turn2.events.jsonl"), "test/model", "test")
        self.assertEqual(result, (0, False, 20.0, 5.0))

    def test_topic_retries_keep_event_and_trace_files(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "logs").mkdir()
            trace = root / "product-trace.json"
            task = next(t for t in C.load_tasks().values() if t["split"] == "heldout")
            spec = {"run_dir": d, "session": {"id": "repeat"}, "t1": {"id": "one", "prompt": "explain"},
                    "t2": task, "arm": "none", "run_idx": 0, "arm_obj": lib.parse_arm("none"),
                    "model": "test/model", "prompt2": "build"}
            attempts = []
            def turn1(_):
                name = f"attempt-{len(attempts)}"
                attempts.append(name)
                work = root / "work" / name
                work.mkdir(parents=True)
                trace.write_text("turn1-" + name)
                return {"workdir": str(work), "session_id": "s1", "completed": True, "trace_path": str(trace)}
            def turn2(env, workdir, events_path, *args, **kwargs):
                name = Path(workdir).name
                Path(events_path).write_text("events-" + name)
                trace.write_text("turn2-" + name)
                return 0, False, 123.25, 4.5
            ev = {"session_id": "s1", "tokens": {}, "cost": 0, "tool_calls": 1, "steps": 1,
                  "tools": {}, "tool_inputs": []}
            with patch.object(C, "run_task", side_effect=turn1), patch.object(topic, "agent_turn", side_effect=turn2), \
                    patch.object(C, "parse_events", return_value=ev), patch.object(C, "user_env", return_value={}), \
                    patch.object(C, "agent_completed", return_value=True), \
                    patch.object(C, "run_verify", return_value={"pass": True, "checks": [{"name": "C1", "ok": True}]}):
                recs = [topic.run_session(spec), topic.run_session(spec)]
            for rec, name in zip(recs, attempts):
                self.assertEqual((root / rec["turn2"]["events"]).read_text(), "events-" + name)
                for turn in ("turn1", "turn2"):
                    self.assertEqual(Path(rec["trace_paths"][turn]).read_text(), turn + "-" + name)

    def test_shell_failure_propagation_and_command_override(self):
        # Run copies with a Python stub: no CLI or model process can be launched.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            harness = root / "harness"
            scripts = harness / "v1bench"
            scripts.mkdir(parents=True)
            shim = root / "bin"
            shim.mkdir()
            stub = shim / "python3"
            stub.write_text("#!/bin/bash\n"
                            'echo "$1|${ALTIMATE_CMD}" >> "$STUB_LOG"\n'
                            'case "$1" in\n'
                            '  *check_output.py) exit 1 ;;\n'
                            '  *eval_v1.py|eval.py|*run_topic_switch.py) exit 7 ;;\n'
                            '  *) exit 0 ;;\n'
                            'esac\n')
            stub.chmod(0o755)
            env = dict(os.environ, PATH=str(shim) + os.pathsep + os.environ["PATH"],
                       ALTIMATE_CMD="caller supplied command", STUB_LOG=str(root / "calls"),
                       RD=str(root / "output"), ITEMS="2", ARMS="none real4", RUNS="1")
            for name, expected in (("run_all_v1.sh", 7), ("run_fix_v1.sh", 7), ("run_baselines.sh", 1)):
                shutil.copyfile(HERE / name, scripts / name)
                proc = subprocess.run(["bash", str(scripts / name)], env=env, capture_output=True, text=True)
                self.assertEqual(proc.returncode, expected, proc.stdout + proc.stderr)
                self.assertNotIn("=== done", proc.stdout)
            self.assertTrue(all(line.endswith("|caller supplied command")
                                for line in (root / "calls").read_text().splitlines()))

    def test_preflight_quoted_checkout(self):
        with tempfile.TemporaryDirectory(prefix="v1 checkout ") as d:
            src = Path(d) / "packages/opencode/src/altimate/learn"
            src.mkdir(parents=True)
            (src / "delivery.ts").touch()
            import shlex
            with patch.object(C, "ALTIMATE_CMD", "bun run " + shlex.quote(str(Path(d) / "packages/opencode/src/index.ts"))):
                self.assertEqual(lib.preflight(), d)


if __name__ == "__main__":
    unittest.main()
