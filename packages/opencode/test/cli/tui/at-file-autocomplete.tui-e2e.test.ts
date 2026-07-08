/**
 * TUI e2e — `@` file autocomplete.
 *
 * `@` opens the file-picker popover; typed characters filter the list.
 * Fixture strategy: seed the project directory with a distinctive filename
 * before boot, then `@` + a prefix of that name, and assert the file is
 * offered.
 */

import { describe, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDirWithFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "altimate-tui-atfile-"))
  mkdirSync(path.join(dir, "src"))
  writeFileSync(path.join(dir, "src", "unique_marker_file.ts"), "// marker\n")
  writeFileSync(path.join(dir, "README.md"), "# fixture\n")
  return dir
}

describe("TUI e2e — @ file autocomplete", () => {
  test("`@unique_marker` surfaces the seeded file in the picker", async () => {
    const project = makeProjectDirWithFixture()
    const tui = await launchTui({
      cwd: project,
      cols: 160,
      rows: 50,
      waitForReady: "Ask anything",
    })
    try {
      // Same pacing as the slash-palette test — the file picker debounces
      // fast input on some renderers.
      for (const ch of "@unique_marker") {
        tui.write(ch)
        await new Promise((r) => setTimeout(r, 40))
      }
      await tui.waitForText("unique_marker_file", { timeoutMs: 5000 })
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)
})
