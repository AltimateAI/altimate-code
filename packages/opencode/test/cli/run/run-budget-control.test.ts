// altimate_change start — shared message and command control preserves reminder-before-interruption ordering
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Bus } from "../../../src/bus"
import { RunBudget } from "../../../src/altimate/run-budget"
import { withBudgetControl } from "../../../src/altimate/session/run-budget-control"
import * as RunBudgetEffort from "../../../src/altimate/session/run-budget-effort"
import { SessionID } from "../../../src/session/schema"

describe("run budget control at prompt boundaries", () => {
  let publish: ReturnType<typeof spyOn<typeof Bus, "publish">>
  let priorDowngrade: string | undefined

  beforeEach(() => {
    priorDowngrade = process.env.ALTIMATE_RUN_BUDGET_EFFORT_DOWNGRADE
    delete process.env.ALTIMATE_RUN_BUDGET_EFFORT_DOWNGRADE
    publish = spyOn(Bus, "publish").mockImplementation(async () => {})
  })

  afterEach(() => {
    publish.mockRestore()
    if (priorDowngrade === undefined) delete process.env.ALTIMATE_RUN_BUDGET_EFFORT_DOWNGRADE
    else process.env.ALTIMATE_RUN_BUDGET_EFFORT_DOWNGRADE = priorDowngrade
  })

  for (const control of ["finalization", "finalization-no-downgrade"]) {
    for (const fails of [false, true]) {
      test(`${control} disables tools only until finalization ${fails ? "fails" : "completes"}`, async () => {
        const sessionID = SessionID.make(`ses_budget_control_${control}_${fails}`)
        const result = withBudgetControl({ sessionID, control }, async () => {
          expect(RunBudgetEffort.toolsDisabled(sessionID)).toBe(true)
          expect(RunBudgetEffort.effortOverride(sessionID)).toBe(control === "finalization")
          if (fails) throw new Error("provider failed")
          return "final answer"
        })
        if (fails) await expect(result).rejects.toThrow("provider failed")
        else expect(await result).toBe("final answer")
        expect(RunBudgetEffort.toolsDisabled(sessionID)).toBe(false)
        expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
        await withBudgetControl({ sessionID, control: "work" }, async () => {
          expect(RunBudgetEffort.toolsDisabled(sessionID)).toBe(false)
        })
      })
    }
  }

  test("the effort opt-out does not enable tools during finalization", async () => {
    const sessionID = SessionID.make("ses_budget_control_finalization_opt_out")
    process.env.ALTIMATE_RUN_BUDGET_EFFORT_DOWNGRADE = "0"
    await withBudgetControl({ sessionID, control: "finalization" }, async () => {
      expect(RunBudgetEffort.toolsDisabled(sessionID)).toBe(true)
      expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
    })
    expect(RunBudgetEffort.toolsDisabled(sessionID)).toBe(false)
  })

  test("downgrades before storing the nudge and interrupts only after it is stored", async () => {
    const sessionID = SessionID.make("ses_budget_control_order")
    const finishWork = Promise.withResolvers<string>()
    const storeNudge = Promise.withResolvers<void>()
    const nudgeStarted = Promise.withResolvers<void>()
    const order: string[] = []
    const unregister = RunBudget.registerGeneration(sessionID, () => order.push("interrupt"))
    const work = withBudgetControl({ sessionID, control: "work" }, () => finishWork.promise)
    try {
      expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
      const nudge = withBudgetControl({ sessionID, control: "soft", noReply: true }, async () => {
        expect(RunBudgetEffort.effortOverride(sessionID)).toBe(true)
        order.push("storing")
        nudgeStarted.resolve()
        await storeNudge.promise
        order.push("stored")
        return "saved nudge"
      })
      await nudgeStarted.promise
      expect(order).toEqual(["storing"])
      expect(publish).toHaveBeenCalledWith(RunBudgetEffort.EffortDowngraded, {
        sessionID,
        timestamp: expect.any(Number),
      })
      storeNudge.resolve()
      expect(await nudge).toBe("saved nudge")
      expect(order).toEqual(["storing", "stored", "interrupt"])
      expect(RunBudgetEffort.effortOverride(sessionID)).toBe(true)
    } finally {
      storeNudge.resolve()
      finishWork.resolve("answer")
      unregister()
      expect(await work).toBe("answer")
    }
    expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
    expect(RunBudgetEffort.downgradeEffort(sessionID)).toBeUndefined()
  })

  test("a finalization request re-arms low effort and clears it before the next run", async () => {
    const sessionID = SessionID.make("ses_budget_control_finalization")
    await withBudgetControl({ sessionID, control: "work" }, async () => "interrupted work")
    expect(RunBudgetEffort.downgradeEffort(sessionID)).toBeUndefined()
    const result = await withBudgetControl({ sessionID, control: "soft" }, async () => {
      expect(RunBudgetEffort.effortOverride(sessionID)).toBe(true)
      return "final answer"
    })
    expect(result).toBe("final answer")
    expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
    expect(RunBudgetEffort.downgradeEffort(sessionID)).toBeUndefined()
    await withBudgetControl({ sessionID, control: "work" }, async () => {
      expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
    })
  })

  test("failure to store a nudge never interrupts the active generation", async () => {
    const sessionID = SessionID.make("ses_budget_control_failed_nudge")
    const finishWork = Promise.withResolvers<void>()
    let interruptions = 0
    const unregister = RunBudget.registerGeneration(sessionID, () => interruptions++)
    const work = withBudgetControl({ sessionID, control: "work" }, () => finishWork.promise)
    try {
      await expect(
        withBudgetControl({ sessionID, control: "soft", noReply: true }, async () => {
          throw new Error("could not persist the reminder")
        }),
      ).rejects.toThrow("could not persist the reminder")
      expect(interruptions).toBe(0)
      expect(RunBudgetEffort.effortOverride(sessionID)).toBe(true)
    } finally {
      finishWork.resolve()
      unregister()
      await work
    }
    expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
  })

  for (const control of ["soft", "soft-no-downgrade"]) {
    test(`${control} respects the effort opt-out while still interrupting the saved reminder`, async () => {
      const sessionID = SessionID.make(`ses_budget_control_opt_out_${control}`)
      if (control === "soft") process.env.ALTIMATE_RUN_BUDGET_EFFORT_DOWNGRADE = "0"
      const finishWork = Promise.withResolvers<void>()
      let interruptions = 0
      const unregister = RunBudget.registerGeneration(sessionID, () => interruptions++)
      const work = withBudgetControl({ sessionID, control: "work" }, () => finishWork.promise)
      try {
        await withBudgetControl({ sessionID, control, noReply: true }, async () => {
          expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
          expect(interruptions).toBe(0)
        })
        expect(interruptions).toBe(1)
        expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
        expect(publish).not.toHaveBeenCalled()
      } finally {
        finishWork.resolve()
        unregister()
        await work
      }
      expect(RunBudgetEffort.downgradeEffort(sessionID)).toBeUndefined()
    })
  }

  test("a failed finalization releases its effort override", async () => {
    const sessionID = SessionID.make("ses_budget_control_failed_finalization")
    await expect(
      withBudgetControl({ sessionID, control: "soft" }, async () => {
        expect(RunBudgetEffort.effortOverride(sessionID)).toBe(true)
        throw new Error("provider failed")
      }),
    ).rejects.toThrow("provider failed")
    expect(RunBudgetEffort.effortOverride(sessionID)).toBe(false)
    expect(RunBudgetEffort.downgradeEffort(sessionID)).toBeUndefined()
  })
})
// altimate_change end
