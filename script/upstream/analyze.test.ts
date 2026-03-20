import { describe, test, expect } from "bun:test"
import { parseDiffForMarkerWarnings } from "./analyze"

// Helper to create a unified diff string from lines
function makeDiff(hunks: string): string {
  return `diff --git a/file.ts b/file.ts
index abc1234..def5678 100644
--- a/file.ts
+++ b/file.ts
${hunks}`
}

describe("parseDiffForMarkerWarnings", () => {
  test("returns no warnings for empty diff", () => {
    expect(parseDiffForMarkerWarnings("file.ts", "")).toEqual([])
    expect(parseDiffForMarkerWarnings("file.ts", "  \n  ")).toEqual([])
  })

  test("added code inside added markers — no warning", () => {
    const diff = makeDiff(
      `@@ -10,3 +10,5 @@
 const existing = true
+// altimate_change start — new feature
+const custom = true
+// altimate_change end
 const more = true`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("added code without markers — warning", () => {
    const diff = makeDiff(
      `@@ -10,3 +10,4 @@
 const existing = true
+const unmarked = true
 const more = true`,
    )
    const warnings = parseDiffForMarkerWarnings("file.ts", diff)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].file).toBe("file.ts")
    expect(warnings[0].context).toContain("unmarked")
  })

  test("REGRESSION: added code inside existing (context) markers — no warning", () => {
    // This is the exact bug that caused the upgrade indicator leak.
    // Markers are context lines (already committed), new code is added inside.
    const diff = makeDiff(
      `@@ -10,4 +10,5 @@
 const existing = true
 // altimate_change start — existing feature
+const newCodeInsideExistingBlock = true
 // altimate_change end
 const more = true`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("REGRESSION: context marker end followed by added code — warning", () => {
    // New code added AFTER an existing marker block should be flagged.
    const diff = makeDiff(
      `@@ -10,4 +10,5 @@
 // altimate_change start — block A
 const blockA = true
 // altimate_change end
+const outsideBlock = true
 const existing = true`,
    )
    const warnings = parseDiffForMarkerWarnings("file.ts", diff)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].context).toContain("outsideBlock")
  })

  test("REGRESSION: context marker start, added code, context marker end — no warning", () => {
    // Entire marker block is pre-existing (context), only the inner code is new.
    const diff = makeDiff(
      `@@ -8,4 +8,5 @@
 // altimate_change start - yolo mode visual indicator
 import { Flag } from "@/flag/flag"
 // altimate_change end
+import { UpgradeIndicator } from "../../component/upgrade-indicator"
 const next = true`,
    )
    // The import line is skipped by the "import " heuristic, so no warning
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("REGRESSION: non-import code inside existing context markers — no warning", () => {
    // Verifies the fix works independently of the import heuristic
    const diff = makeDiff(
      `@@ -10,4 +10,5 @@
 const existing = true
 // altimate_change start — custom feature
+const customCode = doSomething()
 // altimate_change end
 const more = true`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("REGRESSION: JSX comment markers on context lines — no warning", () => {
    // JSX uses {/* altimate_change start ... */} syntax
    const diff = makeDiff(
      `@@ -95,4 +95,5 @@
 {/* altimate_change start — upgrade indicator */}
+<UpgradeIndicator />
 {/* altimate_change end */}
 </box>`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("multiple hunks — marker state resets at hunk boundary", () => {
    // Each hunk starts fresh, marker state should NOT carry across hunks
    // since different parts of the file may have different marker context.
    const diff = makeDiff(
      `@@ -5,3 +5,4 @@
 // altimate_change start — block 1
+const inBlock = true
 // altimate_change end
@@ -50,3 +51,4 @@
 const existing = true
+const unmarkedInSecondHunk = true
 const more = true`,
    )
    const warnings = parseDiffForMarkerWarnings("file.ts", diff)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].context).toContain("unmarkedInSecondHunk")
  })

  test("marker state from hunk 1 does not leak into hunk 2", () => {
    // If hunk 1 ends inside a marker block (start without end in context),
    // hunk 2 should NOT inherit that state.
    const diff = makeDiff(
      `@@ -5,3 +5,4 @@
 // altimate_change start — block 1
+const inBlock = true
 const moreInBlock = true
@@ -80,3 +81,4 @@
 const unrelated = true
+const shouldBeWarned = true
 const end = true`,
    )
    const warnings = parseDiffForMarkerWarnings("file.ts", diff)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].context).toContain("shouldBeWarned")
  })

  test("import lines are skipped even without markers", () => {
    const diff = makeDiff(
      `@@ -1,3 +1,4 @@
 import { existing } from "./existing"
+import { NewThing } from "./new-thing"
 const x = 1`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("export lines are skipped even without markers", () => {
    const diff = makeDiff(
      `@@ -1,3 +1,4 @@
 const x = 1
+export { x }
 const y = 2`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("comment-only lines are skipped (not TODOs)", () => {
    const diff = makeDiff(
      `@@ -1,3 +1,4 @@
 const x = 1
+// this is a harmless comment
 const y = 2`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("TODO comments are NOT skipped", () => {
    const diff = makeDiff(
      `@@ -1,3 +1,4 @@
 const x = 1
+// TODO: implement custom feature
 const y = 2`,
    )
    const warnings = parseDiffForMarkerWarnings("file.ts", diff)
    expect(warnings).toHaveLength(1)
  })

  test("empty added lines are skipped", () => {
    const diff = makeDiff(
      `@@ -1,3 +1,4 @@
 const x = 1
+
 const y = 2`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("deleted lines don't affect marker state or line numbers", () => {
    const diff = makeDiff(
      `@@ -5,5 +5,5 @@
 // altimate_change start — feature
-const oldCode = true
+const newCode = true
 // altimate_change end
 const next = true`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
  })

  test("line number in warning matches diff hunk position", () => {
    const diff = makeDiff(
      `@@ -42,3 +42,4 @@
 const existing = true
+const unmarked = true
 const more = true`,
    )
    const warnings = parseDiffForMarkerWarnings("file.ts", diff)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].line).toBe(43)
  })

  test("context truncated to 80 chars in warning", () => {
    const longLine = "x".repeat(120)
    const diff = makeDiff(
      `@@ -1,3 +1,4 @@
 const a = 1
+const ${longLine} = true
 const b = 2`,
    )
    const warnings = parseDiffForMarkerWarnings("file.ts", diff)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].context.length).toBeLessThanOrEqual(80)
  })

  test("only first unmarked line is reported per file", () => {
    const diff = makeDiff(
      `@@ -1,3 +1,5 @@
 const a = 1
+const first = true
+const second = true
 const b = 2`,
    )
    const warnings = parseDiffForMarkerWarnings("file.ts", diff)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].context).toContain("first")
  })

  test("real-world scenario: upgrade indicator in footer.tsx", () => {
    // Simulates the exact diff that leaked: UpgradeIndicator added to
    // session footer without markers, adjacent to existing yolo marker block.
    const diff = makeDiff(
      `@@ -8,4 +8,6 @@
 // altimate_change start - yolo mode visual indicator
 import { Flag } from "@/flag/flag"
 // altimate_change end
+// altimate_change start — upgrade indicator import
+import { UpgradeIndicator } from "../../component/upgrade-indicator"
+// altimate_change end

@@ -96,4 +98,6 @@
         </Switch>
+        {/* altimate_change start — upgrade indicator in session footer */}
+        <UpgradeIndicator />
+        {/* altimate_change end */}
       </box>`,
    )
    expect(parseDiffForMarkerWarnings("footer.tsx", diff)).toEqual([])
  })

  test("real-world scenario: unmarked upgrade indicator would be caught", () => {
    // Same scenario but WITHOUT markers — should flag
    const diff = makeDiff(
      `@@ -8,4 +8,5 @@
 // altimate_change start - yolo mode visual indicator
 import { Flag } from "@/flag/flag"
 // altimate_change end
+import { UpgradeIndicator } from "../../component/upgrade-indicator"

@@ -96,4 +97,5 @@
         </Switch>
+        <UpgradeIndicator />
       </box>`,
    )
    const warnings = parseDiffForMarkerWarnings("footer.tsx", diff)
    // import is skipped by heuristic, but <UpgradeIndicator /> is flagged
    expect(warnings).toHaveLength(1)
    expect(warnings[0].context).toContain("UpgradeIndicator")
  })
})
