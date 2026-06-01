/**
 * Regression test for AltimateAI/altimate-code#714.
 *
 * The TUI command palette's "Open docs" entry historically pointed at
 * `https://altimate.ai/docs` — the wrong domain. The canonical docs site
 * lives at `https://docs.altimate.sh`. The URL itself is never rendered in
 * the TUI (the entry only displays the title "Open docs"), so we can't
 * assert on visible text. Instead, we intercept the `open` npm package's
 * subprocess: on macOS it shells out to `open <url>` resolved from PATH,
 * on Linux to `xdg-open <url>`. We prepend a shim directory containing
 * fake versions of both that record their argv to a file.
 */

import { describe, expect, test } from "bun:test"
import path from "path"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

describe("TUI e2e — Open docs command", () => {
  test("invokes the canonical docs URL (issue #714)", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "altimate-tui-docs-"))
    const shimDir = path.join(project, "shims")
    mkdirSync(shimDir, { recursive: true })
    const captureFile = path.join(project, "browser-args.txt")
    for (const name of ["open", "xdg-open"]) {
      const shimPath = path.join(shimDir, name)
      writeFileSync(shimPath, `#!/bin/sh\necho "$@" >> "${captureFile}"\nexit 0\n`)
      chmodSync(shimPath, 0o755)
    }

    const tui = await launchTui({
      cwd: project,
      cols: 140,
      rows: 50,
      waitForReady: "Ask anything",
      bootTimeoutMs: 20_000,
      env: { PATH: `${shimDir}:${process.env.PATH ?? ""}` },
    })

    try {
      await sleep(600)

      // Open the command palette (`command_list` keybind = `ctrl+p`, from
      // packages/opencode/src/config/config.ts:905).
      tui.write("\x10")
      await sleep(600)

      // Filter to "Open docs" by typing the title slowly into the palette's
      // filter input. Char-by-char with a small delay because batched writes
      // can race the palette's keystroke binding on slower machines.
      for (const ch of "open docs") {
        tui.write(ch)
        await sleep(50)
      }
      await sleep(400)

      // Confirm the picker actually filtered to the right entry before
      // committing — clearer failure message if the palette regressed.
      await tui.waitForText("Open docs", { timeoutMs: 5_000 })

      tui.sendKey("Enter")
      // Give the spawned shim a beat to finish writing.
      await sleep(1500)

      expect(existsSync(captureFile)).toBe(true)
      const captured = readFileSync(captureFile, "utf-8").trim()
      expect(captured).toBe("https://docs.altimate.sh")
      // Negative assertion locks in the specific regression — guards
      // against a revert pointing back at the old domain.
      expect(captured).not.toMatch(/altimate\.ai\/docs/)
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 60_000)
})

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
