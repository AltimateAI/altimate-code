#!/usr/bin/env python3
"""Unpaid regression checks: python3 v1bench/selftest.py."""
import importlib.util
import io
import json
import os
import shutil
import sqlite3
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
import drift_v1
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

    def test_compression_ids_and_original_short_text(self):
        for prefix in ("n50", "real4"):
            forms = [lib.parse_playbook_md((HERE / "playbooks" / f"{prefix}-{form}.md").read_text())
                     for form in ("long", "short")]
            self.assertEqual({r["id"] for r in forms[0]}, {r["id"] for r in forms[1]})
            for lesson in forms[1]:
                if lesson["id"] == "L-2fe6":
                    self.assertEqual(lesson["text"], "Convert integer `*_cents` columns with "
                                     "`{{ cents_to_dollars('x_cents') }}` and drop the suffix (`amount`); "
                                     "no `*_cents` in staging output.")

    def test_exact_output_keys(self):
        tasks = [t for t in C.load_tasks().values() if t["split"] in ("heldout", "control")]
        records = [{"task": t["id"], "run_idx": 0, "arm": "test", "completed": True, "pass": False} for t in tasks]
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "eval.jsonl"
            def write(rs):
                out.write_text("".join(json.dumps(r) + "\n" for r in rs))
            write(records)
            self.assertTrue(check_output.complete(out, "test", "eval", 1))
            for index in (False, 0.0, "0", None):
                write([dict(r, run_idx=index) for r in records])
                self.assertFalse(check_output.complete(out, "test", "eval", 1))
            write(records[:-1] + [records[0]])
            self.assertFalse(check_output.complete(out, "test", "eval", 1))
            records[0]["completed"] = False
            write(records)
            self.assertFalse(check_output.complete(out, "test", "eval", 1))
            cfg = json.loads((HERE / "topic_switch/tasks.json").read_text())
            indexes = {r["id"]: i for i, r in enumerate(cfg["request1"])}
            records = [{"session": s["id"], "run_idx": indexes[s["request1"]], "arm": "test", "completed": True}
                       for s in cfg["sessions"]]
            write(records)
            self.assertTrue(check_output.complete(out, "test", "topic"))
            for cast in (bool, float, str):
                write([dict(r, run_idx=cast(r["run_idx"])) for r in records])
                self.assertFalse(check_output.complete(out, "test", "topic"))

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

    def test_bootstrap_rejects_overlap_before_mutation(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root / "source"
            source.mkdir()
            output = source / "eval/bootstrap-lessons.jsonl"
            output.parent.mkdir()
            output.write_text("preserve source")
            alias = root / "alias"
            alias.symlink_to(source, target_is_directory=True)
            for destination in (source, source / "nested", root, alias / "nested"):
                with self.subTest(destination=destination), \
                        patch.object(sys, "argv", ["bootstrap", "--source-run", str(source),
                                                   "--run-dir", str(destination), "--model", "test/model"]), \
                        patch.object(lib, "preflight"), patch.object(C, "require_dbt") as dbt:
                    with self.assertRaisesRegex(ValueError, "must not overlap"):
                        bootstrap_bench.main()
                    dbt.assert_not_called()
                    self.assertEqual(output.read_text(), "preserve source")
                    self.assertFalse((source / "nested").exists())
                    self.assertFalse((root / "eval").exists())
            for linked_dir in ("work", "home-a"):
                destination = root / ("destination-" + linked_dir)
                destination.mkdir()
                source_child = source / linked_dir
                source_child.mkdir()
                sentinel = source_child / "bootstrap-project" / "sentinel"
                sentinel.parent.mkdir()
                sentinel.write_text("preserve source work")
                (destination / linked_dir).symlink_to(source_child, target_is_directory=True)
                with self.subTest(linked_dir=linked_dir), \
                        patch.object(sys, "argv", ["bootstrap", "--source-run", str(source),
                                                   "--run-dir", str(destination), "--model", "test/model"]), \
                        patch.object(lib, "preflight"), patch.object(C, "require_dbt") as dbt:
                    with self.assertRaisesRegex(ValueError, "must not overlap"):
                        bootstrap_bench.main()
                    dbt.assert_not_called()
                    self.assertEqual(sentinel.read_text(), "preserve source work")
                    self.assertFalse((destination / "eval").exists())

    def test_bootstrap_preserves_all_numeric_train_iterations(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source, destination = root / "source", root / "destination"
            db_rel = Path(".local/share/altimate-code/opencode-local.db")
            (source / db_rel).parent.mkdir(parents=True)
            train = [f"/source/work/i{i}-train-refunds" for i in (0, 9, 10, 123)]
            other = ["/source/work/ia-train-refunds", "/source/work/i1x-train-refunds",
                     "/source/work/i-train-refunds", "/source/work/i10-heldout-invoices",
                     "/source/work/i10-control-customers-vip", "/source/work/i10-train-refunds/nested", None]
            rows = [(str(i), path, "project", None) for i, path in enumerate(train + other)]
            rows.append(("child", train[-1], "project", "3"))
            with sqlite3.connect(source / db_rel) as db:
                db.execute("create table session (id text primary key, directory text, project_id text, "
                           "parent_id text references session(id) on delete cascade)")
                db.executemany("insert into session values (?, ?, ?, ?)", rows)
            project = str(root / "bootstrap-project")
            counts = bootstrap_bench.prepare_home(str(source), str(destination), project)
            self.assertEqual(counts, {"sessions_before": len(rows), "root_sessions_kept": 4, "projects": 1})
            with sqlite3.connect(destination / db_rel) as db:
                retained = db.execute("select id, directory from session order by id").fetchall()
            self.assertEqual(retained, [(r[0], project) for r in rows if r[1] in train])
            with sqlite3.connect(source / db_rel) as db:
                self.assertEqual(db.execute("select * from session").fetchall(), rows)

    def test_bootstrap_finds_multidigit_only_train_project(self):
        with tempfile.TemporaryDirectory() as d:
            source, destination = Path(d) / "source", Path(d) / "destination"
            for iteration in ("0x", "10", "123"):
                marker = source / "work" / f"i{iteration}-train-refunds" / ".git/opencode"
                marker.parent.mkdir(parents=True)
                marker.write_text("project-" + iteration)
            copied = destination / "work/bootstrap-project/.git/opencode"
            copied.parent.mkdir(parents=True)
            with patch.object(sys, "argv", ["bootstrap", "--source-run", str(source),
                                           "--run-dir", str(destination), "--model", "test/model"]), \
                    patch.object(lib, "preflight"), patch.object(C, "require_dbt"), \
                    patch.object(C.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)), \
                    patch.object(bootstrap_bench, "prepare_home", side_effect=RuntimeError("project copied")):
                with self.assertRaisesRegex(RuntimeError, "project copied"):
                    bootstrap_bench.main()
            self.assertEqual(copied.read_text(), "project-10")

    def test_analysis_missing_checks_and_support(self):
        report = analyze_v1.eval_tables({"arm": [
            {"task": "heldout-invoices", "split": "heldout", "checks": {"C1": True}},
            {"task": "heldout-invoices", "split": "heldout", "checks": {}, "error": "setup"},
        ]})
        self.assertIn("| arm | 1/2 |", report)
        topic_report = analyze_v1.topic_tables({"arm": [{"request2": "heldout-support-tickets", "pass": True, "completed": True,
                                                       "same_session": True, "checks": {"C1": True}}]})
        self.assertIn("req2 support pass", topic_report)
        self.assertIn("1/1", topic_report)
        self.assertFalse(analyze_v1.topic_pass({"pass": True, "same_session": False}))
        unscored = analyze_v1.eval_tables({"arm": [{"task": "heldout-invoices", "split": "heldout",
                                                  "leak": None, "rescore_error": "missing"}]})
        self.assertIn("integrity unscored", unscored)
        self.assertIn("| 0 | 1 |", unscored)

    def test_topic_analysis_excludes_incomplete_denominators(self):
        records = []
        for task in ("heldout-invoices", "heldout-support-tickets", "control-customers-vip"):
            completed = {"request2": task, "pass": True, "same_session": True, "completed": True,
                         "checks": {"C1": True}}
            records.extend([completed, dict(completed, completed=False, error="incomplete")])
        report = analyze_v1.topic_tables({"arm": records})
        self.assertIn("| arm | 6 | 0 | 3 | 1/1 | 1/6 | 1/1 | 1/6 | 1/1 |", report)
        legacy = {"same_session": True, "pass": True,
                  "turn1": {"completed": True, "agent_rc": 0}, "turn2": {"completed": True, "rc": 0}}
        self.assertTrue(analyze_v1.topic_valid(legacy))
        self.assertFalse(analyze_v1.topic_valid(dict(legacy, turn1={"completed": True, "agent_rc": 1})))
        self.assertFalse(analyze_v1.topic_valid(dict(legacy, turn1={"agent_rc": 0})))

    def test_synthetic_task_inherits_split(self):
        cfg = json.loads((HERE / "topic_switch/tasks.json").read_text())
        base = C.load_tasks()
        for session in cfg["sessions"]:
            self.assertIn("split", base[session["request2"]])

    def test_topic_rejects_unknown_sessions_before_touching_output(self):
        cfg = json.loads((HERE / "topic_switch/tasks.json").read_text())
        known = cfg["sessions"][0]["id"]
        with tempfile.TemporaryDirectory() as d:
            output = Path(d) / "eval.jsonl"
            for ids in ("unknown-session", f"{known},unknown-session"):
                for existing in (False, True):
                    if existing:
                        output.write_text('{"preserve": true}\n')
                    else:
                        output.unlink(missing_ok=True)
                    with self.subTest(ids=ids, existing=existing), \
                            patch.object(sys, "argv", ["topic", "--run-dir", d, "--out", str(output),
                                                       "--arm", "none", "--sessions", ids]), \
                            patch.object(sys, "stderr", new_callable=io.StringIO) as stderr, \
                            patch.object(lib, "preflight"), patch.object(C, "require_dbt"), \
                            patch.object(C, "setup_users"), patch.object(C, "warm_users"), \
                            patch.object(C, "resolve_models"), patch.object(topic, "run_session", return_value={}) as run, \
                            patch.object(C, "reset_output", wraps=C.reset_output) as reset:
                        with self.assertRaises(SystemExit) as exc:
                            topic.main()
                        self.assertEqual(exc.exception.code, 2)
                        self.assertIn("unknown session IDs: unknown-session", stderr.getvalue())
                        reset.assert_not_called()
                        run.assert_not_called()
                        self.assertEqual(output.exists(), existing)
                        if existing:
                            self.assertEqual(output.read_text(), '{"preserve": true}\n')

    def test_topic_incomplete_and_resumption(self):
        with tempfile.TemporaryDirectory() as d:
            os.mkdir(os.path.join(d, "logs"))
            task = next(t for t in C.load_tasks().values() if t["split"] == "heldout")
            spec = {"run_dir": d, "session": {"id": "test-session"}, "t1": {"id": "one", "prompt": "explain"},
                    "t2": task, "arm": "none", "run_idx": 0, "arm_obj": lib.parse_arm("none"),
                    "model": "test/model", "prompt2": "build"}
            r1 = {"workdir": d, "session_id": "s1", "completed": False, "timed_out": True,
                  "leak": True, "leak_hits": [{"pattern": "verifier", "tool": "read", "input": "verifier.py"}]}
            with patch.object(C, "run_task", return_value=r1), patch.object(topic, "agent_turn") as turn2:
                rec = topic.run_session(spec)
                self.assertFalse(rec["pass"])
                self.assertTrue(rec["leak"])
                self.assertEqual(rec["leak_hits"], {"turn1": r1["leak_hits"], "turn2": []})
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

    def test_topic_leaks_preserve_both_turns(self):
        with tempfile.TemporaryDirectory() as d:
            os.mkdir(os.path.join(d, "logs"))
            task = next(t for t in C.load_tasks().values() if t["split"] == "heldout")
            spec = {"run_dir": d, "session": {"id": "test-session"}, "t1": {"id": "one", "prompt": "explain"},
                    "t2": task, "arm": "none", "run_idx": 0, "arm_obj": lib.parse_arm("none"),
                    "model": "test/model", "prompt2": "build"}
            first_hits = C.leak_scan([{"tool": "read", "input": "gold_playbook.md"}], d)
            second_inputs = [{"tool": "read", "input": "verifier.py"}]
            second_hits = C.leak_scan(second_inputs, d)
            self.assertTrue(first_hits)
            self.assertTrue(second_hits)
            for turn1_leak, turn2_leak in ((False, False), (True, False), (False, True), (True, True)):
                r1 = {"workdir": d, "session_id": "s1", "completed": True,
                      "leak": turn1_leak, "leak_hits": first_hits if turn1_leak else []}
                ev = {"session_id": "s1", "tokens": {}, "cost": 0, "tool_calls": 1, "steps": 1,
                      "tools": {}, "tool_inputs": second_inputs if turn2_leak else []}
                with self.subTest(turn1=turn1_leak, turn2=turn2_leak), \
                        patch.object(C, "run_task", return_value=r1), \
                        patch.object(topic, "agent_turn", return_value=(0, False, 123.25, 4.5)), \
                        patch.object(C, "parse_events", return_value=ev), patch.object(C, "user_env", return_value={}), \
                        patch.object(C, "agent_completed", return_value=True), \
                        patch.object(C, "run_verify", return_value={"pass": True, "score": 1.0,
                                                                   "checks": [{"name": "C1", "ok": True}]}), \
                        patch.object(C, "leak_scan", wraps=C.leak_scan) as scan:
                    rec = topic.run_session(spec)
                    self.assertTrue(rec["completed"])
                    self.assertEqual(rec["leak"], turn1_leak or turn2_leak)
                    self.assertEqual(rec["leak_hits"], {"turn1": r1["leak_hits"],
                                                        "turn2": second_hits if turn2_leak else []})
                    scan.assert_called_once_with(ev["tool_inputs"], d)

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
            with patch.object(C, "run_task", side_effect=turn1), \
                    patch.object(topic, "agent_turn", return_value=(1, False, 123.25, 4.5)), \
                    patch.object(C, "parse_events", return_value=ev), patch.object(C, "user_env", return_value={}), \
                    patch.object(C, "run_verify", return_value={"pass": True, "checks": [{"name": "C1", "ok": True}]}):
                failed = topic.run_session(spec)
            self.assertIn("turn1", failed["trace_paths"])
            self.assertNotIn("turn2", failed["trace_paths"])

    def test_topic_late_exceptions_do_not_trip_watchdog(self):
        with tempfile.TemporaryDirectory() as d, \
                patch.object(sys, "argv", ["topic", "--run-dir", d, "--out", os.path.join(d, "eval.jsonl"),
                                           "--arm", "none", "--parallel", "1"]), \
                patch.object(lib, "preflight"), patch.object(C, "require_dbt"), patch.object(C, "setup_users"), \
                patch.object(C, "warm_users"), patch.object(C, "resolve_models"), patch.object(C, "log"), \
                patch.object(topic, "run_session", side_effect=RuntimeError("followup failed")) as run:
            with self.assertRaises(SystemExit) as exc:
                topic.main()
            self.assertEqual(exc.exception.code, 1)
            expected = len(json.loads((HERE / "topic_switch/tasks.json").read_text())["sessions"])
            self.assertEqual(run.call_count, expected)
            self.assertTrue(all(r["turn1"]["tool_calls"] is None for r in C.read_jsonl(os.path.join(d, "eval.jsonl"))))

    def test_drift_training_failure_prevents_reflection_and_eval(self):
        with tempfile.TemporaryDirectory() as d:
            for extra in ([], ["--skip-eval"]):
                run = Path(d) / ("skip" if extra else "normal")
                session = {"task": "train-test", "workdir": str(run / "work"), "reviews": [],
                           "rounds": 0, "session_id": "s1", "error": "reviewer failed"}
                with patch.object(sys, "argv", ["drift", "--run-dir", str(run), "--iterations", "1"] + extra), \
                        patch.object(lib, "preflight"), patch.object(C, "require_dbt"), \
                        patch.object(C, "select_tasks", return_value=[{"id": "train-test"}]), \
                        patch.object(C, "setup_users"), patch.object(C, "warm_users"), \
                        patch.object(C, "resolve_models", return_value=("test/agent", "test/reflector")), \
                        patch.object(drift_v1.T, "setup_reviewer"), patch.object(drift_v1, "maintainer", return_value=str(run)), \
                        patch.object(lib, "load_lessons", return_value=[]), patch.object(lib, "read_approved", return_value=[]), \
                        patch.object(lib, "install_lessons"), patch.object(drift_v1.LC, "train_session", return_value=session), \
                        patch.object(drift_v1.LC, "assert_no_verifier_text"), patch.object(drift_v1, "copy_signals") as copy, \
                        patch.object(drift_v1, "learn") as learn, patch.object(eval_v1, "evaluate") as evaluate:
                    with self.assertRaisesRegex(SystemExit, "training session failed"):
                        drift_v1.main()
                    copy.assert_not_called()
                    learn.assert_not_called()
                    evaluate.assert_not_called()
                    self.assertFalse(any(r.get("type") in ("final", "online_metric")
                                         for r in C.read_jsonl(run / "loop.jsonl")))

    def test_drift_eval_only_requires_completed_training(self):
        with tempfile.TemporaryDirectory() as d:
            run = Path(d)
            final = run / "playbooks/final-approved.json"
            final.parent.mkdir()
            final.write_text('[]')
            approved = Path(lib.learn_dir(str(run / "work/maint"))) / "approved.json"
            approved.parent.mkdir(parents=True)
            approved.write_text('[]')
            log = run / "loop.jsonl"
            log.write_text('{"type": "seed"}\n')
            with patch.object(sys, "argv", ["drift", "--run-dir", d, "--label", "retry", "--eval-only", "--model", "test/agent"]), \
                    patch.object(lib, "preflight"), patch.object(C, "require_dbt"), \
                    patch.object(C, "setup_users"), patch.object(C, "warm_users"), \
                    patch.object(C, "resolve_models", return_value=("test/agent", "test/agent")), \
                    patch.object(drift_v1.LC, "train_session") as train, patch.object(drift_v1, "learn") as learn, \
                    patch.object(eval_v1, "evaluate", return_value=([{"completed": True}], False)) as evaluate:
                with self.assertRaisesRegex(SystemExit, "training is incomplete"):
                    drift_v1.main()
                evaluate.assert_not_called()
                log.write_text('{"type": "session", "error": "review failed"}\n{"type": "final", "ids": []}\n')
                with self.assertRaisesRegex(SystemExit, "training is incomplete"):
                    drift_v1.main()
                evaluate.assert_not_called()
                log.write_text('{"type": "final", "ids": ["L-abcd"]}\n')
                final.write_text('[{"id": "L-abcd", "text": "changed"}]')
                approved.write_text('[{"id": "L-abcd", "text": "original"}]')
                with self.assertRaisesRegex(SystemExit, "does not match"):
                    drift_v1.main()
                evaluate.assert_not_called()
                final.write_text('[]')
                approved.write_text('[]')
                log.write_text('{"type": "seed", "agent": "different/model"}\n{"type": "final", "ids": []}\n')
                with self.assertRaisesRegex(SystemExit, "training agent model"):
                    drift_v1.main()
                evaluate.assert_not_called()
                log.write_text('{"type": "final", "ids": []}\n')
                with self.assertRaises(SystemExit) as exc:
                    drift_v1.main()
                self.assertEqual(exc.exception.code, 0)
                self.assertEqual(evaluate.call_args.args[1:3], (f"lessons:{final}", "retry-final"))
                train.assert_not_called()
                learn.assert_not_called()
                self.assertEqual(log.read_text(), '{"type": "final", "ids": []}\n')

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
            with patch.object(C, "ALTIMATE_CMD", "bun run packages/opencode/src/index.ts"), \
                    patch.object(os.path, "isfile", return_value=True):
                with self.assertRaisesRegex(SystemExit, "absolute"):
                    lib.preflight()

    def test_leaked_output_is_incomplete(self):
        tasks = C.load_tasks()
        tasks.update(tasks_lib.load_dir(tasks_lib.VAGUE_DIR))
        cfg = json.loads((HERE / "topic_switch/tasks.json").read_text())
        indexes = {r["id"]: i for i, r in enumerate(cfg["request1"])}
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "eval.jsonl"
            for kind in ("eval", "vague", "topic"):
                splits = {"vague", "control"} if kind == "vague" else {"heldout", "control"}
                keys = ([{"session": s["id"], "run_idx": indexes[s["request1"]]} for s in cfg["sessions"]]
                        if kind == "topic" else [{"task": t["id"], "run_idx": 0}
                                                 for t in tasks.values() if t["split"] in splits])
                records = [dict(key, arm="test", completed=True, **{"pass": False}) for key in keys]
                for leak in (None, False, True):
                    with self.subTest(kind=kind, leak=leak):
                        if leak is not None:
                            records[0]["leak"] = leak
                        out.write_text("".join(json.dumps(r) + "\n" for r in records))
                        self.assertEqual(check_output.complete(out, "test", kind, 1), not bool(leak))

    @staticmethod
    def analysis_tables(report):
        tables = []
        for line in report.splitlines():
            if not line.startswith("| "):
                continue
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if cells[0] == "arm":
                columns = cells
                tables.append([])
            else:
                tables[-1].append(dict(zip(columns, cells)))
        return tables

    def test_analysis_excludes_leaks_from_all_metrics(self):
        for kind, render in (("eval", analyze_v1.eval_tables), ("topic", analyze_v1.topic_tables)):
            with self.subTest(kind=kind):
                tasks = [("heldout-invoices", "heldout"), ("heldout-support-tickets", "heldout"),
                         ("control-customers-vip", "control")]
                if kind == "eval":
                    tasks += [("vague-invoices", "vague"), ("vague-support-tickets", "vague")]
                clean, leaked = [], []
                for task, split in tasks:
                    turn = {"tokens": {"input": 10, "output": 2, "cache_read": 4, "cache_write": 3},
                            "steps": 2, "tool_calls": 1, "duration": 6, "cost": 0.01, "completed": True}
                    retrieval = {"needed": ["lesson"], "found": ["lesson"], "recall": 1,
                                 "recall_by_tier": {"core": 1}, "shown_by_tier": {"core": 1},
                                 "shown_kinds": {"near": 0, "distractor": 0}, "n_shown": 1,
                                 "precision": 1, "recall_turn2": 0, "in_context_from_turn1": ["lesson"]}
                    record = dict(turn, task=task, split=split, arm="test", leak=False, retrieval=retrieval,
                                  checks={"K1" if split == "control" else "C1": True}, **{"pass": True})
                    if kind == "topic":
                        record.update(request2=task, same_session=True, turn1=dict(turn), turn2=dict(turn))
                    clean.append(record)
                    bad_turn = dict(turn, tokens={key: 900 for key in turn["tokens"]},
                                    tool_calls=900, duration=900, cost=900)
                    bad_retrieval = dict(retrieval, needed=["leaked-only"], found=[], recall=0,
                                         recall_by_tier={}, shown_by_tier={"core": 900},
                                         shown_kinds={"near": 900, "distractor": 900}, n_shown=900,
                                         precision=0, recall_turn2=1, in_context_from_turn1=[])
                    bad = dict(record, **bad_turn)
                    bad.update(leak=True, retrieval=bad_retrieval, checks={},
                               turn1=bad_turn, turn2=bad_turn, **{"pass": False})
                    leaked.append(bad)
                with patch.object(analyze_v1, "trace_stats", side_effect=lambda r: {
                        "first_input": 900 if r.get("leak") else 10,
                        "cache_read": 900 if r.get("leak") else 4}):
                    report = render({"test": clean + leaked})
                    expected = self.analysis_tables(render({"test": clean}))
                self.assertNotIn("leaked-only", report)
                actual = self.analysis_tables(report)
                clean_excluded = expected[0][0].pop("leaks excluded", None)
                leaked_excluded = actual[0][0].pop("leaks excluded", None)
                self.assertEqual(actual, expected)
                self.assertEqual(clean_excluded, "0")
                self.assertEqual(leaked_excluded, str(len(leaked)))

    def test_analysis_reports_entirely_leaked_arms(self):
        leaked = {"task": "heldout-invoices", "split": "heldout", "request2": "heldout-invoices",
                  "same_session": True, "completed": True, "pass": True, "checks": {"C1": True}, "leak": True}
        self.assertFalse(analyze_v1.topic_valid(leaked))
        self.assertFalse(analyze_v1.topic_pass(leaked))
        for render, count, outcome in ((analyze_v1.eval_tables, "runs", "heldout pass"),
                                       (analyze_v1.topic_tables, "sessions", "req2 heldout pass")):
            with self.subTest(count=count):
                row = self.analysis_tables(render({"test": [leaked]}))[0][0]
                self.assertEqual(row[count], "0")
                self.assertEqual(row["leaks excluded"], "1")
                self.assertEqual(row[outcome], "-")



if __name__ == "__main__":
    unittest.main()
