// altimate_change — end-to-end harness for onboarding telemetry.
//
// Every other test in this suite spies inside one process. That cannot see the real thing: the
// TUI renders on the main thread and the server runs in a Worker, each with its own Telemetry
// instance and its own buffer. Only a real process, driven through a real terminal, exercises
// both — and only a real exit proves the flush-on-exit path works, which is where onboarding
// events are most likely to be silently lost.
//
// So this spawns the CLI in a PTY with its telemetry endpoint pointed at a local sink, sends
// keystrokes, and asserts on the envelopes that actually arrive over HTTP.
// bun-pty rather than @lydell/node-pty: the latter loads a platform-specific native package
// that is not installed in this workspace and fails SILENTLY when missing — no output, no error,
// no exit — which is a miserable thing to debug. bun-pty is a devDependency of this package.
import { spawn as ptySpawn, type IPty } from "bun-pty"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export type Envelope = {
  name: string
  properties: Record<string, string>
  measurements: Record<string, number>
  sessionId: string
}

export type Sink = {
  url: string
  envelopes: Envelope[]
  /** Resolves once an event with this name arrives, or throws after `timeout`. */
  waitFor(name: string, timeout?: number): Promise<Envelope>
  names(): string[]
  stop(): void
}

export function startSink(): Sink {
  const envelopes: Envelope[] = []

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!req.url.endsWith("/v2/track")) return new Response("not found", { status: 404 })
      const raw = (await req.json()) as any[]
      for (const item of raw) {
        const base = item?.data?.baseData ?? {}
        envelopes.push({
          name: String(base.name ?? ""),
          properties: base.properties ?? {},
          measurements: base.measurements ?? {},
          sessionId: item?.tags?.["ai.session.id"] ?? "",
        })
      }
      return new Response("", { status: 200 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    envelopes,
    names: () => envelopes.map((e) => e.name),
    async waitFor(name, timeout = 45_000) {
      const start = Date.now()
      for (;;) {
        const found = envelopes.find((e) => e.name === name)
        if (found) return found
        if (Date.now() - start > timeout) {
          throw new Error(`timed out waiting for "${name}". Received: ${JSON.stringify(envelopes.map((e) => e.name))}`)
        }
        await Bun.sleep(100)
      }
    },
    stop: () => server.stop(true),
  }
}

export type Cli = {
  pty: IPty
  /**
   * Raw terminal output, for diagnosing a run that never reached the expected screen. Not usable
   * for assertions: opentui emits per-cell escape sequences, so a visible label like "Big Pickle"
   * is split across positioning codes and never appears as a contiguous substring.
   */
  output(): string
  press(keys: string): void
  exited: Promise<number>
  cleanup(): Promise<void>
}

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..")

/**
 * Launch the CLI as a real process against `sink`, in a throwaway HOME so it looks like a first
 * run — a developer machine has credentials, which would skip the entire funnel — and so the
 * machine-id file this run creates cannot collide with the real one.
 */
export async function startCli(sink: Sink): Promise<Cli> {
  const home = await mkdtemp(path.join(tmpdir(), "altimate-e2e-home-"))
  const project = await mkdtemp(path.join(tmpdir(), "altimate-e2e-proj-"))

  let buffer = ""
  // Run from packages/opencode, exactly as the repo's `dev` script does: the JSX runtime is
  // configured in the workspace bunfig.toml, which bun only picks up from that directory. The
  // project under test is passed as the positional argument instead of via cwd.
  const pty = ptySpawn(process.execPath, ["run", "--conditions=browser", "src/index.ts", project], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: path.join(REPO_ROOT, "packages/opencode"),
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_STATE_HOME: path.join(home, ".local/state"),
        APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=e2e-local;IngestionEndpoint=${sink.url}`,
        ALTIMATE_TELEMETRY_DISABLED: "false",
        // Keep the run hermetic: no plugin installs, no upgrade check chatter.
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      } as Record<string, string>,
    })

  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => (resolveExit = resolve))
  pty.onData((d) => (buffer += d))
  pty.onExit(({ exitCode }) => resolveExit(exitCode))

  return {
    pty,
    output: () => buffer,
    press: (keys) => pty.write(keys),
    exited,
    async cleanup() {
      try {
        pty.kill()
      } catch {}
      await rm(home, { recursive: true, force: true }).catch(() => {})
      await rm(project, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export const KEY = {
  enter: "\r",
  ctrlC: "\x03",
  down: "\x1b[B",
} as const
