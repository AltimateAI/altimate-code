import { expect, test } from "bun:test"
import path from "node:path"
import descriptor from "../../../altimate/identity.json"
import { context, render } from "../fixture/sidebar-footer"

test("sidebar waits for integrations before showing onboarding", async () => {
  const app = await render(context())

  try {
    expect(app.captureCharFrame()).not.toContain("Getting started")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar preserves the compact layout when the onboarding card cannot fit", async () => {
  const app = await render(context({ integrations: [] }), 21)

  try {
    expect(app.captureCharFrame()).not.toContain("Getting started")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar shows onboarding without a connected integration", async () => {
  const app = await render(context({ integrations: [] }))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Getting started")
    expect(frame).toContain("OpenCode includes free models")
    expect(frame).toContain("Connect provider")
    expect(frame).toContain("/connect")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar hides onboarding after an integration is connected or the card is dismissed", async () => {
  const connected = await render(context({ integrations: [{ connections: [{}] }] }))
  const dismissed = await render(context({ integrations: [], dismissed: true }))

  try {
    expect(connected.captureCharFrame()).not.toContain("Getting started")
    expect(dismissed.captureCharFrame()).not.toContain("Getting started")
  } finally {
    connected.renderer.destroy()
    dismissed.renderer.destroy()
  }
})

test("sidebar onboarding opens integrations and can be dismissed", async () => {
  const dispatched: string[] = []
  const app = await render(context({ integrations: [], dispatched }))

  try {
    const connect = app.renderer.root.findDescendantById("sidebar.footer.getting-started.connect")!
    await app.mockMouse.click(connect.x, connect.y)
    expect(dispatched).toEqual(["provider.connect"])

    const dismiss = app.renderer.root.findDescendantById("sidebar.footer.getting-started.dismiss")!
    await app.mockMouse.click(dismiss.x, dismiss.y)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Getting started")
  } finally {
    app.renderer.destroy()
  }
})

test("branded onboarding copy replaces the OpenCode free-model text", async () => {
  const dispatched: string[] = []
  const app = await render(context({ integrations: [], dispatched }), 22, {
    lines: ["Connect your Altimate account to start."],
    connect: "Connect Altimate",
  })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Getting started")
    expect(frame).toContain("Connect your Altimate account")
    expect(frame).toContain("Connect Altimate")
    expect(frame).toContain("/connect")
    expect(frame).not.toContain("free models")
    expect(frame).not.toContain("OpenCode")
    const connect = app.renderer.root.findDescendantById("sidebar.footer.getting-started.connect")!
    await app.mockMouse.click(connect.x, connect.y)
    expect(dispatched).toEqual(["provider.connect"])
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar resolves branded onboarding through the host identity descriptor", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "../../../altimate/script/identity-preload.ts"),
      path.join(import.meta.dir, "../fixture/sidebar-footer.tsx"),
    ],
    { cwd: path.join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr).toBe(0)
  const output = JSON.parse(stdout) as { frame: string; dispatched: string[] }
  const frame = output.frame.replace(/\s+/g, " ")
  for (const line of descriptor.onboarding.lines) expect(frame).toContain(line)
  expect(frame).toContain(descriptor.onboarding.connect)
  expect(frame).toContain("/connect")
  expect(frame).not.toContain("free models")
  expect(frame).not.toContain("OpenCode")
  expect(output.dispatched).toEqual(["provider.connect"])
}, 30_000)
