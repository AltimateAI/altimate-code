import { describe, expect, test } from "bun:test"

import { pickPort } from "../../src/local/server"

describe("local server port selection", () => {
  test("asks the OS for a free loopback port", async () => {
    const requested: number[] = []
    const port = await pickPort(0, async (candidate) => {
      requested.push(candidate)
      return 43123
    })
    expect(requested).toEqual([0])
    expect(port).toBe(43123)
  })

  test("auto-picks the next candidate when the preferred port is occupied", async () => {
    const requested: number[] = []
    const selected = await pickPort(8080, async (candidate) => {
      requested.push(candidate)
      if (candidate === 8080) throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" })
      return candidate === 0 ? 43124 : candidate
    })
    expect(requested[0]).toBe(8080)
    expect(selected).toBe(8081)
  })

  test("skips a port that binds but already answers HTTP (SO_REUSEPORT shadow)", async () => {
    const probed: number[] = []
    const selected = await pickPort(
      9000,
      async (candidate) => (candidate === 0 ? 43125 : candidate),
      async (port) => {
        probed.push(port)
        return port === 9000
      },
    )
    expect(probed[0]).toBe(9000)
    expect(selected).toBe(9001)
  })
})
