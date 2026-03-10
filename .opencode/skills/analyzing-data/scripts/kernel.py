"""Jupyter kernel manager for executing Python code with persistent state."""

import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from jupyter_client import KernelManager as JupyterKernelManager
from jupyter_client import BlockingKernelClient

from config import get_kernel_venv_dir, get_kernel_connection_file

DEFAULT_PACKAGES = [
    "ipykernel",
    "jupyter_client",
    "polars",
    "pandas",
    "numpy",
    "matplotlib",
    "seaborn",
    "pyyaml",
    "python-dotenv",
]


@dataclass
class ExecutionResult:
    """Result of code execution in the kernel."""

    success: bool
    output: str
    error: str | None = None


class KernelManager:
    """Manages a Jupyter kernel for Python code execution."""

    def __init__(
        self,
        venv_dir: Path | None = None,
        kernel_name: str = "astro-ai-kernel",
        packages: list[str] | None = None,
    ):
        self.venv_dir = venv_dir or get_kernel_venv_dir()
        self.kernel_name = kernel_name
        self.packages = packages or DEFAULT_PACKAGES.copy()
        self.connection_file = get_kernel_connection_file()
        self._km: JupyterKernelManager | None = None

    @property
    def python_path(self) -> Path:
        if sys.platform == "win32":
            return self.venv_dir / "Scripts" / "python.exe"
        return self.venv_dir / "bin" / "python"

    @property
    def is_running(self) -> bool:
        if not self.connection_file.exists():
            return False
        try:
            kc = BlockingKernelClient()
            kc.load_connection_file(str(self.connection_file))
            kc.start_channels()
            try:
                kc.wait_for_ready(timeout=2)
                return True
            except Exception:
                return False
            finally:
                kc.stop_channels()
        except Exception:
            return False

    def ensure_environment(self, extra_packages: list[str] | None = None) -> None:
        if not shutil.which("uv"):
            raise RuntimeError(
                "uv is not installed.\n"
                "Install with: curl -LsSf https://astral.sh/uv/install.sh | sh"
            )

        packages = self.packages.copy()
        if extra_packages:
            packages.extend(extra_packages)

        if not self.venv_dir.exists():
            print(f"Creating environment at {self.venv_dir}")
            subprocess.run(
                ["uv", "venv", str(self.venv_dir), "--seed"],
                check=True,
                capture_output=True,
            )

        print("Installing packages...")
        subprocess.run(
            ["uv", "pip", "install", "--python", str(self.python_path)] + packages,
            check=True,
            capture_output=True,
        )

        # Register kernel
        try:
            subprocess.run(
                [
                    str(self.python_path),
                    "-m",
                    "ipykernel",
                    "install",
                    "--user",
                    "--name",
                    self.kernel_name,
                    "--display-name",
                    "Data Analysis Kernel",
                ],
                capture_output=True,
                timeout=30,
            )
        except Exception:
            pass

    def start(
        self,
        env_vars: dict[str, str] | None = None,
        extra_packages: list[str] | None = None,
    ) -> None:
        if self.is_running:
            print("Kernel already running")
            return

        self.ensure_environment(extra_packages=extra_packages)
        print("Starting kernel...")

        self._km = JupyterKernelManager(kernel_name=self.kernel_name)

        if env_vars:
            import os

            for key, value in env_vars.items():
                os.environ[key] = value

        self._km.start_kernel(extra_arguments=["--IPKernelApp.parent_handle=0"])

        self.connection_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(self._km.connection_file, self.connection_file)

        kc = self._km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=10)
        except Exception as e:
            self.stop()
            raise RuntimeError(f"Kernel failed: {e}") from e
        finally:
            kc.stop_channels()

        # Inject idle timeout watchdog into the kernel
        self._km.client().execute(
            "import threading, time, os, signal\n"
            "_idle_timeout = 1800\n"  # 30 minutes
            "_last_active = [time.time()]\n"
            "_orig_execute = get_ipython().run_cell\n"
            "def _tracked_execute(*a, **kw):\n"
            "    _last_active[0] = time.time()\n"
            "    return _orig_execute(*a, **kw)\n"
            "get_ipython().run_cell = _tracked_execute\n"
            "def _idle_watchdog():\n"
            "    while True:\n"
            "        time.sleep(60)\n"
            "        if time.time() - _last_active[0] > _idle_timeout:\n"
            "            os._exit(0)\n"
            "_t = threading.Thread(target=_idle_watchdog, daemon=True)\n"
            "_t.start()\n",
            silent=True,
        )

        self._km = None
        print(f"Kernel started ({self.connection_file})")

    def stop(self) -> None:
        if not self.connection_file.exists():
            print("Kernel not running")
            return

        try:
            kc = BlockingKernelClient()
            kc.load_connection_file(str(self.connection_file))
            kc.start_channels()
            kc.shutdown()
            kc.stop_channels()
        except Exception:
            pass

        if self.connection_file.exists():
            self.connection_file.unlink()
        print('{"message": "Kernel stopped"}')

    def execute(self, code: str, timeout: float = 30.0) -> ExecutionResult:
        if not self.connection_file.exists():
            return ExecutionResult(
                False, "", "Kernel not running. Start with: uv run scripts/cli.py start"
            )

        kc = BlockingKernelClient()
        kc.load_connection_file(str(self.connection_file))
        kc.start_channels()

        try:
            kc.wait_for_ready(timeout=5)
        except Exception as e:
            kc.stop_channels()
            return ExecutionResult(False, "", f"Kernel not responding: {e}")

        msg_id = kc.execute(code, silent=False, store_history=True)

        output_parts: list[str] = []
        error_msg: str | None = None
        status = "ok"
        deadline = time.time() + timeout
        done = False

        while time.time() < deadline and not done:
            try:
                msg = kc.get_iopub_msg(timeout=min(1.0, deadline - time.time()))
                if msg["parent_header"].get("msg_id") != msg_id:
                    continue

                msg_type = msg["msg_type"]
                content = msg["content"]

                if msg_type == "stream":
                    output_parts.append(content["text"])
                elif msg_type == "execute_result":
                    output_parts.append(content["data"].get("text/plain", ""))
                elif msg_type == "error":
                    error_msg = "\n".join(content["traceback"])
                    status = "error"
                elif msg_type == "status" and content["execution_state"] == "idle":
                    done = True
            except Exception:
                continue

        kc.stop_channels()

        if not done:
            return ExecutionResult(
                False, "".join(output_parts), f"Timeout after {timeout}s"
            )

        return ExecutionResult(status == "ok", "".join(output_parts), error_msg)

    def status(self) -> dict:
        info = {
            "running": False,
            "connection_file": str(self.connection_file),
            "responsive": False,
        }
        if not self.connection_file.exists():
            return info
        info["running"] = True
        try:
            kc = BlockingKernelClient()
            kc.load_connection_file(str(self.connection_file))
            kc.start_channels()
            try:
                kc.wait_for_ready(timeout=2)
                info["responsive"] = True
            except Exception:
                pass
            finally:
                kc.stop_channels()
        except Exception:
            pass
        return info

    def install_packages(self, packages: list[str]) -> tuple[bool, str]:
        """Install additional packages into the kernel environment.

        Args:
            packages: List of package specs (e.g., ['plotly>=5.0', 'scipy'])

        Returns:
            Tuple of (success, message)
        """
        if not packages:
            return False, "No packages specified"

        if not shutil.which("uv"):
            return False, "uv is not installed"

        try:
            result = subprocess.run(
                ["uv", "pip", "install", "--python", str(self.python_path)] + packages,
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                return True, f"Installed: {', '.join(packages)}"
            else:
                return False, f"Failed: {result.stderr}"
        except Exception as e:
            return False, f"Error: {e}"
