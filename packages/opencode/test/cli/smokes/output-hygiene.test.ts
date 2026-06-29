// Artifact-level regression guards for the class of bugs that slipped past code review, unit tests,
// and CI during the v1.17.9 merge — bugs that only surface when the REAL entrypoint runs, not in any
// isolated module. See .github/meta/night-run/RETROSPECTIVE-missed-bugs.md.
//
// These spawn the actual CLI entrypoint (index.ts) and assert on its observable output, the way a
// human running the binary would experience it.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("CLI output hygiene (entrypoint regression guards)", () => {
  // GUARD: TUI log-flood (the v1.17.9 regression that made the TUI unusable). The TUI runs the
  // server in-process, so any stray stderr logging corrupts the render. The fork log shim must be
  // QUIET by default and only print on --print-logs. `skill list` exercises plenty of shared init
  // (telemetry/plugin/mcp/bus) that historically logged on every run — assert none reaches the
  // terminal by default. Also guards the InstanceRef regression (skill list threw "InstanceRef not
  // provided" when bootstrap provided the instance on the wrong ALS).
  cliIt.live(
    "skill list is quiet by default and does not throw InstanceRef",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["skill", "list"])
        opencode.expectExit(r, 0, "skill list")
        expect(r.stdout).toContain("SKILL")
        const combined = r.stdout + r.stderr
        // No structured log lines should reach the terminal without --print-logs.
        expect(combined).not.toContain("service=")
        expect(combined).not.toContain("[INFO]")
        // The InstanceRef ALS regression surfaced exactly this string.
        expect(combined).not.toContain("InstanceRef not provided")
        // Broader stray-output class that recurs on every upstream merge — any in-process library
        // writing to the console corrupts the TUI. These patterns must never reach the terminal:
        //   - third-party Winston/JSON logs (e.g. snowflake-sdk: {"level":"INFO","message":...})
        //   - snowflake-sdk's own "Configuring logger with level: ..." line
        //   - the branch-build upgrade 404 spam
        expect(combined).not.toMatch(/\{"level":\s*"(INFO|DEBUG|WARN|ERROR)"/)
        expect(combined).not.toContain("Configuring logger with level")
        expect(combined).not.toContain("[upgrade] failed to fetch latest version")
      }),
    60_000,
  )

  // GUARD: the --print-logs opt-in must keep working — otherwise the only way to debug is gone, and
  // a future "quiet" change could silently disable it. With --print-logs, structured logs must reach
  // stderr.
  cliIt.live(
    "skill list --print-logs streams structured logs to stderr (opt-in intact)",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["skill", "list", "--print-logs"])
        opencode.expectExit(r, 0, "skill list --print-logs")
        expect(r.stderr).toContain("service=")
      }),
    60_000,
  )

  // GUARD: fresh-install DB migration crash (the v1.17.9 ship-blocker surfaced by running ADE-bench
  // on a truly fresh data dir). The legacy storage DB (storage/db.ts) adopted the core-owned schema
  // ONLY when OPENCODE_TEST_CORE_DB_OWNER=1 — which preload.ts sets globally, so EVERY test passed —
  // while a real fresh install fell through to migrate() and crashed on
  // `ALTER TABLE session ADD metadata` (core already created that column), which killed /provider so
  // NO model resolved (run/agent/serve unusable). The fix detects core-ownership in production (the
  // shared-file `migration` table + `session` table). Unset the flag to exercise the production path
  // on a fresh DB; the bug signature must never reappear, and adoption must fire.
  cliIt.live(
    "fresh-DB production path adopts the core schema (no session-metadata migration crash)",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["run", "--model", "anthropic/claude-opus-4-8", "--print-logs", "hi"], {
          env: { OPENCODE_TEST_CORE_DB_OWNER: "" },
        })
        const combined = r.stdout + r.stderr
        // The exact failure signature — a fresh install hit this and could not resolve any model.
        expect(combined).not.toContain("ALTER TABLE `session` ADD `metadata`")
        expect(combined).not.toContain("DrizzleError")
        // The production adoption path (the fix) must fire on a fresh core-owned DB.
        expect(combined).toContain("adopting core-owned database schema")
      }),
    90_000,
  )
})
