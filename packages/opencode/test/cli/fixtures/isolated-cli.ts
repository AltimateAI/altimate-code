// altimate_change start — upstream_fix (#701/#878): one copy of the subprocess harness.
// This was duplicated verbatim between the MCP diagnostics CLI tests. The duplication was not
// cosmetic: the copies each carried the `bun run --cwd` bug fixed below, so a fix in one file
// silently left the other reading the repo's own config instead of the temp project.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { spawnSync } from "child_process"

/** Each test boots the real CLI in a subprocess; the default 5s budget is not enough. */
export const SUBPROCESS_TIMEOUT_MS = 120_000

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..", "..")
const opencodeDir = path.join(repoRoot, "packages", "opencode")
const cliEntry = path.join(opencodeDir, "src", "index.ts")

/**
 * Run the real CLI against a throwaway project with an isolated HOME.
 *
 * `fn` receives an `output(args)` helper returning stdout+stderr combined.
 */
export function withIsolatedCli(
  mcp: Record<string, unknown>,
  fn: (output: (args: string[]) => string) => void,
  extraFiles: Record<string, string> = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "altimate-mcp-status-"))
  const home = path.join(root, "home")
  const configHome = path.join(root, "config")
  const configDir = path.join(configHome, "altimate-code")
  mkdirSync(home, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path.join(configDir, "altimate-code.json"), JSON.stringify({ mcp }), "utf-8")
  for (const [rel, content] of Object.entries(extraFiles)) {
    const target = path.join(root, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, "utf-8")
  }

  const run = (args: string[]) =>
    // `bun run --cwd <pkg>` would make the CLI's working directory the repo package, so it would
    // read the repo's own .opencode config and never see this temp project. Spawn cwd is the
    // project instead; module resolution still follows cliEntry's location.
    spawnSync("bun", ["--conditions=browser", cliEntry, ...args], {
      cwd: root,
      encoding: "utf-8",
      timeout: 90_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_DISABLE_TELEMETRY: "1",
        OPENCODE_DISABLE_SHARE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_AUTOCOMPACT: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_PURE: "1",
        TERM: "dumb",
        CI: "1",
      },
    })

  const output = (args: string[]) => {
    const r = run(args)
    // spawnSync does NOT throw on ENOENT or timeout — it returns `{ status: null, error }` and
    // leaves stdout null. Without this the caller compares against "" and the failure reads as
    // "expected '' to contain 'broken'", sending whoever debugs it after a test-logic bug that
    // does not exist. Say plainly that the subprocess never ran.
    if (r.error || r.status === null) {
      const why = r.error ? `${r.error.name}: ${r.error.message}` : "killed or timed out"
      throw new Error(
        `CLI subprocess did not complete (${why}). args=${JSON.stringify(args)} signal=${r.signal ?? "none"}`,
      )
    }
    return String(r.stdout ?? "") + String(r.stderr ?? "")
  }

  try {
    fn(output)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
// altimate_change end
