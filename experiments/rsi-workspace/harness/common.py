#!/usr/bin/env python3
"""Shared pieces of the RSI experiment harness (Python 3 stdlib only).

Users: each of A (maintainer) and B (teammate) gets an isolated HOME/XDG tree under
runs/<run_id>/home-<u>, a ~/.altimate/altimate.json pointing at the fake backend, and a global
config denying external_directory so the agent cannot read the verifier (it lives in the repo,
outside every workdir).

Task runner: prepare workdir -> optionally install a playbook SKILL.md -> `run --format json` ->
parse events -> hidden verifier -> record (see run_task).
"""
import glob
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

HARNESS = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.dirname(HARNESS)                       # experiments/rsi-workspace
REPO = os.path.abspath(os.path.join(EXP, "..", ".."))  # the worktree root
DEMO = os.path.join(EXP, "demo")
VERIFIER = os.path.join(DEMO, "verifier")
FAKE_BACKEND = os.path.join(EXP, "fake-backend", "server.ts")
RUNS = os.path.join(HARNESS, "runs")

ALTIMATE_CMD = os.environ.get(
    "ALTIMATE_CMD",
    f"bun run --conditions=browser {REPO}/packages/opencode/src/index.ts",
)
DBT_BIN = os.environ.get(
    "DBT_BIN",
    "/private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/"
    "5e228db8-69ac-4824-86f1-4a9ad4ff2e5c/scratchpad/dbtenv/bin/dbt",
)
AGENT_MODEL = os.environ.get("AGENT_MODEL", "google-vertex-anthropic/claude-haiku-4-5@20251001")
REFLECTOR_MODEL = os.environ.get("REFLECTOR_MODEL", "google-vertex-anthropic/claude-sonnet-4-6@default")
# Must be the URL the prepared workdirs use as `origin` (demo/prepare_workdir.py) so that
# the fake backend's seeded binding is found by remote.
REMOTE = "git@github.com:acme/acme-shop.git"
PLAYBOOK_NAME = "team-playbook"
PLAYBOOK_DESCRIPTION = (
    "Conventions this team's CI and reviewers enforce, learned from past sessions. Apply them to related work."
)
AGENT_TIMEOUT = int(os.environ.get("AGENT_TIMEOUT", "600"))
MAX_TURNS = 40
USERS = {"a": "token-user-a", "b": "token-user-b"}  # user -> fake-backend token (SaaS uses the real credentials)
SAAS_CREDS_DIR = os.environ.get(
    "SAAS_CREDS_DIR",
    "/private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/5e228db8-69ac-4824-86f1-4a9ad4ff2e5c/scratchpad/saas",
)

_log_lock = threading.Lock()
_spawn_lock = threading.Lock()
STAGGER_SECONDS = float(os.environ.get("STAGGER_SECONDS", "3"))


def log(*a):
    with _log_lock:
        print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def sha(text):
    return hashlib.sha256((text or "").encode()).hexdigest()[:12]


def new_run_id():
    return time.strftime("%Y%m%d-%H%M%S")


def run_dir_for(run_dir=None, run_id=None):
    d = os.path.abspath(run_dir) if run_dir else os.path.join(RUNS, run_id or new_run_id())
    os.makedirs(d, exist_ok=True)
    return d


_jsonl_lock = threading.Lock()


def append_jsonl(path, rec):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with _jsonl_lock, open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")


def read_jsonl(path):
    if not os.path.isfile(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]


# ---------------------------------------------------------------- tasks

def load_tasks():
    tasks = {}
    for f in sorted(glob.glob(os.path.join(VERIFIER, "tasks", "*.json"))):
        t = json.load(open(f))
        tasks[t["id"]] = t
    return tasks


def select_tasks(splits, limit=None, only=None):
    """Tasks of the given splits (ordered by id); `limit` applies per split."""
    out = []
    for s in splits:
        ts = [t for t in load_tasks().values() if t["split"] == s and (not only or t["id"] in only)]
        out += ts[:limit] if limit else ts
    return out


# ---------------------------------------------------------------- playbooks

def wrap_skill(body, name=PLAYBOOK_NAME):
    """A SKILL.md the way `learn` writes it (applyPaths on dbt_project.yml)."""
    return (
        f'---\nname: {name}\ndescription: {json.dumps(PLAYBOOK_DESCRIPTION)}\n'
        f'applyPaths: ["dbt_project.yml"]\n---\n{body.strip()}\n'
    )


def gold_playbook():
    return wrap_skill(open(os.path.join(VERIFIER, "gold_playbook.md")).read())


def skill_path(root, name=PLAYBOOK_NAME):
    return os.path.join(root, ".altimate-code", "skills", name, "SKILL.md")


def install_playbook(workdir, text):
    p = skill_path(workdir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(text)


# ---------------------------------------------------------------- users / env

def setup_users(run_dir, port=None):
    """Create both users' isolated homes. Safe to call repeatedly.

    port=None: SaaS mode, the real credentials are copied (mode 600, never printed) from SAAS_CREDS_DIR/home-<u>.
    port=N: fake-backend mode, credentials point at the local fake server."""
    for u, token in USERS.items():
        home = os.path.join(run_dir, f"home-{u}")
        os.makedirs(os.path.join(home, ".altimate"), exist_ok=True)
        dest = os.path.join(home, ".altimate", "altimate.json")
        if port is None:
            src = os.path.join(SAAS_CREDS_DIR, f"home-{u}", ".altimate", "altimate.json")
            if not os.path.isfile(src):
                raise SystemExit(f"SaaS credentials for user {u} not found at {src} (set SAAS_CREDS_DIR)")
            shutil.copyfile(src, dest)
        else:
            json.dump(
                {"altimateUrl": f"http://127.0.0.1:{port}", "altimateInstanceName": "demo", "altimateApiKey": token},
                open(dest, "w"),
            )
        os.chmod(dest, 0o600)
        # global config: $XDG_CONFIG_HOME/altimate-code/altimate-code.json (src/config/config.ts, Global.Path.config)
        cfg = os.path.join(home, ".config", "altimate-code")
        os.makedirs(cfg, exist_ok=True)
        json.dump(
            {"$schema": "https://altimate.ai/config.json", "permission": {"external_directory": "deny"}},
            open(os.path.join(cfg, "altimate-code.json"), "w"),
        )


def user_env(run_dir, user, workspace=False):
    """Environment for `user` (a|b). ALTIMATE_WORKSPACE only when `workspace` is set."""
    home = os.path.join(run_dir, f"home-{user}")
    env = dict(os.environ)
    for k in ("ALTIMATE_WORKSPACE", "OPENCODE_TEST_HOME"):
        env.pop(k, None)
    env.update(
        HOME=home,
        XDG_DATA_HOME=f"{home}/.local/share",
        XDG_CONFIG_HOME=f"{home}/.config",
        XDG_CACHE_HOME=f"{home}/.cache",
        XDG_STATE_HOME=f"{home}/.local/state",
        DBT_BIN=DBT_BIN,
        DBT_SEND_ANONYMOUS_USAGE_STATS="false",
        DO_NOT_TRACK="1",
        PATH=os.path.dirname(DBT_BIN) + os.pathsep + env.get("PATH", ""),
    )
    if workspace:
        env["ALTIMATE_WORKSPACE"] = "1"
    return env


def warm_users(run_dir):
    """Create each home's data dir/DB once, serially, so parallel runs do not race on migrations."""
    for u in USERS:
        subprocess.run(shlex.split(ALTIMATE_CMD) + ["--version"], env=user_env(run_dir, u),
                       capture_output=True, text=True, timeout=120, cwd=run_dir)


def altimate(args, cwd, env, timeout=300, stdin=None):
    return subprocess.run(shlex.split(ALTIMATE_CMD) + list(args), cwd=cwd, env=env, capture_output=True,
                          text=True, timeout=timeout, input=stdin)


def resolve_models(run_dir, agent=AGENT_MODEL, reflector=REFLECTOR_MODEL):
    """Verify the reflector model exists via `models`; fall back to the agent model."""
    p = altimate(["models"], run_dir, user_env(run_dir, "a"), timeout=180)
    listed = set(p.stdout.split())
    if agent not in listed:
        log(f"WARNING agent model {agent} not in `models`")
    if reflector not in listed:
        log(f"WARNING reflector model {reflector} missing from `models`; falling back to {agent}")
        reflector = agent
    return agent, reflector


# ---------------------------------------------------------------- fake backend

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Backend:
    """The workspace backend the users talk to.

    mode "saas" (default): the real Altimate SaaS; nothing is started, the users' real credentials are copied
      into their isolated homes, and `workspace_id` is the pre-created workspace bound to REMOTE.
    mode "fake": start experiments/rsi-workspace/fake-backend/server.ts seeded with a shared workspace bound to
      REMOTE. State persists in <run_dir>/backend-state.json so a later process (workspace-B eval) can start a
      backend on the same state and see what A published.

    Either way, `api(user, ...)` talks to the same HTTP contract (bindings, /skills)."""

    def __init__(self, run_dir, mode="saas", workspace_id=None):
        assert mode in ("saas", "fake")
        self.run_dir = run_dir
        self.mode = mode
        self.workspace_id = workspace_id
        self.state_file = os.path.join(run_dir, "backend-state.json")
        self.port = None
        self.proc = None

    def _creds(self, user):
        d = json.load(open(os.path.join(self.run_dir, f"home-{user}", ".altimate", "altimate.json")))
        return d["altimateUrl"].rstrip("/"), d["altimateInstanceName"], d["altimateApiKey"]

    def api(self, user, path, query=None, timeout=60):
        """GET <path> as `user` (Bearer + x-tenant, like the CLI). Returns parsed JSON; credentials never logged."""
        url, tenant, key = self._creds(user)
        qs = "?" + urllib.parse.urlencode(query) if query else ""
        req = urllib.request.Request(url + path + qs, headers={"Authorization": f"Bearer {key}", "x-tenant": tenant})
        return json.load(urllib.request.urlopen(req, timeout=timeout))

    def binding(self, user="a"):
        """GET /datamate-project-bindings/by-remote as `user`; asserts it resolves to `workspace_id` (if given)."""
        b = self.api(user, "/datamate-project-bindings/by-remote", {"repo_remote": REMOTE})
        ws_id = (b.get("binding") or {}).get("datamate_id")
        if self.workspace_id is not None and ws_id != self.workspace_id:
            raise SystemExit(f"binding for {REMOTE} resolves to workspace {ws_id}, expected {self.workspace_id}")
        self.workspace_id = ws_id
        return {"workspace_id": ws_id, "datamate_name": (b.get("binding") or {}).get("datamate_name"),
                "repo_remote": (b.get("binding") or {}).get("repo_remote")}

    def published_skill(self, user, name=PLAYBOOK_NAME):
        """The skill `name` as `user` sees it in the workspace: GET /skills?datamate_id=<ws>, then its SKILL.md."""
        found = None
        page = 1
        while page <= 20:
            r = self.api(user, "/skills", {"datamate_id": self.workspace_id, "page": page, "size": 50})
            found = next((s for s in r.get("items", []) if s.get("name") == name), None)
            if found or page >= (r.get("pages") or 1):
                break
            page += 1
        if not found:
            return {"found": False}
        pid = found["public_id"]
        content = self.api(user, f"/skills/{pid}/files/SKILL.md").get("content")
        return {"found": True, "public_id": pid, "attached_datamate_ids": found.get("attached_datamate_ids"),
                "updated_at": found.get("updated_at"), "sha": sha(content), "content": content}

    def __enter__(self):
        if self.mode == "saas":
            setup_users(self.run_dir, None)
            self.binding("a")
            log(f"SaaS backend: workspace {self.workspace_id} bound to {REMOTE}")
            return self
        self.port = free_port()
        env = dict(os.environ, PORT=str(self.port), FAKE_STATE=self.state_file, FAKE_SEED_REMOTE=REMOTE)
        self.logf = open(os.path.join(self.run_dir, "backend.log"), "a")
        self.proc = subprocess.Popen(["bun", FAKE_BACKEND], env=env, stdout=self.logf, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        for _ in range(60):
            try:
                self.state()
                break
            except Exception:
                time.sleep(0.25)
        else:
            self.__exit__()
            raise RuntimeError("fake backend did not start")
        setup_users(self.run_dir, self.port)
        self.binding("a")
        log(f"fake backend on :{self.port} (state {self.state_file})")
        return self

    def state(self):
        return json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.port}/__debug/state", timeout=5))

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=5)
            except Exception:
                os.killpg(self.proc.pid, signal.SIGKILL)
        return False


# ---------------------------------------------------------------- event parsing

def parse_events(path):
    """Parse `run --format json` output (one JSON event per line).

    Observed event types: step_start, text, tool_use (part.tool, part.state.{status,input,output}),
    step_finish (part.cost, part.tokens.{total,input,output,reasoning,cache.{read,write}}),
    termination (why_model_stopped, why_harness_stopped, done_reason), trace_saved; every event has
    top-level sessionID."""
    ev = {"session_id": None, "tool_calls": 0, "steps": 0, "cost": 0.0,
          "tokens": {"total": 0, "input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0},
          "termination": None, "errors": [], "tool_inputs": [], "tools": {}, "skill_loaded": False}
    for line in open(path, errors="replace"):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        ev["session_id"] = ev["session_id"] or e.get("sessionID")
        t = e.get("type")
        part = e.get("part") or {}
        if t == "tool_use":
            ev["tool_calls"] += 1
            tool = part.get("tool")
            ev["tools"][tool] = ev["tools"].get(tool, 0) + 1
            inp = (part.get("state") or {}).get("input")
            ev["tool_inputs"].append({"tool": tool, "input": inp})
            if tool == "skill" and PLAYBOOK_NAME in json.dumps(inp):
                ev["skill_loaded"] = True
        elif t == "step_finish":
            ev["steps"] += 1
            ev["cost"] += part.get("cost") or 0
            tk = part.get("tokens") or {}
            c = tk.get("cache") or {}
            for k in ("total", "input", "output", "reasoning"):
                ev["tokens"][k] += tk.get(k) or 0
            ev["tokens"]["cache_read"] += c.get("read") or 0
            ev["tokens"]["cache_write"] += c.get("write") or 0
        elif t == "termination":
            ev["termination"] = {k: e.get(k) for k in ("why_model_stopped", "why_harness_stopped", "done_reason")}
        elif t == "error":
            ev["errors"].append(json.dumps(e)[:300])
    return ev


def leak_scan(tool_inputs, workdir):
    """Flag any tool input naming the verifier, gold files, demo/ or the repo root (workdir path stripped,
    since the workdir itself lives under the repo)."""
    pats = {
        "verifier": re.compile(r"verifier", re.I),
        "gold": re.compile(r"\bgold\b|gold_playbook", re.I),
        "demo/": re.compile(r"(^|[\s/\"'=:])demo/"),
        "repo_root": re.compile(re.escape(REPO)),
    }
    hits = []
    for ti in tool_inputs:
        s = json.dumps(ti["input"])
        s = s.replace(workdir, "<wd>").replace(os.path.realpath(workdir), "<wd>")
        # Agents sometimes retype their own workdir path with a mangled prefix; the basename is unique per run.
        s = re.sub(r"[^\s\"'=:]*" + re.escape(os.path.basename(workdir.rstrip("/"))), "<wd>", s)
        for name, rx in pats.items():
            if rx.search(s):
                hits.append({"pattern": name, "tool": ti["tool"], "input": s[:200]})
    return hits


# ---------------------------------------------------------------- task runner

def _sub(argv, workdir):
    return [a.replace("{workdir}", workdir) for a in argv]


def check_id(name):
    return name.split("_")[0]


def run_verify(task, workdir):
    p = subprocess.run(_sub(task["verify"], workdir), cwd=DEMO, capture_output=True, text=True, timeout=300,
                       env=dict(os.environ, DBT_BIN=DBT_BIN))
    try:
        out = p.stdout[p.stdout.index("{"):]
        return json.loads(out)
    except Exception:
        return {"task_id": task["id"], "pass": False, "score": 0.0, "checks": [],
                "error": f"verifier output unparsable (rc={p.returncode}): {(p.stdout + p.stderr)[-300:]}"}


def playbook_in_trace(trace_text, name=None):
    """True when the session's system prompt carried the auto-loaded playbook skill.

    Matches the harness's own wrapper (`<auto_loaded_skill name="team-playbook">`, JSON-escaped in the trace)
    rather than a body line: body lines contain non-ASCII (e.g. an arrow) that json.dumps escapes differently
    from the trace, which made an earlier body-line probe report False for every run."""
    return f'auto_loaded_skill name=\\"{name or PLAYBOOK_NAME}\\"' in trace_text


def workspace_skills(workdir):
    out = []
    for p in sorted(glob.glob(os.path.join(workdir, ".altimate-code", "skill", "_workspace", "*", "SKILL.md"))):
        out.append({"path": os.path.relpath(p, workdir), "sha": sha(open(p).read())})
    return out


def run_task(spec):
    """spec: run_dir, task (dict), arm, user (a|b), run_idx, playbook (text|None), workspace (bool),
    model, tag, export_traj (bool), agent_timeout.  Returns the run record."""
    run_dir, task = spec["run_dir"], spec["task"]
    user, arm = spec.get("user", "a"), spec["arm"]
    tag = spec.get("tag", "")
    name = f"{tag}{task['id']}.{arm.replace(':', '-').replace('/', '_')}.{user}.{spec.get('run_idx', 0)}.{uuid.uuid4().hex[:6]}"
    workdir = os.path.join(run_dir, "work", name)
    logdir = os.path.join(run_dir, "logs")
    os.makedirs(logdir, exist_ok=True)
    os.makedirs(os.path.dirname(workdir), exist_ok=True)
    rec = {"task": task["id"], "split": task["split"], "arm": arm, "user": user, "run_idx": spec.get("run_idx", 0),
           "playbook_sha": sha(spec["playbook"]) if spec.get("playbook") else None,
           "workspace": bool(spec.get("workspace")), "workdir": workdir, "model": spec.get("model", AGENT_MODEL),
           "tag": tag}
    p = subprocess.run(_sub(task["setup"], workdir), cwd=DEMO, capture_output=True, text=True, timeout=300,
                       env=dict(os.environ, DBT_BIN=DBT_BIN))
    if p.returncode != 0:
        rec.update({"pass": False}, score=0.0, checks={}, error="setup failed: " + (p.stdout + p.stderr)[-300:])
        return rec
    if spec.get("playbook"):
        install_playbook(workdir, spec["playbook"])

    env = user_env(run_dir, user, workspace=spec.get("workspace", False))
    env.update(spec.get("env_extra") or {})  # e.g. ALTIMATE_LEARN_CAPTURE=1 for the corrections loop
    events_path = os.path.join(logdir, name + ".events.jsonl")
    cmd = shlex.split(ALTIMATE_CMD) + ["run", "--format", "json", "-m", rec["model"], "--max-turns", str(MAX_TURNS),
                                       "--yolo", task["prompt"]]
    t0 = time.time()
    timed_out = False
    # Concurrent runs of one user share that user's sqlite DB: process start-up (migration check) can fail with
    # "database is locked". Stagger starts, and retry a start-up failure (no events at all) a few times.
    for attempt in range(4):
        with open(events_path, "w") as so, open(os.path.join(logdir, name + ".stderr.txt"), "w") as se:
            with _spawn_lock:
                proc = subprocess.Popen(cmd, cwd=workdir, env=env, stdout=so, stderr=se, stdin=subprocess.DEVNULL,
                                        start_new_session=True)
                time.sleep(STAGGER_SECONDS)
            try:
                proc.wait(timeout=spec.get("agent_timeout", AGENT_TIMEOUT))
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        startup_failure = (not timed_out and proc.returncode != 0 and os.path.getsize(events_path) < 200
                           and "database is locked" in open(os.path.join(logdir, name + ".stderr.txt"), errors="replace").read())
        if not startup_failure:
            break
        log(f"{task['id']}: start-up 'database is locked', retry {attempt + 1}")
        time.sleep(3 + 3 * attempt)
    dur = time.time() - t0
    ev = parse_events(events_path)

    verify = run_verify(task, workdir)
    checks = {check_id(c["name"]): bool(c["ok"]) for c in verify.get("checks", [])}
    hits = leak_scan(ev["tool_inputs"], workdir)
    rec.update({
        "pass": bool(verify.get("pass")), "score": verify.get("score", 0.0), "checks": checks,
        "tokens": ev["tokens"], "cost": round(ev["cost"], 5), "tool_calls": ev["tool_calls"], "steps": ev["steps"],
        "duration": round(dur, 1), "session_id": ev["session_id"], "termination": ev["termination"],
        "timed_out": timed_out, "agent_rc": proc.returncode, "errors": ev["errors"][:3],
        "skill_loaded": ev["skill_loaded"], "tools": ev["tools"],
        "leak": bool(hits), "leak_hits": hits[:5], "events": os.path.relpath(events_path, run_dir),
        "verify": verify,
    })
    probe = spec.get("playbook")
    if spec.get("workspace"):
        rec["ws_skills"] = workspace_skills(workdir)
        rec["ws_arrived"] = bool(rec["ws_skills"])
        if rec["ws_skills"]:
            probe = open(os.path.join(workdir, rec["ws_skills"][0]["path"])).read()
    # Evidence the playbook reached the model: applyPaths skills are auto-loaded into the system prompt (not via
    # the skill tool), so look for a distinctive body line of it in the session trace.
    rec["playbook_in_context"] = None
    if probe and ev["session_id"]:
        body = [l for l in probe.split("---", 2)[-1].splitlines() if len(l.strip()) > 30 and not l.startswith("<!--")]
        tr = os.path.join(env["XDG_DATA_HOME"], "altimate-code", "traces", ev["session_id"] + ".json")
        if body and os.path.isfile(tr):
            rec["playbook_in_context"] = playbook_in_trace(open(tr, errors="replace").read())
    rec["trace_path"] = os.path.join(env["XDG_DATA_HOME"], "altimate-code", "traces", (ev["session_id"] or "") + ".json")
    log(f"{task['id']:26} {arm:18} u={user} #{rec['run_idx']} pass={rec['pass']} score={rec['score']:.2f} "
        f"checks={''.join(k[1] if v else '-' for k, v in sorted(checks.items()))} {rec['duration']:.0f}s "
        f"tools={rec['tool_calls']} ${rec['cost']:.3f}{' LEAK' if rec['leak'] else ''}{' TIMEOUT' if timed_out else ''}")
    return rec


def run_many(specs, parallel=4, on_done=None):
    """Run specs on a thread pool; results keep the order of `specs`."""
    def one(s):
        try:
            r = run_task(s)
        except Exception as e:  # keep the experiment going; the failure is a recorded run
            r = {"task": s["task"]["id"], "split": s["task"]["split"], "arm": s["arm"], "user": s.get("user", "a"),
                 "run_idx": s.get("run_idx", 0), "pass": False, "score": 0.0, "checks": {}, "error": repr(e),
                 "leak": False}
            log("run failed:", repr(e))
        if on_done:
            on_done(r)
        return r
    with ThreadPoolExecutor(max_workers=max(1, parallel)) as ex:
        return list(ex.map(one, specs))


def total_checks(recs):
    return sum(sum(1 for v in r.get("checks", {}).values() if v) for r in recs)
