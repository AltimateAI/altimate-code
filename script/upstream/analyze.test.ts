import { describe, test, expect } from "bun:test"
import { parseDiffForMarkerWarnings, computeMarkedLines } from "./analyze"

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

  test("upstream_fix: tagged markers are recognized as valid markers", () => {
    const diff = makeDiff(
      `@@ -50,4 +50,6 @@
 const existing = true
+// altimate_change start — upstream_fix: days/hours were swapped
+const days = Math.floor(input / 86400000)
+// altimate_change end
 const more = true`,
    )
    expect(parseDiffForMarkerWarnings("file.ts", diff)).toEqual([])
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

describe("computeMarkedLines", () => {
  test("covers the marker lines and everything between", () => {
    const content = ["const a = 1", "// altimate_change start — x", "const b = 2", "// altimate_change end", "const c = 3"].join("\n")
    const marked = computeMarkedLines(content)
    expect(marked.has(1)).toBe(false) // before block
    expect(marked.has(2)).toBe(true) // start marker
    expect(marked.has(3)).toBe(true) // inside
    expect(marked.has(4)).toBe(true) // end marker
    expect(marked.has(5)).toBe(false) // after block
  })

  test("handles nested start/end pairs with a depth counter", () => {
    const content = [
      "const a = 1", // 1
      "// altimate_change start — outer", // 2
      "const b = 2", // 3
      "// altimate_change start — inner", // 4
      "const c = 3", // 5
      "// altimate_change end", // 6  (closes inner; still inside outer)
      "const d = 4", // 7  still inside outer
      "// altimate_change end", // 8  (closes outer)
      "const e = 5", // 9  outside
    ].join("\n")
    const marked = computeMarkedLines(content)
    expect(marked.has(1)).toBe(false)
    expect(marked.has(3)).toBe(true)
    expect(marked.has(5)).toBe(true)
    expect(marked.has(7)).toBe(true) // still inside outer after inner closed — the bug a single openBlock would miss
    expect(marked.has(8)).toBe(true) // outer end marker
    expect(marked.has(9)).toBe(false)
  })

  test("unbalanced extra end does not drive depth negative", () => {
    const content = ["// altimate_change end", "const a = 1", "// altimate_change start — x", "const b = 2", "// altimate_change end"].join("\n")
    const marked = computeMarkedLines(content)
    expect(marked.has(2)).toBe(false) // not inside any block
    expect(marked.has(4)).toBe(true) // inside the real block
  })
})

describe("parseDiffForMarkerWarnings + full-file coverage (context-window false positive)", () => {
  // Reproduces the worker.ts:183 CI failure: a line is MODIFIED deep inside a
  // pre-existing `altimate_change` block, but the block's `start` marker is
  // further than the diff's ±context window, so it never appears in the hunk.
  const diffModifyingInsideBlock = makeDiff(
    `@@ -180,7 +180,7 @@
 const ctxA = 1
 const ctxB = 2
 const ctxC = 3
-const trace = oldTrace()
+const trace = newTrace()
 const ctxD = 4
 const ctxE = 5
 const ctxF = 6`,
  )

  test("WITHOUT coverage map: false-positives (documents the bug)", () => {
    const warnings = parseDiffForMarkerWarnings("worker.ts", diffModifyingInsideBlock)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].context).toContain("trace = newTrace()")
  })

  test("WITH coverage map saying line 183 is inside a marked block: no warning", () => {
    // Pretend the full file has a marked block spanning lines 160-210; the
    // changed line (183) is covered even though no marker appears in the hunk.
    const marked = new Set<number>()
    for (let i = 160; i <= 210; i++) marked.add(i)
    const warnings = parseDiffForMarkerWarnings("worker.ts", diffModifyingInsideBlock, marked)
    expect(warnings).toEqual([])
  })

  test("WITH coverage map NOT covering the line: still warns (no over-suppression)", () => {
    const marked = new Set<number>([1, 2, 3]) // unrelated lines
    const warnings = parseDiffForMarkerWarnings("worker.ts", diffModifyingInsideBlock, marked)
    expect(warnings).toHaveLength(1)
  })

  test("end-to-end: computeMarkedLines feeds the parser for a real reconstructed file", () => {
    // Build a file where the change at line 183 sits inside a 160-210 block.
    const fileLines: string[] = []
    for (let i = 1; i <= 159; i++) fileLines.push(`const before${i} = ${i}`)
    fileLines.push("// altimate_change start — big block") // 160
    for (let i = 161; i <= 209; i++) fileLines.push(`const inside${i} = ${i}`)
    fileLines.push("// altimate_change end") // 210
    const marked = computeMarkedLines(fileLines.join("\n"))
    const warnings = parseDiffForMarkerWarnings("worker.ts", diffModifyingInsideBlock, marked)
    expect(warnings).toEqual([])
  })
})
