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
    def test_run_arms_rejects_symlinked_directories_before_python(self):
        for linked in ("runs", "run"):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                harness = root / "harness"
                harness.mkdir()
                target = root / "target"
                target.mkdir()
                marker = target / "sentinel"
                marker.write_text("unchanged")
                for name in ("run_arms.sh", "shell_common.sh"):
                    shutil.copyfile(HERE.parent / name, harness / name)
                if linked == "runs":
                    (target / "example").mkdir()
                    (harness / "runs").symlink_to(target, target_is_directory=True)
                else:
                    (harness / "runs").mkdir()
                    (harness / "runs/example").symlink_to(target, target_is_directory=True)
                shim = root / "bin"
                shim.mkdir()
                stub = shim / "python3"
                stub.write_text('#!/bin/bash\necho called >> "$STUB_LOG"\n')
                stub.chmod(0o755)
                log = root / "calls"
                env = dict(os.environ, PATH=str(shim) + os.pathsep + os.environ["PATH"],
                           BACKEND="fake", STUB_LOG=str(log))
                proc = subprocess.run(["bash", str(harness / "run_arms.sh"), "example"],
                                      env=env, capture_output=True, text=True)
                self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
                self.assertIn("real directory", proc.stderr)
                self.assertFalse(log.exists())
                self.assertEqual(marker.read_text(), "unchanged")

    def test_drift_runner_selects_eval_only_after_existing_loop(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            harness = root / "harness"
            (harness / "v1bench").mkdir(parents=True)
            shutil.copyfile(HERE.parent / "v1bench/run_all_v1.sh", harness / "v1bench/run_all_v1.sh")
            run = root / "out/v1-drift-strong"
            run.mkdir(parents=True)
            (run / "loop.jsonl").write_text('{"type":"final"}\n')
            shim = root / "bin"
            shim.mkdir()
            stub = shim / "python3"
            stub.write_text('#!/bin/bash\n'
                            '[[ "$1" != *check_output.py ]] || exit 1\n'
                            'echo "$*" >> "$STUB_LOG"\n')
            stub.chmod(0o755)
            log = root / "calls"
            env = dict(os.environ, PATH=str(shim) + os.pathsep + os.environ["PATH"],
                       ITEMS="6", RD=str(root / "out"), STUB_LOG=str(log))
            proc = subprocess.run(["bash", str(harness / "v1bench/run_all_v1.sh")],
                                  env=env, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            calls = [line for line in log.read_text().splitlines() if "drift_v1.py" in line]
            self.assertEqual(len(calls), 2)
            self.assertIn("--eval-only", calls[0])
            self.assertNotIn("--eval-only", calls[1])

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
