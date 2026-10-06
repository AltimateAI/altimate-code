#!/usr/bin/env python3
"""Free API-handler regression checks. Requires Bun; no socket, model, or SaaS."""
import json
import os
from pathlib import Path
import select
import shlex
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode


WORKER = r'''
const { serverOptions } = await import(process.env.FAKE_SERVER_PATH)
console.log("RESULT " + JSON.stringify({hostname: serverOptions.hostname}))
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let end
  while ((end = buffer.indexOf("\n")) !== -1) {
    const {method, path, headers, payload} = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    const req = new Request("http://127.0.0.1" + path, {
      method, headers, ...(payload === null ? {} : {body: JSON.stringify(payload)}),
    })
    const res = await serverOptions.fetch(req)
    console.log("RESULT " + JSON.stringify({status: res.status, body: await res.text()}))
  }
}
'''


def receive_result(proc, pending, timeout=10):
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            proc.kill()
            proc.wait(timeout=5)
            raise AssertionError("Backend test worker response timed out")
        if b"\n" in pending:
            line, _, rest = pending.partition(b"\n")
            pending[:] = rest
            if line.startswith(b"RESULT "):
                return json.loads(line[len(b"RESULT "):])
            continue
        if not select.select([proc.stdout], [], [], remaining)[0]:
            continue
        chunk = os.read(proc.stdout.fileno(), 65536)
        if not chunk:
            raise AssertionError("Backend test worker exited unexpectedly")
        pending.extend(chunk)


def response_deadline():
    for prefix in ("", "RESULT "):
        proc = subprocess.Popen(
            [sys.executable, "-u", "-c",
             f"import sys, time; sys.stdout.write({prefix!r}); sys.stdout.flush(); time.sleep(60)"],
            stdout=subprocess.PIPE)
        try:
            try:
                receive_result(proc, bytearray(), timeout=0.1)
                raise AssertionError("Stalled worker unexpectedly returned a response")
            except AssertionError as exc:
                assert str(exc) == "Backend test worker response timed out", exc
            assert proc.poll() is not None
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            proc.stdout.close()


def demo_isolation():
    """Exercise run_as without starting the demo server or calling a model."""
    script = Path(__file__).with_name("demo.sh").read_text()
    run_as = "run_as() {" + script.split("run_as() {", 1)[1].split("\n}", 1)[0] + "\n}"
    with tempfile.TemporaryDirectory(prefix="rsi-demo-isolation-") as scratch:
        for user in ("a", "b"):
            (Path(scratch) / f"repo-{user}").mkdir()
        keys = ["HOME", "OPENCODE_TEST_HOME", "XDG_STATE_HOME", "OPENCODE_TEST_STATE_HOME"]
        probe = "import json, os; print(json.dumps({key: os.environ[key] for key in " + repr(keys) + "}))"
        env = dict(os.environ, S=scratch, PKG="unused", OPENCODE_TEST_HOME="/inherited-home",
                   OPENCODE_TEST_STATE_HOME="/inherited-state",
                   ALTIMATE_CMD=shlex.join([sys.executable, "-c", probe]))
        result = subprocess.run(["bash", "-c", run_as + "\nrun_as a\nrun_as b\n"],
                                env=env, capture_output=True, text=True, check=True)
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        assert len(rows) == 2, rows
        for user, row in zip(("a", "b"), rows):
            home = str(Path(scratch) / f"home-{user}")
            assert row == {"HOME": home, "OPENCODE_TEST_HOME": home,
                           "XDG_STATE_HOME": home + "/.local/state",
                           "OPENCODE_TEST_STATE_HOME": home + "/.local/state"}, row


def exercise(debug):
    with tempfile.TemporaryDirectory(prefix="rsi-fake-backend-") as scratch:
        env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}
        env.update(FAKE_STATE=str(Path(scratch) / "state.json"),
                   FAKE_SERVER_PATH=str(Path(__file__).resolve().with_name("server.ts")))
        if debug:
            env["FAKE_DEBUG_TOKEN"] = "selftest-admin-only"
        proc = subprocess.Popen(["bun", "-e", WORKER], env=env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        pending = bytearray()

        def receive():
            return receive_result(proc, pending)

        def call(method, path, payload=None, token="token-user-a", tenant="demo", status=200):
            headers = {"x-tenant": tenant}
            if token is not None:
                headers["Authorization"] = "Bearer " + token
            proc.stdin.write(json.dumps(dict(method=method, path=path, headers=headers, payload=payload)) + "\n")
            proc.stdin.flush()
            res = receive()
            assert res["status"] == status, (method, path, res, status)
            return json.loads(res["body"]) if res["body"] else None

        try:
            assert receive()["hostname"] == "127.0.0.1"
            call("GET", "/users/me")
            call("GET", "/users/me", token=None, status=401)
            call("GET", "/users/me", token="__proto__", status=401)
            call("GET", "/users/me", token="constructor", status=401)
            call("GET", "/users/me", tenant="other", status=403)
            for method, path in [("GET", "/__debug/state"), ("POST", "/__debug/reset")]:
                call(method, path, token=None, status=401 if debug else 404)
                call(method, path, token="token-user-b", status=401 if debug else 404)
                call(method, path, token="selftest-admin-only", tenant="other", status=403 if debug else 404)
            if not debug:
                call("GET", "/__debug/state", token="selftest-admin-only", status=404)
                return

            def workspace(name, owner="token-user-a", privacy="private"):
                return call("POST", "/datamates", {"name": name, "privacy": privacy},
                            token=owner)["id"]

            target_a = workspace("target-a")
            target_b = workspace("target-b", "token-user-b")
            before_invalid = call("GET", "/__debug/state", token="selftest-admin-only")
            for endpoint in ("/datamate-project-bindings", "/datamate-project-bindings/bind"):
                for invalid in ("", " ", 0, False, {}, []):
                    for key, other, valid in (("project_path", "repo_remote", "https://example.test/valid.git"),
                                              ("repo_remote", "project_path", "/example/valid")):
                        call("POST", endpoint,
                             {"name": "invalid-identifiers", "datamate_id": target_a, key: invalid, other: valid},
                             status=400)
                call("POST", endpoint, {"name": "missing-identifiers", "datamate_id": target_a}, status=400)
            assert call("GET", "/__debug/state", token="selftest-admin-only") == before_invalid
            for privacy in ("private", "shared"):
                for kind in ("remote", "path"):
                    ws_id = workspace(f"{privacy}-{kind}", privacy=privacy)
                    key = "repo_remote" if kind == "remote" else "project_path"
                    identifier = f"https://example.test/{privacy}.git" if kind == "remote" else f"/example/{privacy}"
                    query = urlencode({key: identifier})
                    binding = {key: identifier, "datamate_id": ws_id}
                    call("POST", "/datamate-project-bindings/bind", binding, status=201)
                    expected = 404 if privacy == "private" else 403
                    # Authorization must precede the expected-current-id check (no ID leakage).
                    call("PUT", f"/datamate-project-bindings/by-{kind}",
                         {key: identifier, "target_datamate_id": target_b, "expected_current_datamate_id": -1},
                         token="token-user-b", status=expected)
                    call("DELETE", f"/datamate-project-bindings?{query}",
                         token="token-user-b", status=expected)
                    current = call("GET", f"/datamate-project-bindings/by-{kind}?{query}")
                    assert current["binding"]["datamate_id"] == ws_id
                    conflict = call("POST", "/datamate-project-bindings",
                                    {key: identifier, "name": "must-not-create"},
                                    token="token-user-b", status=409)["detail"]
                    assert conflict["existing_datamate_id"] == ws_id
                    assert conflict["existing_datamate_name"] == (None if privacy == "private" else f"{privacy}-{kind}")
                    call("PUT", f"/datamate-project-bindings/by-{kind}",
                         {key: identifier, "target_datamate_id": target_a, "expected_current_datamate_id": -1}, status=412)
                    moved = call("PUT", f"/datamate-project-bindings/by-{kind}",
                                 {key: identifier, "target_datamate_id": target_a, "expected_current_datamate_id": ws_id})
                    assert moved["binding"]["datamate_id"] == target_a
                    call("DELETE", f"/datamate-project-bindings?{query}", status=204)

            call("DELETE", "/datamate-project-bindings", status=400)
            call("PUT", "/datamate-project-bindings/by-path", {"target_datamate_id": target_a}, status=400)
            original = call("GET", f"/datamates/{target_a}")
            patched = call("PATCH", f"/datamates/{target_a}/summary",
                           {"id": target_b, "user_id": 2, "privacy": "shared", "name": "renamed", "memory_enabled": True})
            for field in ("id", "user_id", "privacy"):
                assert patched[field] == original[field]
            assert patched["name"] == "renamed" and patched["memory_enabled"] is True
            call("PATCH", f"/datamates/{target_a}", {"memory_enabled": "yes"}, status=400)
            call("GET", f"/datamates/{target_a}", token="token-user-b", status=404)
            created = call("POST", "/datamate-project-bindings",
                           {"repo_remote": "https://example.test/new.git", "name": "new"}, status=201)
            assert created["datamate"]["user_id"] == 1

            # Legitimate shared-skill and private-memory behavior must survive the auth changes.
            shared = workspace("shared", privacy="shared")
            sk = call("POST", "/skills", {"name": "playbook", "files": [{"path": "SKILL.md", "content": "ok"}]}, status=201)["skill"]["public_id"]
            call("PUT", f"/skills/{sk}/datamates", {"datamate_ids": [shared]})
            assert call("GET", f"/skills/{sk}/files/SKILL.md", token="token-user-b")["content"] == "ok"
            call("PATCH", f"/skills/{sk}", {"name": "stolen"}, token="token-user-b", status=403)
            call("POST", "/datamates/memory", {"messages": [{"content": "private"}]})
            assert call("GET", "/datamates/memory/list", token="token-user-b") == []
            state = call("GET", "/__debug/state", token="selftest-admin-only")
            assert len(state["memories"]) == 1
            assert all(ws["name"] != "must-not-create" for ws in state["workspaces"])
            call("POST", "/__debug/reset", token="selftest-admin-only")
            reset_state = call("GET", "/__debug/state", token="selftest-admin-only")
            assert all(reset_state[key] == [] for key in ("workspaces", "bindings", "skills", "memories"))
        finally:
            proc.stdin.close()
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            proc.stdout.close()


if __name__ == "__main__":
    response_deadline()
    demo_isolation()
    exercise(False)
    exercise(True)
    print("FAKE BACKEND SELFTEST OK")
