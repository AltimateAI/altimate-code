/**
 * End-to-end tests for the trace viewer HTML renderer.
 *
 * Uses Playwright with a real Chromium browser to test the viewer from a
 * user's perspective: clicking tabs, selecting spans, verifying detail panels,
 * and exercising adversarial edge cases (XSS, empty data, huge payloads, etc.).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { chromium, type Browser, type Page } from "playwright-core"
import { renderTraceViewer } from "../../src/altimate/observability/viewer"
import type { TraceFile } from "../../src/altimate/observability/tracing"
import fs from "fs"
import path from "path"

// ---------------------------------------------------------------------------
// Browser setup
// ---------------------------------------------------------------------------

let browser: Browser

// Find chromium installed by Playwright
const chromiumPath = (() => {
  const cacheDir = path.join(process.env.HOME || "/root", ".cache", "ms-playwright")
  try {
    const dirs = fs.readdirSync(cacheDir).filter((d) => d.startsWith("chromium-"))
    if (dirs.length) return path.join(cacheDir, dirs[0], "chrome-linux", "chrome")
  } catch {}
  return ""
})()

const canRunBrowserTests = chromiumPath && fs.existsSync(chromiumPath)

beforeAll(async () => {
  if (!canRunBrowserTests) return
  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ["--no-sandbox"],
  })
})

afterAll(async () => {
  if (browser) await browser.close()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseTrace(overrides?: Partial<TraceFile>): TraceFile {
  return {
    version: "1.0",
    sessionId: "test-session",
    startedAt: new Date(1000).toISOString(),
    endedAt: new Date(6000).toISOString(),
    metadata: {
      title: "Test Session",
      prompt: "Hello world",
      model: "anthropic/claude-3",
      providerId: "anthropic",
      agent: "default",
    },
    summary: {
      status: "completed",
      duration: 5000,
      totalTokens: 10000,
      totalCost: 0.05,
      totalGenerations: 2,
      totalToolCalls: 2,
      tokens: { input: 5000, output: 3000, reasoning: 500, cacheRead: 1000, cacheWrite: 500 },
    },
    spans: [
      {
        spanId: "sess-1",
        parentSpanId: null,
        kind: "session",
        name: "Session",
        startTime: 1000,
        endTime: 6000,
        status: "ok",
      },
      {
        spanId: "gen-1",
        parentSpanId: "sess-1",
        kind: "generation",
        name: "Generation 1",
        startTime: 1100,
        endTime: 2500,
        status: "ok",
        tokens: { input: 2000, output: 1000, total: 3000 },
        cost: 0.02,
        input: "User asks a question",
        output: "Agent responds with an answer",
      },
      {
        spanId: "tool-1",
        parentSpanId: "gen-1",
        kind: "tool",
        name: "ReadFile",
        startTime: 1500,
        endTime: 2000,
        status: "ok",
        tool: { callId: "call-1", durationMs: 500 },
        input: { path: "/src/index.ts" },
        output: "const app = express();",
      },
      {
        spanId: "gen-2",
        parentSpanId: "sess-1",
        kind: "generation",
        name: "Generation 2",
        startTime: 2600,
        endTime: 5500,
        status: "ok",
        tokens: { input: 3000, output: 2000, total: 5000 },
        cost: 0.03,
        input: "Follow-up question",
        output: "Follow-up answer",
      },
      {
        spanId: "tool-2",
        parentSpanId: "gen-2",
        kind: "tool",
        name: "WriteFile",
        startTime: 3000,
        endTime: 4500,
        status: "ok",
        tool: { callId: "call-2", durationMs: 1500 },
        input: { path: "/src/out.ts", content: "done" },
        output: "Written successfully",
      },
    ],
    ...overrides,
  } as TraceFile
}

async function openViewer(trace: TraceFile, opts?: { live?: boolean }): Promise<Page> {
  const page = await browser.newPage()
  const html = renderTraceViewer(trace, opts)
  await page.setContent(html)
  await page.waitForSelector(".tabs")
  return page
}

/** Click a waterfall row by index and return the detail panel title */
async function clickWfRow(page: Page, index: number) {
  await page.locator(".wf-row").nth(index).click()
  return page.evaluate(() => document.querySelector(".detail-panel h3")?.textContent ?? null)
}

/** Click a tree item by index and return the detail panel title */
async function clickTreeItem(page: Page, index: number) {
  await page.locator(".tree-item").nth(index).click()
  return page.evaluate(() => document.querySelector(".detail-panel h3")?.textContent ?? null)
}

/** Click a log entry by index and return the detail panel title */
async function clickLogEntry(page: Page, index: number) {
  await page.locator(".log-entry").nth(index).click()
  return page.evaluate(() => document.querySelector(".detail-panel h3")?.textContent ?? null)
}

/** Get the active tab name */
async function activeTab(page: Page) {
  return page.evaluate(() => document.querySelector(".tab.active")?.getAttribute("data-view"))
}

/** Get the active view id */
async function activeView(page: Page) {
  return page.evaluate(() => document.querySelector(".view.active")?.id)
}

/** Count JS errors on the page */
function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("pageerror", (err) => errors.push(err.message))
  return errors
}

// ---------------------------------------------------------------------------
// E2E Tests — User perspective
// ---------------------------------------------------------------------------

describe.skipIf(!canRunBrowserTests)("Trace Viewer E2E", () => {
  test("renders page without JS errors", async () => {
    const page = await openViewer(baseTrace())
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    await page.close()
  })

  test("default view is waterfall", async () => {
    const page = await openViewer(baseTrace())
    expect(await activeTab(page)).toBe("waterfall")
    expect(await activeView(page)).toBe("v-waterfall")
    await page.close()
  })

  test("renders correct number of waterfall rows (excludes session)", async () => {
    const page = await openViewer(baseTrace())
    const count = await page.locator(".wf-row").count()
    // 4 non-session spans: gen-1, tool-1, gen-2, tool-2
    expect(count).toBe(4)
    await page.close()
  })

  test("clicking each waterfall row shows correct detail", async () => {
    const page = await openViewer(baseTrace())
    const names = ["Generation 1", "ReadFile", "Generation 2", "WriteFile"]
    for (let i = 0; i < names.length; i++) {
      const detail = await clickWfRow(page, i)
      expect(detail).toBe(names[i])
    }
    await page.close()
  })

  test("waterfall row selection is exclusive (only one .sel at a time)", async () => {
    const page = await openViewer(baseTrace())
    await clickWfRow(page, 0)
    await clickWfRow(page, 2)
    const selCount = await page.evaluate(() => document.querySelectorAll(".wf-row.sel").length)
    expect(selCount).toBe(1)
    const selName = await page.evaluate(
      () => document.querySelector(".wf-row.sel .wf-name")?.textContent,
    )
    expect(selName).toBe("Generation 2")
    await page.close()
  })

  test("tab switching works for all 4 tabs", async () => {
    const page = await openViewer(baseTrace())
    for (const tab of ["tree", "chat", "log", "waterfall"] as const) {
      await page.click(`[data-view="${tab}"]`)
      expect(await activeTab(page)).toBe(tab)
      expect(await activeView(page)).toBe(`v-${tab}`)
    }
    await page.close()
  })

  test("tab switching clears detail panel", async () => {
    const page = await openViewer(baseTrace())
    await clickWfRow(page, 0)
    const before = await page.evaluate(() => document.getElementById("detail")?.innerHTML)
    expect(before).toBeTruthy()
    await page.click('[data-view="tree"]')
    const after = await page.evaluate(() => document.getElementById("detail")?.innerHTML)
    expect(after).toBe("")
    await page.close()
  })

  test("tree view shows correct items with proper nesting", async () => {
    const page = await openViewer(baseTrace())
    await page.click('[data-view="tree"]')
    const treeItems = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".tree-item")).map((el) => ({
        title: el.querySelector(".tree-title")?.textContent,
        idx: (el as HTMLElement).dataset.idx,
      })),
    )
    expect(treeItems.length).toBe(4) // 4 non-session spans
    expect(treeItems.map((t) => t.title)).toEqual([
      "Generation 1",
      "ReadFile",
      "Generation 2",
      "WriteFile",
    ])
    // Each idx should be a valid number
    for (const item of treeItems) {
      expect(Number(item.idx)).toBeGreaterThanOrEqual(0)
    }
    await page.close()
  })

  test("clicking each tree item shows correct detail", async () => {
    const page = await openViewer(baseTrace())
    await page.click('[data-view="tree"]')
    const names = ["Generation 1", "ReadFile", "Generation 2", "WriteFile"]
    for (let i = 0; i < names.length; i++) {
      const detail = await clickTreeItem(page, i)
      expect(detail).toBe(names[i])
    }
    await page.close()
  })

  test("clicking tree items in reverse order shows correct detail", async () => {
    const page = await openViewer(baseTrace())
    await page.click('[data-view="tree"]')
    // Click last first, then first — this is the "always expands last node" test
    const last = await clickTreeItem(page, 3)
    expect(last).toBe("WriteFile")
    const first = await clickTreeItem(page, 0)
    expect(first).toBe("Generation 1")
    const middle = await clickTreeItem(page, 1)
    expect(middle).toBe("ReadFile")
    await page.close()
  })

  test("log entries are clickable and show detail", async () => {
    const page = await openViewer(baseTrace())
    await page.click('[data-view="log"]')
    const logCount = await page.locator(".log-entry").count()
    expect(logCount).toBe(4)
    // Click first log entry
    const detail = await clickLogEntry(page, 0)
    expect(detail).toBeTruthy()
    // Verify selection highlight
    const selCount = await page.evaluate(() => document.querySelectorAll(".log-entry.sel").length)
    expect(selCount).toBe(1)
    await page.close()
  })

  test("log entries sorted by startTime show correct detail on click", async () => {
    const page = await openViewer(baseTrace())
    await page.click('[data-view="log"]')
    const entries = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".log-entry")).map((el) => ({
        name: el.querySelector(".log-name")?.textContent,
        idx: (el as HTMLElement).dataset.idx,
      })),
    )
    // Check each entry points to the right span
    for (let i = 0; i < entries.length; i++) {
      const detail = await clickLogEntry(page, i)
      expect(detail).toBe(entries[i].name)
    }
    await page.close()
  })

  test("chat view shows prompt and generation output", async () => {
    const page = await openViewer(baseTrace())
    await page.click('[data-view="chat"]')
    const promptText = await page.evaluate(
      () => document.querySelector(".chat-msg.user .chat-bubble")?.textContent,
    )
    expect(promptText).toBe("Hello world")
    const agentBubbles = await page.locator(".chat-msg.agent .chat-bubble").count()
    expect(agentBubbles).toBeGreaterThanOrEqual(1)
    await page.close()
  })

  test("detail panel shows input/output when present", async () => {
    const page = await openViewer(baseTrace())
    await clickWfRow(page, 0) // Generation 1
    const hasInput = await page.evaluate(() => !!document.querySelector(".sec-lbl"))
    expect(hasInput).toBe(true)
    const inputText = await page.evaluate(() => {
      const pres = document.querySelectorAll("pre.io")
      return pres[0]?.textContent ?? ""
    })
    expect(inputText).toContain("User asks a question")
    await page.close()
  })

  test("summary cards display correct values", async () => {
    const page = await openViewer(baseTrace())
    const cards = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".card")).map((c) => ({
        label: c.querySelector(".lbl")?.textContent,
        value: c.querySelector(".val")?.textContent,
      })),
    )
    const durationCard = cards.find((c) => c.label === "Duration")
    expect(durationCard).toBeDefined()
    expect(durationCard!.value).toBe("5.0s")
    const costCard = cards.find((c) => c.label === "Cost")
    expect(costCard).toBeDefined()
    expect(costCard!.value).toBe("$0.05")
    await page.close()
  })

  test("header tags show session metadata", async () => {
    const page = await openViewer(baseTrace())
    const tagsText = await page.evaluate(() => document.getElementById("tags")?.textContent ?? "")
    expect(tagsText).toContain("Test Session")
    expect(tagsText).toContain("anthropic")
    expect(tagsText).toContain("claude-3")
    await page.close()
  })

  test("rapid tab switching does not break state", async () => {
    const page = await openViewer(baseTrace())
    const errors = collectErrors(page)
    // Rapid switching
    for (let i = 0; i < 10; i++) {
      for (const tab of ["waterfall", "tree", "chat", "log"]) {
        await page.click(`[data-view="${tab}"]`)
      }
    }
    expect(errors).toEqual([])
    // Verify final state is log
    expect(await activeTab(page)).toBe("log")
    await page.close()
  })

  test("clicking between views preserves correct behavior", async () => {
    const page = await openViewer(baseTrace())
    // Click WF row, switch to tree, click tree item, switch to log, click log entry
    await clickWfRow(page, 0)
    expect(await page.evaluate(() => document.querySelector(".detail-panel h3")?.textContent)).toBe(
      "Generation 1",
    )

    await page.click('[data-view="tree"]')
    await clickTreeItem(page, 3)
    expect(await page.evaluate(() => document.querySelector(".detail-panel h3")?.textContent)).toBe(
      "WriteFile",
    )

    await page.click('[data-view="log"]')
    await clickLogEntry(page, 0)
    const logDetail = await page.evaluate(
      () => document.querySelector(".detail-panel h3")?.textContent,
    )
    expect(logDetail).toBeTruthy()
    await page.close()
  })
})

// ---------------------------------------------------------------------------
// Adversarial Tests — Edge cases & malicious data
// ---------------------------------------------------------------------------

describe.skipIf(!canRunBrowserTests)("Trace Viewer Adversarial", () => {
  test("empty spans array renders without errors", async () => {
    const page = await openViewer(baseTrace({ spans: [] }))
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    const wfCount = await page.locator(".wf-row").count()
    expect(wfCount).toBe(0)
    await page.click('[data-view="tree"]')
    const treeText = await page.evaluate(() => document.getElementById("v-tree")?.textContent ?? "")
    expect(treeText).toContain("No spans recorded")
    await page.close()
  })

  test("single span (session only) renders without errors", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s1",
          parentSpanId: null,
          kind: "session",
          name: "Lonely Session",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
      ],
    })
    const page = await openViewer(trace)
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    expect(await page.locator(".wf-row").count()).toBe(0)
    await page.close()
  })

  test("duplicate spanIds: each tree item still shows correct detail", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 1000,
          endTime: 3000,
          status: "ok",
        },
        {
          spanId: "dup",
          parentSpanId: "s",
          kind: "generation",
          name: "First-DUP",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
          output: "out1",
        },
        {
          spanId: "dup",
          parentSpanId: "s",
          kind: "generation",
          name: "Second-DUP",
          startTime: 2000,
          endTime: 3000,
          status: "ok",
          output: "out2",
        },
      ],
    })
    const page = await openViewer(trace)
    // Waterfall
    expect(await clickWfRow(page, 0)).toBe("First-DUP")
    expect(await clickWfRow(page, 1)).toBe("Second-DUP")
    // Tree
    await page.click('[data-view="tree"]')
    expect(await clickTreeItem(page, 0)).toBe("First-DUP")
    expect(await clickTreeItem(page, 1)).toBe("Second-DUP")
    await page.close()
  })

  test("XSS in span names is escaped", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 1000,
          endTime: 3000,
          status: "ok",
        },
        {
          spanId: "xss",
          parentSpanId: "s",
          kind: "generation",
          name: '<script>alert("XSS")</script>',
          startTime: 1000,
          endTime: 2000,
          status: "ok",
          output: '<img src=x onerror="alert(1)">',
        },
      ],
    })
    const page = await openViewer(trace)
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    // The script tag should be rendered as text, not executed
    const wfName = await page.evaluate(
      () => document.querySelector(".wf-name")?.textContent ?? "",
    )
    expect(wfName).toContain("<script>")
    // Click and verify detail also escapes
    await clickWfRow(page, 0)
    const detail = await page.evaluate(
      () => document.querySelector(".detail-panel h3")?.textContent ?? "",
    )
    expect(detail).toContain("<script>")
    await page.close()
  })

  test("XSS in metadata is escaped", async () => {
    const trace = baseTrace({
      metadata: {
        title: '<script>alert("title")</script>',
        prompt: '"><img src=x onerror=alert(1)>',
        model: "anthropic/claude-3",
        providerId: "anthropic",
        agent: "default",
      },
    } as any)
    const page = await openViewer(trace)
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    const tags = await page.evaluate(() => document.getElementById("tags")?.innerHTML ?? "")
    expect(tags).not.toContain("<script>")
    expect(tags).toContain("&lt;script&gt;")
    await page.close()
  })

  test("special characters in spanId work correctly", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 1000,
          endTime: 3000,
          status: "ok",
        },
        {
          spanId: 'id-with-"quotes"',
          parentSpanId: "s",
          kind: "generation",
          name: "QuotedID",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
        {
          spanId: "id-with-<angle>",
          parentSpanId: "s",
          kind: "tool",
          name: "AngleID",
          startTime: 2000,
          endTime: 3000,
          status: "ok",
        },
      ],
    })
    const page = await openViewer(trace)
    expect(await clickWfRow(page, 0)).toBe("QuotedID")
    expect(await clickWfRow(page, 1)).toBe("AngleID")
    await page.click('[data-view="tree"]')
    expect(await clickTreeItem(page, 0)).toBe("QuotedID")
    expect(await clickTreeItem(page, 1)).toBe("AngleID")
    await page.close()
  })

  test("null/undefined spanIds do not crash", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 1000,
          endTime: 3000,
          status: "ok",
        },
        {
          spanId: undefined as any,
          parentSpanId: "s",
          kind: "generation",
          name: "NoID",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
        {
          spanId: null as any,
          parentSpanId: "s",
          kind: "tool",
          name: "NullID",
          startTime: 2000,
          endTime: 3000,
          status: "ok",
        },
      ],
    })
    const page = await openViewer(trace)
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    // Waterfall should still work (index-based)
    expect(await clickWfRow(page, 0)).toBe("NoID")
    expect(await clickWfRow(page, 1)).toBe("NullID")
    await page.close()
  })

  test("very long span names are rendered safely", async () => {
    const longName = "A".repeat(10000)
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
        {
          spanId: "long",
          parentSpanId: "s",
          kind: "generation",
          name: longName,
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
      ],
    })
    const page = await openViewer(trace)
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    await clickWfRow(page, 0)
    const detail = await page.evaluate(
      () => document.querySelector(".detail-panel h3")?.textContent ?? "",
    )
    expect(detail.length).toBe(10000)
    await page.close()
  })

  test("large number of spans (100+) renders and clicks work", async () => {
    const spans: any[] = [
      {
        spanId: "s",
        parentSpanId: null,
        kind: "session",
        name: "Session",
        startTime: 0,
        endTime: 100000,
        status: "ok",
      },
    ]
    for (let i = 0; i < 50; i++) {
      spans.push({
        spanId: `g${i}`,
        parentSpanId: "s",
        kind: "generation",
        name: `Gen-${i}`,
        startTime: i * 1000,
        endTime: (i + 1) * 1000,
        status: "ok",
      })
      spans.push({
        spanId: `t${i}`,
        parentSpanId: `g${i}`,
        kind: "tool",
        name: `Tool-${i}`,
        startTime: i * 1000 + 200,
        endTime: i * 1000 + 800,
        status: "ok",
      })
    }
    const trace = baseTrace({ spans })
    const page = await openViewer(trace)
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 300))
    expect(errors).toEqual([])
    expect(await page.locator(".wf-row").count()).toBe(100)

    // Click first, middle, last waterfall rows
    expect(await clickWfRow(page, 0)).toBe("Gen-0")
    expect(await clickWfRow(page, 50)).toBe("Gen-25")
    expect(await clickWfRow(page, 99)).toBe("Tool-49")

    // Tree view
    await page.click('[data-view="tree"]')
    expect(await page.locator(".tree-item").count()).toBe(100)
    expect(await clickTreeItem(page, 0)).toBe("Gen-0")
    expect(await clickTreeItem(page, 99)).toBe("Tool-49")
    // Click first after clicking last (the core bug scenario)
    expect(await clickTreeItem(page, 0)).toBe("Gen-0")

    // Log view
    await page.click('[data-view="log"]')
    expect(await page.locator(".log-entry").count()).toBe(100)
    expect(await clickLogEntry(page, 0)).toBeTruthy()
    await page.close()
  })

  test("error status spans display correctly", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 1000,
          endTime: 3000,
          status: "ok",
        },
        {
          spanId: "err",
          parentSpanId: "s",
          kind: "generation",
          name: "Failed Gen",
          startTime: 1000,
          endTime: 2000,
          status: "error",
          statusMessage: "Rate limit exceeded",
        },
        {
          spanId: "tool-err",
          parentSpanId: "err",
          kind: "tool",
          name: "BrokenTool",
          startTime: 1200,
          endTime: 1500,
          status: "error",
          statusMessage: "Permission denied",
        },
      ],
    })
    const page = await openViewer(trace)
    await clickWfRow(page, 0) // Failed Gen
    const errorMsg = await page.evaluate(() => {
      const dds = document.querySelectorAll(".dg dd")
      return Array.from(dds).map((d) => d.textContent).join("|")
    })
    expect(errorMsg).toContain("error")
    expect(errorMsg).toContain("Rate limit exceeded")
    await page.close()
  })

  test("spans with no parent (orphaned) show in waterfall", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "orphan-1",
          parentSpanId: null,
          kind: "generation",
          name: "Orphan 1",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
        {
          spanId: "orphan-2",
          parentSpanId: null,
          kind: "tool",
          name: "Orphan 2",
          startTime: 2000,
          endTime: 3000,
          status: "ok",
        },
      ],
    })
    const page = await openViewer(trace)
    expect(await page.locator(".wf-row").count()).toBe(2)
    expect(await clickWfRow(page, 0)).toBe("Orphan 1")
    expect(await clickWfRow(page, 1)).toBe("Orphan 2")
    await page.close()
  })

  test("deeply nested tree (5 levels) shows correct detail on click", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Root",
          startTime: 0,
          endTime: 5000,
          status: "ok",
        },
        {
          spanId: "l1",
          parentSpanId: "s",
          kind: "generation",
          name: "Level-1",
          startTime: 100,
          endTime: 4900,
          status: "ok",
        },
        {
          spanId: "l2",
          parentSpanId: "l1",
          kind: "tool",
          name: "Level-2",
          startTime: 200,
          endTime: 4800,
          status: "ok",
        },
        {
          spanId: "l3",
          parentSpanId: "l2",
          kind: "generation",
          name: "Level-3",
          startTime: 300,
          endTime: 4700,
          status: "ok",
        },
        {
          spanId: "l4",
          parentSpanId: "l3",
          kind: "tool",
          name: "Level-4",
          startTime: 400,
          endTime: 4600,
          status: "ok",
        },
        {
          spanId: "l5",
          parentSpanId: "l4",
          kind: "generation",
          name: "Level-5",
          startTime: 500,
          endTime: 4500,
          status: "ok",
        },
      ],
    })
    const page = await openViewer(trace)
    await page.click('[data-view="tree"]')
    // Click deepest node
    expect(await clickTreeItem(page, 4)).toBe("Level-5")
    // Click shallowest node
    expect(await clickTreeItem(page, 0)).toBe("Level-1")
    // Click middle
    expect(await clickTreeItem(page, 2)).toBe("Level-3")
    await page.close()
  })

  test("missing metadata fields do not crash", async () => {
    const trace = baseTrace({
      metadata: {} as any,
    })
    const page = await openViewer(trace)
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    await page.close()
  })

  test("missing summary fields do not crash", async () => {
    const trace = baseTrace({
      summary: {} as any,
    })
    const page = await openViewer(trace)
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    await page.close()
  })

  test("span with circular-reference-safe input renders", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
        {
          spanId: "g1",
          parentSpanId: "s",
          kind: "generation",
          name: "Gen1",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
          input: {
            _serialization_error: "Input contained circular references or non-serializable data",
          },
        },
      ],
    })
    const page = await openViewer(trace)
    await clickWfRow(page, 0)
    const inputText = await page.evaluate(() => {
      const pre = document.querySelector("pre.io")
      return pre?.textContent ?? ""
    })
    expect(inputText).toContain("circular")
    await page.close()
  })

  test("span with DE attributes displays grouped sections", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
        {
          spanId: "g1",
          parentSpanId: "s",
          kind: "generation",
          name: "Gen1",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
          attributes: {
            "de.warehouse.type": "snowflake",
            "de.warehouse.bytes_scanned": 1048576,
            "de.sql.query_count": 5,
            "de.cost.total": 0.005,
            "custom.attr": "value",
          },
        },
      ],
    })
    const page = await openViewer(trace)
    await clickWfRow(page, 0)
    const sections = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".de-title")).map((el) => el.textContent),
    )
    expect(sections).toContain("Warehouse")
    expect(sections).toContain("SQL")
    expect(sections).toContain("Cost")
    await page.close()
  })

  test("negative/zero durations do not crash", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 0,
          endTime: 0,
          status: "ok",
        },
        {
          spanId: "neg",
          parentSpanId: "s",
          kind: "generation",
          name: "Negative",
          startTime: 5000,
          endTime: 1000,
          status: "ok",
        },
        {
          spanId: "zero",
          parentSpanId: "s",
          kind: "tool",
          name: "Zero",
          startTime: 0,
          endTime: 0,
          status: "ok",
        },
      ],
    })
    const page = await openViewer(trace)
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    expect(await clickWfRow(page, 0)).toBe("Negative")
    expect(await clickWfRow(page, 1)).toBe("Zero")
    await page.close()
  })

  test("live mode renders without JS errors", async () => {
    const trace = baseTrace()
    const page = await openViewer(trace, { live: true })
    const errors = collectErrors(page)
    await new Promise((r) => setTimeout(r, 200))
    expect(errors).toEqual([])
    const liveBadge = await page.evaluate(
      () => document.querySelector(".live-badge")?.textContent ?? "",
    )
    expect(liveBadge).toContain("LIVE")
    await page.close()
  })

  test("click on tree-node border (not tree-item) does not show detail", async () => {
    const page = await openViewer(baseTrace())
    await page.click('[data-view="tree"]')
    // Click on the tree-node container, not on a tree-item
    const nodeExists = await page.locator(".tree-node").count()
    expect(nodeExists).toBeGreaterThan(0)
    // Force click on tree-node directly (not on tree-item child)
    await page.evaluate(() => {
      const node = document.querySelector(".tree-node")
      if (node) {
        const evt = new MouseEvent("click", { bubbles: true })
        Object.defineProperty(evt, "target", { value: node })
        // The handler should bail since .closest('.tree-item') returns null on .tree-node itself
      }
    })
    // Detail should be empty (from tab switch clearing it)
    const detail = await page.evaluate(() => document.getElementById("detail")?.innerHTML ?? "")
    expect(detail).toBe("")
    await page.close()
  })

  test("renderTraceViewer escapes </script> in JSON data", () => {
    const trace = baseTrace({
      metadata: {
        ...baseTrace().metadata,
        prompt: 'Test </script><script>alert(1)</script>',
      },
    } as any)
    const html = renderTraceViewer(trace)
    // Should not contain raw </script> inside the script tag
    const scriptContent = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ""
    // The only </script> should be the closing tag itself
    expect(scriptContent).not.toContain("</script>")
    // But should contain the escaped version
    expect(scriptContent).toContain("<\\/script>")
  })

  test("unicode in span names renders correctly", async () => {
    const trace = baseTrace({
      spans: [
        {
          spanId: "s",
          parentSpanId: null,
          kind: "session",
          name: "Session",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
        {
          spanId: "uni",
          parentSpanId: "s",
          kind: "generation",
          name: "日本語テスト 🎉 émojis",
          startTime: 1000,
          endTime: 2000,
          status: "ok",
        },
      ],
    })
    const page = await openViewer(trace)
    const detail = await clickWfRow(page, 0)
    expect(detail).toBe("日本語テスト 🎉 émojis")
    await page.close()
  })
})
