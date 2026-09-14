// altimate_change start — upstream_fix: pin the override's assignability to the base.
import { describe, expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

describe("GlobalBusEmitter.emit", () => {
  // The regression this guards is a COMPILE error, not a runtime one: a lone
  // `(eventName: "event", event: GlobalEvent)` override is not assignable to
  // the base `EventEmitter<T>` overload set, which newer `@types/node` rejects
  // with "Type 'any[]' is not assignable to type '[event: GlobalEvent]'". That
  // failed `bun typecheck`, and so blocked `git push` via the pre-push hook, on
  // code nobody had touched. This assignment only compiles while the override
  // keeps the wide implementation signature, so `tsgo` fails if it is narrowed
  // again — the test body below merely keeps the reference alive.
  test("stays assignable to the base EventEmitter signature", () => {
    const wide: (eventName: string | symbol, ...args: any[]) => boolean = GlobalBus.emit.bind(GlobalBus)
    expect(typeof wide).toBe("function")
  })

  test("stamps an id onto a payload that has none", () => {
    const seen: GlobalEvent[] = []
    const on = (event: GlobalEvent) => void seen.push(event)
    GlobalBus.on("event", on)
    try {
      GlobalBus.emit("event", { payload: { kind: "test" } })
      expect(seen).toHaveLength(1)
      expect(typeof seen[0]!.payload.id).toBe("string")
      expect(seen[0]!.payload.id).toStartWith("evt")
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("leaves an existing id alone", () => {
    const seen: GlobalEvent[] = []
    const on = (event: GlobalEvent) => void seen.push(event)
    GlobalBus.on("event", on)
    try {
      GlobalBus.emit("event", { payload: { id: "evt_already_set" } })
      expect(seen[0]!.payload.id).toBe("evt_already_set")
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("prefers the syncEvent id when the payload has none", () => {
    const seen: GlobalEvent[] = []
    const on = (event: GlobalEvent) => void seen.push(event)
    GlobalBus.on("event", on)
    try {
      GlobalBus.emit("event", { payload: { syncEvent: { id: "evt_from_sync" } } })
      expect(seen[0]!.payload.id).toBe("evt_from_sync")
    } finally {
      GlobalBus.off("event", on)
    }
  })
})
// altimate_change end
