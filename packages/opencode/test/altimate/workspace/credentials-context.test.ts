import { expect, test } from "bun:test"
import { AltimateApi } from "../../../src/altimate/api/client"
import { currentCredentials, withCredentials } from "../../../src/altimate/api/credentials-context"

test("workspace requests pin credentials across awaits without changing concurrent callers", async () => {
  const first = { altimateUrl: "https://one.invalid", altimateInstanceName: "one", altimateApiKey: "test-one" }
  const second = { altimateUrl: "https://two.invalid", altimateInstanceName: "two", altimateApiKey: "test-two" }
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = withCredentials(first, async () => {
    expect(await AltimateApi.getCredentials()).toEqual(first)
    await gate
    expect(await AltimateApi.getCredentials()).toEqual(first)
    expect(await AltimateApi.isConfigured()).toBe(true)
  })
  await withCredentials(second, async () => {
    expect(await AltimateApi.getCredentials()).toEqual(second)
    release()
    await pending
    expect(await AltimateApi.getCredentials()).toEqual(second)
  })
  expect(currentCredentials()).toBeUndefined()
})

test("a cold external workspace import does not depend on the TUI's import order", async () => {
  const process = Bun.spawn(
    [
      Bun.which("bun")!,
      "--conditions=browser",
      "-e",
      "await import('./src/altimate/workspace/client.ts'); console.log('loaded')",
    ],
    {
      cwd: new URL("../../../", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdout = await new Response(process.stdout).text()
  const stderr = await new Response(process.stderr).text()
  expect(await process.exited).toBe(0)
  expect(stderr).not.toContain("before initialization")
  expect(stdout).toContain("loaded")
})
