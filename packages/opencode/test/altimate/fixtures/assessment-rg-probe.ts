import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { Effect } from "effect"
const out = await Effect.runPromise(
  Effect.gen(function* () { const s = yield* RipgrepBinary.Service; return yield* s.filepath }).pipe(Effect.provide(RipgrepBinary.defaultLayer), Effect.result),
)
console.log(JSON.stringify({ ok: out._tag === "Success", text: String((out as any).failure ?? (out as any).success).slice(0, 200) }))
