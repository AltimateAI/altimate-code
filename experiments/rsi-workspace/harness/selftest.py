#!/usr/bin/env python3
"""Unpaid safety/control-flow regressions; all agent and remote calls are mocked."""
import io
import json
import os
from contextlib import ExitStack
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import common as C
import ablation as A
import eval as E
import loop as L
import loop_corrections as LC
import publish_replace as PR
import rescore
import report as R
import teammate as T
from budget.review_selftest import RunnerBudgetReviewTests


class HarnessTests(unittest.TestCase):
    def test_ids_and_fresh_runs(self):
        for bad in ("", ".", "..", "/tmp", "a/b", "a\\b", "../x", "-x"):
            with self.assertRaises(ValueError):
                C.validate_id(bad)
        with tempfile.TemporaryDirectory() as d, patch.object(C, "RUNS", d):
            C.run_dir_for(run_id="valid-1")
            with self.assertRaises(FileExistsError):
                C.run_dir_for(run_id="valid-1")
            self.assertNotEqual(C.new_run_id(), C.new_run_id())

    def test_delete_and_output_containment(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "owned"
            root.mkdir()
            outside = Path(d) / "keep"
            outside.mkdir()
            (root / "link").symlink_to(outside, target_is_directory=True)
            for bad in ("", str(root), str(outside), str(root / "link")):
                with self.assertRaises(ValueError):
                    C.safe_rmtree(bad, str(root))
            with self.assertRaises(ValueError):
                C.reset_output(str(root / "link" / "out"), str(root))
            child = root / "safe"
            child.mkdir()
            C.safe_rmtree(str(child), str(root))
            self.assertFalse(child.exists())
            self.assertTrue(outside.exists())

    def test_prepare_workdir_requires_marker_and_repository_provenance(self):
        script = str(Path(C.DEMO) / "prepare_workdir.py")
        env = dict(os.environ, DBT_BIN=shutil.which("true"), GIT_CONFIG_NOSYSTEM="1",
                   GIT_CONFIG_GLOBAL=os.devnull)

        def git(dest, *args):
            subprocess.run(["git", "-C", str(dest), *args], env=env,
                           capture_output=True, text=True, check=True)

        def prepare(dest):
            return subprocess.run([sys.executable, script, "train-refunds", str(dest)], env=env,
                                  capture_output=True, text=True)

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for case in ("marker-only", "missing-origin", "wrong-origin", "missing-marker", "nested"):
                with self.subTest(case=case):
                    dest = root / case
                    dest.mkdir()
                    if case != "marker-only":
                        git(dest, "init", "-q")
                    if case in ("wrong-origin", "missing-marker", "nested"):
                        remote = "git@github.com:other/project.git" if case == "wrong-origin" else C.REMOTE
                        git(dest, "remote", "add", "origin", remote)
                    if case == "nested":
                        dest = dest / "child"
                        dest.mkdir()
                    if case != "missing-marker":
                        (dest / ".prepared").write_text("train-refunds\n")
                    sentinel = dest / "keep.txt"
                    sentinel.write_text("preserve me\n")
                    result = prepare(dest)
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("refusing to overwrite", result.stderr)
                    self.assertIn("git repository rooted here with origin", result.stderr)
                    self.assertEqual(sentinel.read_text(), "preserve me\n")

            dest = root / "prepared"
            dest.mkdir()  # Empty destinations still work.
            first = prepare(dest)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            sentinel = dest / "discard.txt"
            sentinel.write_text("previous run\n")
            rebuilt = prepare(dest)
            self.assertEqual(rebuilt.returncode, 0, rebuilt.stdout + rebuilt.stderr)
            self.assertFalse(sentinel.exists())
            self.assertEqual((dest / ".prepared").read_text(), "train-refunds\n")

    def test_explicit_fake_and_saas_opt_in(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {}, clear=True):
            C.setup_users(d)
            self.assertEqual(C.Backend(d, "fake").mode, "fake")
            creds = json.loads((Path(d) / "home-a/.altimate/altimate.json").read_text())
            self.assertTrue(creds["altimateUrl"].startswith("http://127.0.0.1:"))
            self.assertEqual(C.user_env(d, "a")["OPENCODE_TEST_HOME"], os.path.join(d, "home-a"))
            with self.assertRaises(ValueError):
                C.Backend(d, workspace_id=4242)
            with patch.dict(os.environ, ALLOW_REAL_SAAS="1"), patch.object(C, "SAAS_CREDS_DIR", d):
                with self.assertRaises(ValueError):
                    C.Backend(d, "saas")
                self.assertEqual(C.Backend(d, "saas", 4242).workspace_id, 4242)

    def test_publish_replace_requires_workspace_id_and_honors_precedence(self):
        missing = object()
        cases = [("saas", None, None, missing), ("fake", None, None, None), ("saas", "4242", None, 4242),
                 ("saas", None, "5252", 5252), ("saas", "4242", "5252", 5252), ("fake", "invalid", "5252", 5252)]
        for backend_mode, env_id, cli_id, expected in cases:
            with self.subTest(backend=backend_mode, env_id=env_id, cli_id=cli_id), tempfile.TemporaryDirectory() as d, ExitStack() as stack:
                final = Path(d) / "playbooks/final.md"
                final.parent.mkdir()
                final.write_text("approved lessons")
                argv = ["publish_replace.py", d, "--backend", backend_mode]
                if cli_id is not None:
                    argv += ["--workspace-id", cli_id]
                stack.enter_context(patch.object(sys, "argv", argv))
                stack.enter_context(patch.dict(os.environ, {} if env_id is None else {"WORKSPACE_ID": env_id}, clear=True))
                approved = stack.enter_context(patch.object(PR, "export_approved", return_value=final.read_text()))
                backend = stack.enter_context(patch.object(C, "Backend"))
                publish = stack.enter_context(patch.object(PR, "publish"))
                error = stack.enter_context(patch.object(sys, "stderr", new_callable=io.StringIO))
                if expected is missing:
                    with self.assertRaises(SystemExit) as caught:
                        PR.main()
                    self.assertNotEqual(caught.exception.code, 0)
                    self.assertIn("--backend saas requires --workspace-id or WORKSPACE_ID", error.getvalue())
                    approved.assert_not_called()
                    backend.assert_not_called()
                    publish.assert_not_called()
                else:
                    PR.main()
                    backend.assert_called_once_with(d, backend_mode, expected)
                    publish.assert_called_once()

    def events(self):
        return {"session_id": "s1", "termination": {"done_reason": "explicit_done", "why_harness_stopped": "none"},
                "errors": [], "tokens": {}, "cost": 0, "tool_calls": 1, "steps": 1,
                "tools": {}, "tool_inputs": [], "skill_loaded": False}

    def test_incomplete_turns_cannot_score(self):
        task = {"id": "test-task", "split": "val", "setup": ["mock"], "prompt": "do it"}
        class Process:
            def __init__(self, rc):
                self.returncode = rc
            def wait(self, timeout=None):
                return self.returncode
        good_verify = {"pass": True, "score": 1.0, "checks": [{"name": "C1_name", "ok": True}]}
        with tempfile.TemporaryDirectory() as d:
            for rc, done in ((0, "explicit_done"), (1, "explicit_done"), (0, "none")):
                ev = self.events()
                ev["termination"]["done_reason"] = done
                with patch.object(C.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")), \
                        patch.object(C.subprocess, "Popen", return_value=Process(rc)), patch.object(C.time, "sleep"), \
                        patch.object(C, "parse_events", return_value=ev), patch.object(C, "run_verify", return_value=good_verify):
                    rec = C.run_task({"run_dir": d, "task": task, "arm": "none"})
                expected = rc == 0 and done == "explicit_done"
                self.assertEqual(rec["pass"], expected)
                self.assertEqual(rec["checks"]["C1"], expected)
                self.assertEqual(rec["score"], 1.0 if expected else 0.0)
            self.assertFalse(C.agent_completed(self.events(), 0, timed_out=True))

    def test_gate_requires_valid_balanced_validation(self):
        self.assertFalse(L.gate([], [], 0)["promote"])
        failed = {"task": "v", "completed": True, "checks": {}, "pass": False}
        self.assertFalse(L.gate([failed], [failed], 0)["promote"])
        good = dict(failed, checks={"C1": True}, **{"pass": True})
        self.assertTrue(L.gate([good], [good], 0)["promote"])
        self.assertFalse(L.gate([good], [good, good], 0)["promote"])
        self.assertFalse(L.gate([dict(good, error="verifier failed")], [good], 0)["promote"])

    def test_json_lessons_export_and_missing_feedback(self):
        with tempfile.TemporaryDirectory() as d:
            approved, candidate = L.learn_paths(d)
            Path(approved).parent.mkdir(parents=True)
            Path(approved).write_text(json.dumps([{"id": "L-abcd", "text": "In staging, use a macro."}]))
            self.assertEqual(L.export_approved(d), Path(C.skill_path(d)).read_text())
            self.assertTrue(candidate.endswith("candidate.json"))
            rec = {"split": "train", "task": "train-refunds", "error": "setup failed"}
            self.assertIn("setup failed", L.feedback_for_reflect(rec))
            self.assertTrue(L.reflect(d, d, rec, "model", "feedback", "test")["skipped"])

    def test_named_signal_copy(self):
        with tempfile.TemporaryDirectory() as d:
            work, maint = os.path.join(d, "work"), os.path.join(d, "maint")
            p = Path(LC.signals_file(work))
            p.parent.mkdir(parents=True)
            p.write_text(json.dumps({"id": "signal1", "session": "s1", "status": "consumed"}) + "\n")
            self.assertEqual(LC.copy_signals(work, maint), 1)
            self.assertEqual(LC.copy_signals(work, maint), 0)
            self.assertEqual(C.read_jsonl(LC.signals_file(maint))[0]["status"], "open")

    def test_reviewer_completion_marker(self):
        self.assertTrue(T.is_lgtm(T.clean_message("LGTM\nDONE")))
        self.assertEqual(T.clean_message("Fix the timestamps.\nDONE"), "Fix the timestamps.")
        self.assertTrue(C.completion_prompt("review").endswith("standalone DONE line."))

    def test_errored_reviewer_text_is_not_forwarded(self):
        task = {"id": "train-test", "split": "train"}
        first = {"session_id": "s1", "completed": True, "workdir": "/unused/work"}
        review = {"text": "Partial correction", "lgtm": False, "cost": 0, "error": "reviewer timed out"}
        with tempfile.TemporaryDirectory() as d, patch.object(C, "run_task", return_value=first), \
                patch.object(T, "review", return_value=review), patch.object(LC, "followup") as followup, \
                patch.object(LC, "captured_signals", return_value={}):
            result = LC.train_session(d, task, None, "mock", "mock", 1, os.path.join(d, "eval.jsonl"))
        self.assertEqual(result["error"], "reviewer timed out")
        followup.assert_not_called()

    def test_system_prompt_trace_detects_loaded_playbook(self):
        # session/prompt.ts emits this content via Tracer.logSpan; FileExporter serializes it as JSON.
        trace = {"spans": [{"name": "system-prompt", "output": {"parts": 1,
                 "content": '<auto_loaded_skill name="team-playbook">\nUse cents → dollars.\n</auto_loaded_skill>'}}]}
        self.assertTrue(C.playbook_in_trace(json.dumps(trace, ensure_ascii=False)))
        self.assertFalse(C.playbook_in_trace(json.dumps(trace).replace("team-playbook", "other-skill")))

    def test_native_signal_reflection_reopens_only_its_session(self):
        with tempfile.TemporaryDirectory() as d:
            work, maint = os.path.join(d, "work"), os.path.join(d, "maint")
            path = Path(LC.signals_file(work))
            path.parent.mkdir(parents=True)
            rows = [{"id": "one", "session": "s1", "status": "consumed", "consumedBy": "auto"},
                    {"id": "two", "session": "s2", "status": "consumed", "consumedBy": "auto"}]
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            def reflect(run_dir, cwd, args):
                self.assertEqual(args[-2:], ["--signals-from", work])
                signals = C.read_jsonl(str(path))
                self.assertEqual(signals[0]["status"], "open")
                self.assertNotIn("consumedBy", signals[0])
                self.assertEqual(signals[1], rows[1])
                return subprocess.CompletedProcess([], 0, '{}', '')
            with patch.object(LC, "learn", side_effect=reflect):
                result = LC.reflect_session(d, maint, {"workdir": work, "session_id": "s1"},
                                            "mock", {"signals_from": True})
            self.assertTrue(result["ok"])

    def test_ablation_rejects_failed_reflection(self):
        with tempfile.TemporaryDirectory() as d, ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", ["ablation.py", "--run-dir", d]))
            for name in ("require_learn", "require_dbt", "setup_users", "warm_users"):
                stack.enter_context(patch.object(C, name))
            stack.enter_context(patch.object(C, "resolve_models", return_value=("mock", "mock")))
            stack.enter_context(patch.object(C, "select_tasks", return_value=[{"id": "train-test"}]))
            stack.enter_context(patch.object(C, "run_many", return_value=[{"task": "train-test"}]))
            stack.enter_context(patch.object(L, "maintainer", return_value=d))
            stack.enter_context(patch.object(L, "reflect", return_value={"ok": False, "error": "failed"}))
            with self.assertRaisesRegex(SystemExit, "reflection failed"):
                A.main()
            self.assertFalse((Path(d) / "playbook-nofeedback.md").exists())

    def test_ablation_rejects_cross_run_reuse_before_resetting_learning(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as other, ExitStack() as stack:
            candidate = Path(d) / "work/maint-ablation/candidate.json"
            candidate.parent.mkdir(parents=True)
            candidate.write_text("[]")
            archived = Path(d) / "learn-history-ablation/history/kept.json"
            archived.parent.mkdir(parents=True)
            archived.write_text("{}")
            stack.enter_context(patch.object(sys, "argv", ["ablation.py", "--run-dir", d, "--from-loop", other]))
            for name in ("require_learn", "require_dbt"):
                stack.enter_context(patch.object(C, name))
            with self.assertRaisesRegex(SystemExit, "--from-loop must be the run dir itself"):
                A.main()
            self.assertTrue(candidate.exists())
            self.assertTrue(archived.exists())

    def test_ablation_retry_resets_learning_and_preserves_pass_accumulation(self):
        with tempfile.TemporaryDirectory() as d, ExitStack() as stack:
            maint = Path(d) / "work/maint-ablation"
            candidate = Path(L.learn_paths(str(maint))[1])
            candidate.parent.mkdir(parents=True)
            candidate.write_text(json.dumps([{"id": "stale", "text": "prior invocation"}]))
            history = maint / ".altimate-code/learn/history"
            history.mkdir()
            (history / "stale.json").write_text("{}")
            archived = Path(d) / "learn-history-ablation/history"
            archived.mkdir(parents=True)
            (archived / "stale-archive.json").write_text("{}")
            tasks = [{"id": "train-one"}, {"id": "train-two"}]
            records = [{"task": task["id"]} for task in tasks]
            observed = []

            def maintainer(run_dir, name):
                self.assertEqual(name, "maint-ablation")
                maint.mkdir(parents=True, exist_ok=True)
                return str(maint)

            def reflect(run_dir, cwd, record, model, feedback, tag):
                self.assertEqual(feedback, A.NO_FEEDBACK)
                lessons = json.loads(candidate.read_text()) if candidate.exists() else []
                observed.append([lesson["id"] for lesson in lessons])
                lessons.append({"id": record["task"], "text": record["task"]})
                candidate.parent.mkdir(parents=True, exist_ok=True)
                candidate.write_text(json.dumps(lessons))
                history.mkdir(exist_ok=True)
                (history / f"pass-{len(observed)}.json").write_text("{}")
                return {"ok": True}

            stack.enter_context(patch.object(sys, "argv", ["ablation.py", "--run-dir", d]))
            for name in ("require_learn", "require_dbt", "setup_users", "warm_users"):
                stack.enter_context(patch.object(C, name))
            stack.enter_context(patch.object(C, "resolve_models", return_value=("mock", "mock")))
            stack.enter_context(patch.object(C, "select_tasks", return_value=tasks))
            stack.enter_context(patch.object(C, "run_many", return_value=records))
            stack.enter_context(patch.object(L, "maintainer", side_effect=maintainer))
            stack.enter_context(patch.object(L, "reflect", side_effect=reflect))
            for invocation in range(2):
                A.main()
                self.assertEqual([lesson["id"] for lesson in json.loads(candidate.read_text())],
                                 [task["id"] for task in tasks])
                expected_history = {f"pass-{invocation * 2 + i}.json" for i in (1, 2)}
                self.assertEqual({p.name for p in history.iterdir()}, expected_history)
                self.assertEqual({p.name for p in archived.iterdir()}, expected_history)
                playbook = (Path(d) / "playbook-nofeedback.md").read_text()
                self.assertIn("train-one", playbook)
                self.assertIn("train-two", playbook)
                self.assertNotIn("prior invocation", playbook)
            self.assertEqual(observed, [[], ["train-one"], [], ["train-one"]])

    def test_skipped_training_reflection_prevents_gating(self):
        records = [{"task": "train-good", "split": "train", "pass": True, "checks": {"C1": True}},
                   {"task": "train-incomplete", "split": "train", "pass": False, "checks": {}}]
        with tempfile.TemporaryDirectory() as d, ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", ["loop.py", "--run-dir", d, "--iterations", "1"]))
            for name in ("require_learn", "require_dbt", "warm_users"):
                stack.enter_context(patch.object(C, name))
            be = MagicMock(mode="fake", workspace_id=4242)
            be.binding.return_value, be.published_skill.return_value = {}, {}
            stack.enter_context(patch.object(C, "Backend")).return_value.__enter__.return_value = be
            stack.enter_context(patch.object(C, "resolve_models", return_value=("mock", "mock")))
            stack.enter_context(patch.object(C, "select_tasks", return_value=[{"id": "train-test"}]))
            runs = stack.enter_context(patch.object(C, "run_many", return_value=records))
            stack.enter_context(patch.object(L, "maintainer", return_value=d))
            stack.enter_context(patch.object(L, "feedback_for_reflect", return_value="feedback"))
            stack.enter_context(patch.object(L, "reflect", side_effect=[{"ok": True}, {"ok": False, "skipped": True}]))
            gate = stack.enter_context(patch.object(L, "gate"))
            with self.assertRaisesRegex(SystemExit, "refusing to gate partial"):
                L.main()
            gate.assert_not_called()
            self.assertEqual(runs.call_count, 1)

    def test_errored_training_session_prevents_corrections_promotion(self):
        for error in ("reviewer timed out", "correction turn incomplete or did not resume session"):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as d, ExitStack() as stack:
                stack.enter_context(patch.object(sys, "argv", ["loop_corrections.py", "--run-dir", d, "--iterations", "1"]))
                for name in ("require_learn", "require_dbt", "warm_users"):
                    stack.enter_context(patch.object(C, name))
                be = MagicMock(mode="fake", workspace_id=4242)
                be.binding.return_value, be.published_skill.return_value = {}, {}
                stack.enter_context(patch.object(C, "Backend")).return_value.__enter__.return_value = be
                stack.enter_context(patch.object(C, "resolve_models", return_value=("mock", "mock")))
                stack.enter_context(patch.object(C, "select_tasks", return_value=[{"id": "train-test"}]))
                stack.enter_context(patch.object(T, "setup_reviewer"))
                stack.enter_context(patch.object(LC, "maintainer", return_value=d))
                stack.enter_context(patch.object(LC, "product_caps", return_value={"signals_from": True}))
                session = {"task": "train-test", "split": "train", "iter": 1, "workdir": d,
                           "rounds": 0, "reviews": [], "session_id": "s1", "error": error}
                stack.enter_context(patch.object(LC, "train_session", return_value=session))
                reflect = stack.enter_context(patch.object(LC, "reflect_session"))
                learn = stack.enter_context(patch.object(LC, "learn"))
                with self.assertRaisesRegex(SystemExit, "training session failed"):
                    LC.main()
                reflect.assert_not_called()
                learn.assert_not_called()
                rows = C.read_jsonl(os.path.join(d, "loop.jsonl"))
                self.assertEqual([r["error"] for r in rows if r["type"] == "session"], [error])
                self.assertFalse(any(r["type"] in ("online_metric", "gate") for r in rows))

    def test_publish_conflict_recovers_malformed_ledger(self):
        for original in ("{broken", "[]", "null", '{"preserved": {"publicId": "old"}}'):
            with self.subTest(original=original), tempfile.TemporaryDirectory() as d:
                ledger = Path(d) / "home-a/.local/state/altimate-code/altimate-published-skills.json"
                ledger.parent.mkdir(parents=True)
                ledger.write_text(original)
                be = MagicMock()
                be._creds.return_value = ("http://localhost", "test", "unused")
                be.api.side_effect = [{"created_by": 1}, {"id": 1}]
                conflict = subprocess.CompletedProcess([], 1, "409 conflict", "")
                success = subprocess.CompletedProcess([], 0, "published", "")
                with patch.object(C, "altimate", side_effect=[conflict, success]) as publish, \
                        patch.object(LC, "find_skill_by_name", return_value={"public_id": "existing"}):
                    self.assertEqual(LC.publish_command(d, be, d).returncode, 0)
                self.assertEqual(publish.call_count, 2)
                rows = json.loads(ledger.read_text())
                self.assertTrue(any(row["publicId"] == "existing" for row in rows.values()))
                if "preserved" in original:
                    self.assertIn("preserved", rows)

    def test_report_counts_each_error_source_once(self):
        base = {"arm": "none", "split": "heldout", "task": "test"}
        records = [base, dict(base, error="setup failed"), dict(base, errors=["agent error"]),
                   dict(base, verify={"error": "unparsable"}),
                   dict(base, error="failed", errors=["event"], verify={"error": "unparsable"})]
        rows, _ = R.arm_split_rows(records)
        self.assertEqual(rows[0]["errors"], 4)

    def test_missing_rescore_events_are_reported_as_unscored(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "eval/none.jsonl"
            out.parent.mkdir()
            out.write_text(json.dumps({"arm": "none", "split": "heldout", "task": "test",
                                       "events": "missing.jsonl", "workdir": d}) + "\n")
            with patch.object(sys, "stdout", new_callable=io.StringIO) as output:
                rescore.main(d)
            self.assertIn("leak=0/0 scored unscored=1", output.getvalue())
            records = C.read_jsonl(str(out))
            self.assertIsNone(records[0]["leak"])
            rows, _ = R.arm_split_rows(records)
            self.assertEqual(rows[0]["unscored"], 1)
            self.assertIn("integrity unscored", R.render_eval(records))
            self.assertIn("| 0/0 | 1 |", R.render_eval(records))

    def test_workspace_b_preflights_b_model_access(self):
        with tempfile.TemporaryDirectory() as d, ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", ["eval.py", "--arm", "workspace-B", "--run-dir", d,
                                                          "--out", os.path.join(d, "eval/out.jsonl")]))
            stack.enter_context(patch.object(C, "require_dbt"))
            stack.enter_context(patch.object(C, "warm_users"))
            be = MagicMock()
            be.published_skill.return_value = {"found": True}
            stack.enter_context(patch.object(C, "Backend")).return_value.__enter__.return_value = be
            def models(args, cwd, env, timeout):
                self.assertEqual(env["HOME"], os.path.join(d, "home-b"))
                return subprocess.CompletedProcess([], 0, "unavailable-to-b", "")
            stack.enter_context(patch.object(C, "altimate", side_effect=models))
            evaluate = stack.enter_context(patch.object(E, "evaluate"))
            with self.assertRaisesRegex(RuntimeError, "model preflight failed"):
                E.main()
            evaluate.assert_not_called()

    def test_workspace_target_and_stale_hash(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d) / ".altimate-code/skill/_workspace"
            for name in ("unrelated", C.PLAYBOOK_NAME):
                path = base / name / "SKILL.md"
                path.parent.mkdir(parents=True)
                path.write_text(C.wrap_skill("body", name=name))
            self.assertEqual(len(C.workspace_skills(d)), 1)
            class Backend:
                def published_skill(self, user):
                    return {"found": True, "sha": "new"}
            def run(specs, parallel, on_done):
                rec = {"completed": True, "ws_arrived": True, "ws_skills": [{"sha": "old"}]}
                on_done(rec)
                return [rec]
            with patch.object(C, "select_tasks", return_value=[{"id": "x"}]), patch.object(C, "run_many", side_effect=run):
                with self.assertRaises(SystemExit):
                    E.evaluate(d, "workspace-B", ["heldout"], 1, os.path.join(d, "eval/out.jsonl"), backend=Backend())

    def test_copied_baseline_resolves_original_events(self):
        with tempfile.TemporaryDirectory() as d:
            original, copied = Path(d) / "original", Path(d) / "copied"
            (original / "logs").mkdir(parents=True)
            (copied / "eval").mkdir(parents=True)
            (original / "logs/events.jsonl").write_text('{}\n')
            out = copied / "eval/none.jsonl"
            out.write_text(json.dumps({"events": "logs/events.jsonl", "workdir": str(original / "work/w"),
                                       "leak": True, "leak_hits": ["stale"], "session_id": None}) + "\n")
            rescore.main(str(copied))
            self.assertIs(C.read_jsonl(str(out))[0]["leak"], False)

    def test_shell_ids(self):
        helper = str(Path(__file__).with_name("shell_common.sh"))
        for bad in ("", ".", "..", "/tmp", "a/b", "a\\b"):
            proc = subprocess.run(["bash", "-c", 'source "$1"; validate_id "$2"', "test", helper, bad],
                                  capture_output=True, text=True)
            self.assertNotEqual(proc.returncode, 0)

    def test_corrections_baseline_requires_explicit_reuse(self):
        # Exercise the real shell branches without running agents or remote calls.
        here = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            harness = root / "harness"
            harness.mkdir()
            for name in ("run_corrections.sh", "shell_common.sh"):
                shutil.copy(here / name, harness)
            historical = harness / "runs/saas-v2/eval/none.jsonl"
            historical.parent.mkdir(parents=True)
            historical.write_text('{"historical": true}\n')
            source = root / "explicit baseline.jsonl"
            source.write_text('{"reused": true}\n')
            calls = root / "calls.jsonl"
            shim = root / "bin"
            shim.mkdir()
            python = shim / "python3"
            python.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["CALLS_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if args[0] == "eval.py":
    Path(args[args.index("--out") + 1]).write_text('{"fresh": true}\\n')
elif args[0] == "loop_corrections.py":
    final = Path(args[args.index("--run-dir") + 1]) / "playbooks/final.md"
    final.parent.mkdir(parents=True)
    final.write_text("test playbook")
''')
            python.chmod(0o755)
            for label, baseline in (("unset", None), ("empty", ""), ("explicit", str(source)),
                                    ("missing", str(root / "missing.jsonl")), ("directory", str(root))):
                with self.subTest(baseline=label):
                    calls.write_text("")
                    env = dict(os.environ, PATH=str(shim) + os.pathsep + os.environ["PATH"],
                               BACKEND="fake", CALLS_LOG=str(calls))
                    env.pop("BASELINE_FROM", None)
                    if baseline is not None:
                        env["BASELINE_FROM"] = baseline
                    proc = subprocess.run(["bash", str(harness / "run_corrections.sh"), label],
                                          env=env, capture_output=True, text=True)
                    run = harness / "runs" / label
                    invocations = C.read_jsonl(str(calls))
                    if label in ("missing", "directory"):
                        self.assertNotEqual(proc.returncode, 0)
                        self.assertIn("BASELINE_FROM file does not exist or is not a regular file", proc.stderr)
                        self.assertIn(baseline, proc.stderr)
                        self.assertFalse(run.exists())
                        self.assertEqual(invocations, [])
                        continue
                    self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                    baseline_calls = [args for args in invocations if args[0] == "eval.py"
                                      and args[args.index("--arm") + 1] == "none"]
                    fresh = label in ("unset", "empty")
                    self.assertEqual(len(baseline_calls), 1 if fresh else 0)
                    self.assertEqual((run / "eval/none.jsonl").read_text(),
                                     '{"fresh": true}\n' if fresh else source.read_text())
            self.assertEqual(historical.read_text(), '{"historical": true}\n')
            self.assertEqual(source.read_text(), '{"reused": true}\n')

    def test_budget_and_matrix_failures_propagate(self):
        # Copy runners and stub Python/sleep: this can never launch a model or wait 30s.
        here = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            harness = root / "harness"
            (harness / "budget").mkdir(parents=True)
            shutil.copy(here / "shell_common.sh", harness)
            for p in (here / "budget").glob("*.sh"):
                shutil.copy(p, harness / "budget" / p.name)
            shim = root / "bin"
            shim.mkdir()
            python = shim / "python3"
            python.write_text('#!/bin/bash\ncase "$1" in eval.py|loop_corrections.py) exit 7 ;; -) echo /bin/true ;; esac\n')
            python.chmod(0o755)
            sleep = shim / "sleep"
            sleep.write_text("#!/bin/bash\nexit 0\n")
            sleep.chmod(0o755)
            entry = root / "fix checkout/packages/opencode/src/index.ts"
            entry.parent.mkdir(parents=True)
            entry.touch()
            env = dict(os.environ, PATH=str(shim) + os.pathsep + os.environ["PATH"], BACKEND="fake",
                       FIX_SRC_ROOT=str(root / "fix checkout"), RD=str(root / "budget-output"), ARMS="conflict")
            for name in ("run_budget.sh", "run_budget2.sh", "run_drift_matrix.sh", "run_drift_matrix2.sh"):
                proc = subprocess.run(["bash", str(harness / "budget" / name)], env=env, capture_output=True, text=True)
                self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertNotIn("=== done", proc.stdout)
                self.assertNotIn("matrix done", proc.stdout)


if __name__ == "__main__":
    unittest.main()
