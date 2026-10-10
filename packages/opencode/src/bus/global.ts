import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  // altimate_change start — upstream_fix: keep the override assignable to the base.
  // `EventEmitter<T>` declares `emit` across several overloads, one of which is
  // `(eventName: string | symbol, ...args: any[])`. An override has to be
  // assignable to all of them, and a lone `(eventName: "event", event:
  // GlobalEvent)` is not — newer `@types/node` rejects it with "Type 'any[]' is
  // not assignable to type '[event: GlobalEvent]'", which fails `bun typecheck`
  // and so blocks `git push` on unmodified code. The public overload keeps call
  // sites typed; the implementation signature is what satisfies the base.
  override emit(eventName: "event", event: GlobalEvent): boolean
  override emit(eventName: string | symbol, ...args: any[]): boolean
  override emit(eventName: string | symbol, ...args: any[]): boolean {
    const event = args[0] as GlobalEvent | undefined
    if (eventName === "event" && event?.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName as "event", ...(args as [GlobalEvent]))
  }
  // altimate_change end
}

export const GlobalBus = new GlobalBusEmitter()
