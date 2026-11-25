import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import os from "os"
import path from "path"

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), "plan-limit-"))
process.env.OPENCODE_TEST_HOME = path.join(SANDBOX, "home")
mkdirSync(path.join(SANDBOX, "home", ".altimate"), { recursive: true })
writeFileSync(
  path.join(SANDBOX, "home", ".altimate", "altimate.json"),
  JSON.stringify({ altimateUrl: "https://api.example.test", altimateInstanceName: "acme", altimateApiKey: "k" }),
)

const { altimateRequest, PlanLimitError, WorkspaceApiError, linkFailureReason } = await import(
  "../../../src/altimate/workspace/api-client"
)
const { describePlanLimitBody, formatPlanLimit, safeUpgradeUrl } = await import(
  "../../../src/altimate/workspace/plan-limit"
)

const URL_OK = "https://acme.app.myaltimate.com/settings/credits?tab=plans"
const detail = {
  code: "plan_limit_reached",
  limit_key: "workspaces",
  plan: "community",
  limit: 2,
  current: 2,
  required_plan: "team",
  upgrade_url: URL_OK,
  message: "Your Community plan allows 2 workspaces.",
}

describe("plan limit refusal", () => {
  const ORIGINAL_FETCH = globalThis.fetch
  let reply: { status: number; body: unknown }
  beforeEach(() => {
    globalThis.fetch = (async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  test("402 with plan_limit_reached raises a typed error", async () => {
    reply = { status: 402, body: { detail } }
    const err: any = await altimateRequest("POST", "/x", { base: "/datamates" }).catch((e) => e)
    expect(err).toBeInstanceOf(PlanLimitError)
    expect(err.limitKey).toBe("workspaces")
    expect(err.plan).toBe("community")
    expect(err.limit).toBe(2)
    expect(err.current).toBe(2)
    expect(err.requiredPlan).toBe("team")
    expect(err.upgradeUrl).toBe(URL_OK)
    expect(err.message).toBe(`Your Community plan allows 2 workspaces. Upgrade to Team: ${URL_OK}`)
    expect(linkFailureReason(err)).toBe("plan_limit")
  })

  test("402 without the code keeps the generic error", async () => {
    reply = { status: 402, body: { detail: "Payment required" } }
    const err: any = await altimateRequest("POST", "/x", { base: "/datamates" }).catch((e) => e)
    expect(err).not.toBeInstanceOf(PlanLimitError)
    expect(err).toBeInstanceOf(WorkspaceApiError)
    expect(err.status).toBe(402)
    expect(err.message).toBe("Payment required")
  })

  test("a non-https upgrade url is dropped", async () => {
    reply = { status: 402, body: { detail: { ...detail, upgrade_url: "javascript:alert(1)" } } }
    const err: any = await altimateRequest("POST", "/x", { base: "/datamates" }).catch((e) => e)
    expect(err).toBeInstanceOf(PlanLimitError)
    expect(err.upgradeUrl).toBeUndefined()
    expect(err.message).toBe("Your Community plan allows 2 workspaces.")
  })
})

describe("formatPlanLimit", () => {
  test("message, required plan and url", () => {
    expect(formatPlanLimit(detail)).toBe(`Your Community plan allows 2 workspaces. Upgrade to Team: ${URL_OK}`)
  })
  test("falls back when the message is missing", () => {
    expect(formatPlanLimit({ required_plan: "business", upgrade_url: URL_OK })).toBe(
      `Your current plan does not include this. Upgrade to Business: ${URL_OK}`,
    )
  })
  test("omits the plan name when unknown and ignores http urls", () => {
    expect(formatPlanLimit({ message: "Limit hit.", upgrade_url: URL_OK })).toBe(`Limit hit. Upgrade: ${URL_OK}`)
    expect(formatPlanLimit({ message: "Limit hit", upgrade_url: "http://x.test" })).toBe("Limit hit.")
  })
  test("safeUpgradeUrl rejects non-strings and garbage", () => {
    expect(safeUpgradeUrl(undefined)).toBeUndefined()
    expect(safeUpgradeUrl("not a url")).toBeUndefined()
  })
})

describe("describePlanLimitBody", () => {
  test("formats a plan_limit_reached body", () => {
    expect(describePlanLimitBody(JSON.stringify({ detail }))).toBe(formatPlanLimit(detail))
  })
  test("ignores other bodies", () => {
    expect(describePlanLimitBody(undefined)).toBeUndefined()
    expect(describePlanLimitBody("not json")).toBeUndefined()
    expect(describePlanLimitBody(JSON.stringify({ detail: { code: "other" } }))).toBeUndefined()
    expect(describePlanLimitBody(JSON.stringify({ detail: "x" }))).toBeUndefined()
  })
})

describe("same-tier refusal", () => {
  const addonDetail = {
    ...detail,
    limit_key: "members",
    plan: "team",
    limit: 5,
    current: 5,
    required_plan: "team",
    addon_available: true,
    max_with_addons: 10,
    message: "Your Team plan includes 5 members. Add more members (up to 10) to continue.",
  }

  test("offers add-ons instead of an upgrade to the plan already in use", () => {
    expect(formatPlanLimit(addonDetail)).toBe(`${addonDetail.message} Add capacity: ${URL_OK}`)
    expect(formatPlanLimit(addonDetail)).not.toContain("Upgrade")
  })

  test("a gateway body for the same tier reads the same way", () => {
    expect(describePlanLimitBody(JSON.stringify({ detail: addonDetail }))).toBe(
      `${addonDetail.message} Add capacity: ${URL_OK}`,
    )
  })

  test("a refusal at the tier maximum still names the next tier", () => {
    const atMax = { ...addonDetail, required_plan: "business", addon_available: false }
    expect(formatPlanLimit(atMax)).toBe(`${addonDetail.message} Upgrade to Business: ${URL_OK}`)
  })
})
