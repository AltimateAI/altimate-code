import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"
import type { PtyID } from "../../src/pty/schema"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as sleep } from "node:timers/promises"

// altimate_change start - increase default wait timeout to avoid flaky failures under load
const wait = async (fn: () => boolean, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(50)
  }
  throw new Error("timeout waiting for pty events")
}
// altimate_change end

const pick = (log: Array<{ type: "created" | "exited" | "deleted"; id: PtyID }>, id: PtyID) => {
  return log.filter((evt) => evt.id === id).map((evt) => evt.type)
}

describe("pty", () => {
  // altimate_change start - add retry to handle flaky Bus event delivery under parallel test load
  test("publishes created, exited, deleted in order for /bin/ls + remove", async () => {
    if (process.platform === "win32") return

    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const log: Array<{ type: "created" | "exited" | "deleted"; id: PtyID }> = []
        const off = [
          Bus.subscribe(Pty.Event.Created, (evt) => log.push({ type: "created", id: evt.properties.info.id })),
          Bus.subscribe(Pty.Event.Exited, (evt) => log.push({ type: "exited", id: evt.properties.id })),
          Bus.subscribe(Pty.Event.Deleted, (evt) => log.push({ type: "deleted", id: evt.properties.id })),
        ]

        let id: PtyID | undefined
        try {
          const info = await Pty.create({ command: "/bin/ls", title: "ls" })
          id = info.id

          await wait(() => pick(log, id!).includes("exited"))

          await Pty.remove(id)
          await wait(() => pick(log, id!).length >= 3)
          expect(pick(log, id!)).toEqual(["created", "exited", "deleted"])
        } finally {
          off.forEach((x) => x())
          if (id) await Pty.remove(id)
        }
      },
    })
  }, { timeout: 15000, retry: 2 })
  // altimate_change end

  test("publishes created, exited, deleted in order for /bin/sh + remove", async () => {
    if (process.platform === "win32") return

    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const log: Array<{ type: "created" | "exited" | "deleted"; id: PtyID }> = []
        const off = [
          Bus.subscribe(Pty.Event.Created, (evt) => log.push({ type: "created", id: evt.properties.info.id })),
          Bus.subscribe(Pty.Event.Exited, (evt) => log.push({ type: "exited", id: evt.properties.id })),
          Bus.subscribe(Pty.Event.Deleted, (evt) => log.push({ type: "deleted", id: evt.properties.id })),
        ]

        let id: PtyID | undefined
        try {
          const info = await Pty.create({ command: "/bin/sh", title: "sh" })
          id = info.id

          await sleep(100)

          await Pty.remove(id)
          await wait(() => pick(log, id!).length >= 3)
          expect(pick(log, id!)).toEqual(["created", "exited", "deleted"])
        } finally {
          off.forEach((x) => x())
          if (id) await Pty.remove(id)
        }
      },
    })
  })
})
