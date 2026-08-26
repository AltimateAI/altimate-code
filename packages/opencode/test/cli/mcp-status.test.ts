// altimate_change start — upstream_fix (#790, #878): `mcp status` must exist, and a configured
// server that has drifted from the discovered config must be reported. Both are user-facing CLI
// behaviour, so this drives the real binary in an isolated HOME rather than the handler.
// The env-variable reporting these views share is covered against `mcp list` in
// test/cli/mcp-env-diagnostics.test.ts and is not duplicated here.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { spawnSync } from "child_process"

// Each test boots the real CLI in a subprocess; the default 5s budget is not enough.
const SUBPROCESS_TIMEOUT_MS = 120_000

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")
const opencodeDir = path.join(repoRoot, "packages", "opencode")
const cliEntry = path.join(opencodeDir, "src", "index.ts")

function withIsolatedCli(
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
    return String(r.stdout ?? "") + String(r.stderr ?? "")
  }

  try {
    fn(output)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const brokenServer = {
  broken: {
    type: "local",
    command: ["/nonexistent-binary-for-mcp-status-test"],
    environment: { API_TOKEN: "{env:ALTIMATE_TEST_VAR_THAT_IS_NEVER_SET}" },
    enabled: true,
  },
}

describe("altimate-code mcp status", () => {
  test(
    "`status` reaches the server listing",
    () =>
      withIsolatedCli(brokenServer, (output) => {
        const out = output(["mcp", "status"])
        expect(out, out).toContain("broken")
        expect(out, out).not.toContain("Unknown argument")
      }),
    SUBPROCESS_TIMEOUT_MS,
  )
})
// altimate_change end

// altimate_change start — upstream_fix (#878): drift must reach the user, not just the record.
describe("altimate-code mcp status — discovered config drift", () => {
  const configured = {
    datamate: {
      type: "local",
      command: ["/nonexistent-binary-for-mcp-status-test"],
      environment: { ALTIMATE_EXTENSION_RPC: "127.0.0.1:9000" },
      enabled: true,
    },
  }
  const vscode = (rpc: string) =>
    JSON.stringify({
      servers: {
        datamate: {
          type: "stdio",
          command: "/nonexistent-binary-for-mcp-status-test",
          env: { ALTIMATE_EXTENSION_RPC: rpc },
        },
      },
    })

  test(
    "reports the field that drifted from the discovered config",
    () =>
      withIsolatedCli(
        configured,
        (output) => {
          const out = output(["mcp", "status"])
          expect(out, out).toContain("datamate")
          expect(out, out).toContain("environment.ALTIMATE_EXTENSION_RPC")
        },
        { ".vscode/mcp.json": vscode("127.0.0.1:9999") },
      ),
    SUBPROCESS_TIMEOUT_MS,
  )

  test(
    "says nothing when the discovered config agrees",
    () =>
      withIsolatedCli(
        configured,
        (output) => {
          const out = output(["mcp", "status"])
          expect(out, out).toContain("datamate")
          expect(out, out).not.toContain("environment.ALTIMATE_EXTENSION_RPC")
        },
        { ".vscode/mcp.json": vscode("127.0.0.1:9000") },
      ),
    SUBPROCESS_TIMEOUT_MS,
  )
})
// altimate_change end
