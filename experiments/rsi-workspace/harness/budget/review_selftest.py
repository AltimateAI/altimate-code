#!/usr/bin/env python3
"""Unpaid runner and budget-analysis review regressions."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent


class RunnerBudgetReviewTests(unittest.TestCase):
    def test_missing_checks_count_as_per_check_failures(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "eval"
            out.mkdir()
            base = {"arm": "sample", "task": "heldout-disputes", "split": "heldout"}
            records = [dict(base, checks={f"C{i}": True for i in range(1, 7)}, **{"pass": True}),
                       dict(base, error="setup failed", **{"pass": False})]
            (out / "sample.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
            proc = subprocess.run([sys.executable, str(HERE / "analyze.py"), "--run-dir", d,
                                   "--labels", "sample"], capture_output=True, text=True, check=True)
            self.assertIn("| sample | " + " | ".join(["1/2"] * 6) + " |", proc.stdout)

    def test_remaining_arms_run_without_promoted_playbook(self):
        # Only shell copies execute, with every Python call intercepted before it can launch an agent.
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            harness = root / "harness"
            run_dir = harness / "runs/example"
            (run_dir / "eval").mkdir(parents=True)
            for name in ("run_arms.sh", "shell_common.sh"):
                shutil.copyfile(HERE.parent / name, harness / name)
            shim = root / "bin"
            shim.mkdir()
            stub = shim / "python3"
            stub.write_text('#!/bin/bash\necho "$*" >> "$STUB_LOG"\n')
            stub.chmod(0o755)
            log = root / "calls"
            env = dict(os.environ, PATH=str(shim) + os.pathsep + os.environ["PATH"],
                       BACKEND="fake", STUB_LOG=str(log))
            for promoted in (False, True):
                if promoted:
                    (run_dir / "playbooks").mkdir()
                    (run_dir / "playbooks/final.md").write_text("playbook")
                log.write_text("")
                proc = subprocess.run(["bash", str(harness / "run_arms.sh"), "example"], env=env,
                                      capture_output=True, text=True)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                calls = log.read_text()
                self.assertIn("--arm gold", calls)
                self.assertIn("ablation.py", calls)
                self.assertIn("--label nofeedback", calls)
                self.assertIn("report.py", calls)
                self.assertEqual("--label learned" in calls, promoted)
                self.assertEqual("--arm workspace-B" in calls, promoted)


if __name__ == "__main__":
    unittest.main()
