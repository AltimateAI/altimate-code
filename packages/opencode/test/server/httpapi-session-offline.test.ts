// altimate_change - new file
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Database, eq } from "../../src/storage/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

describe("session HttpApi offline", () => {
  it.instance("declares the offline refusals for delete, share and unshare as 400s", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const created = yield* requestInDirectory("/session", tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      const session = (yield* created.json) as { id: string }
      const previous = process.env.ALTIMATE_OFFLINE
      process.env.ALTIMATE_OFFLINE = "1"
      try {
        for (const method of ["POST", "DELETE"]) {
          const response = yield* requestInDirectory(`/session/${session.id}/share`, tmp.directory, { method })
          expect({ method, status: response.status }).toEqual({ method, status: 400 })
          expect(yield* response.json).toMatchObject({ _tag: "Session.OfflinePolicyError", message: expect.stringContaining("online") })
        }
        Database.use((db) =>
          db.update(SessionTable).set({ share_url: "https://share.example/s/3" }).where(eq(SessionTable.id, session.id as any)).run(),
        )
        const removed = yield* requestInDirectory(`/session/${session.id}`, tmp.directory, { method: "DELETE" })
        expect(removed.status).toBe(400)
        expect(yield* removed.json).toMatchObject({ _tag: "Session.OfflinePolicyError", message: expect.stringContaining("shared") })
      } finally {
        if (previous === undefined) delete process.env.ALTIMATE_OFFLINE
        else process.env.ALTIMATE_OFFLINE = previous
      }
    }),
  )
})
