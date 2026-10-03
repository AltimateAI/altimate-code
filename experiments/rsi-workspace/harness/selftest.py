#!/usr/bin/env python3
"""Unpaid safety/control-flow regressions; all agent and remote calls are mocked."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import common as C
import eval as E
import loop as L
import loop_corrections as LC
import rescore
import teammate as T


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

    def test_fake_default_and_saas_opt_in(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {}, clear=True):
            C.setup_users(d)
            self.assertEqual(C.Backend(d).mode, "fake")
            creds = json.loads((Path(d) / "home-a/.altimate/altimate.json").read_text())
            self.assertTrue(creds["altimateUrl"].startswith("http://127.0.0.1:"))
            self.assertEqual(C.user_env(d, "a")["OPENCODE_TEST_HOME"], os.path.join(d, "home-a"))
            with self.assertRaises(ValueError):
                C.Backend(d, "saas", 17)
            with patch.dict(os.environ, ALLOW_REAL_SAAS="1"), patch.object(C, "SAAS_CREDS_DIR", d):
                with self.assertRaises(ValueError):
                    C.Backend(d, "saas")
                self.assertEqual(C.Backend(d, "saas", 17).workspace_id, 17)

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
            self.assertFalse(C.read_jsonl(str(out))[0]["leak"])

    def test_shell_ids(self):
        helper = str(Path(__file__).with_name("shell_common.sh"))
        for bad in ("", ".", "..", "/tmp", "a/b", "a\\b"):
            proc = subprocess.run(["bash", "-c", 'source "$1"; validate_id "$2"', "test", helper, bad],
                                  capture_output=True, text=True)
            self.assertNotEqual(proc.returncode, 0)

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
