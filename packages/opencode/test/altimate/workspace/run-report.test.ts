import { beforeEach, describe, expect, test } from "bun:test"
import { NotFoundError, PlanLimitError, WorkspaceApiError } from "../../../src/altimate/workspace/api-client"
import {
  clientRunId,
  detectRunKind,
  reportHeadlessRun,
  resetClientRunId,
} from "../../../src/altimate/workspace/run-report"

const binding = { datamateId: 7 } as any
const limit = () =>
  new PlanLimitError({
    code: "plan_limit_reached",
    limit_key: "runs",
    message: "Your Community plan allows 500 runs a month.",
    upgrade_url: "https://acme.app.myaltimate.com/settings/credits?tab=plans",
  } as any)

function deps(over: Record<string, unknown> = {}) {
  const calls: any[] = []
  return {
    calls,
    d: {
      kind: "headless" as const,
      directory: process.cwd(),
      lookup: async () => binding,
      report: async (i: any) => {
        calls.push(i)
        return { counted: true }
      },
      ...over,
    } as any,
  }
}

beforeEach(() => resetClientRunId())

describe("detectRunKind", () => {
  test("a plain terminal or piped run is headless", () => {
    expect(detectRunKind({})).toBe("headless")
  })
  test("CI env is ci, a GitHub schedule trigger is scheduled", () => {
    expect(detectRunKind({ CI: "true" })).toBe("ci")
    expect(detectRunKind({ CI: "0" })).toBe("headless")
    expect(detectRunKind({ CI: "true", GITHUB_EVENT_NAME: "schedule" })).toBe("scheduled")
    expect(detectRunKind({ CI: "true", GITHUB_EVENT_NAME: "push" })).toBe("ci")
  })
})

describe("reportHeadlessRun", () => {
  test("reports once with kind and datamate id", async () => {
    const { calls, d } = deps()
    expect(await reportHeadlessRun(d)).toEqual({ status: "reported" })
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe("headless")
    expect(calls[0].datamate_id).toBe(7)
    expect(calls[0].client_run_id).toMatch(/^[0-9a-f-]{36}$/)
  })
  test("never reports an unlinked project", async () => {
    const { calls, d } = deps({ lookup: async () => null })
    expect((await reportHeadlessRun(d)).status).toBe("skipped")
    expect(calls).toHaveLength(0)
  })
  test("402 on runs blocks with the upgrade link", async () => {
    const { d } = deps({
      report: async () => {
        throw limit()
      },
    })
    const out = await reportHeadlessRun(d)
    expect(out.status).toBe("blocked")
    if (out.status === "blocked") {
      expect(out.error.message).toContain("500 runs a month")
      expect(out.error.message).toContain("https://acme.app.myaltimate.com/settings/credits?tab=plans")
    }
  })
  test("402 for another limit key does not block", async () => {
    const other = new PlanLimitError({ limit_key: "tokens" } as any)
    const { d } = deps({
      report: async () => {
        throw other
      },
    })
    expect((await reportHeadlessRun(d)).status).toBe("ignored")
  })
  test("404, 405 and network errors continue", async () => {
    for (const err of [
      new NotFoundError("nf"),
      new WorkspaceApiError("na", 405),
      new WorkspaceApiError("Cannot reach"),
    ]) {
      const { d } = deps({
        report: async () => {
          throw err
        },
      })
      expect(await reportHeadlessRun(d)).toEqual({ status: "ignored" })
    }
  })
  test("client_run_id is stable across reports in one process", async () => {
    const a = deps()
    const b = deps()
    await reportHeadlessRun(a.d)
    await reportHeadlessRun(b.d)
    expect(a.calls[0].client_run_id).toBe(b.calls[0].client_run_id)
    expect(a.calls[0].client_run_id).toBe(clientRunId())
  })
})
