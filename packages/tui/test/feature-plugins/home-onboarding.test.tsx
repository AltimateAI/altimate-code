/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Flock } from "@opencode-ai/core/util/flock"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, spyOn, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import type { ParentProps } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { Tips } from "../../src/feature-plugins/home/tips-view"
import { formatKeyBindings, formatKeySequence, OpencodeKeymapProvider } from "../../src/keymap"
import { HomeFirstTimeOnboardingHint } from "../../src/routes/home"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const TEST_STATE = "/tmp/altimate-code-tui-home-onboarding-test/state"

mkdirSync(TEST_STATE, { recursive: true })
writeFileSync(`${TEST_STATE}/kv.json`, "{}")
Flock.setGlobal({ state: TEST_STATE })

function ThemeHarness(props: ParentProps) {
  const config = createTuiResolvedConfig()

  return (
    <TestTuiContexts paths={{ state: TEST_STATE }}>
      <TuiConfigProvider config={config}>
        <KVProvider>
          <ThemeProvider mode="dark">
            <box width="100%" height={4}>
              {props.children}
            </box>
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

function TipsHarness(props: { isFirstTime: boolean; connected: boolean }) {
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const keys: TuiPluginApi["keys"] = {
    formatSequence: (parts) => formatKeySequence(parts, config),
    formatBindings: (bindings) => formatKeyBindings(bindings, config),
  }
  const api = {
    ...createTuiPluginApi({ keymap }),
    keymap,
    keys,
    tuiConfig: config,
  } as TuiPluginApi

  return (
    <TestTuiContexts paths={{ state: TEST_STATE }}>
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <box width="100%" height={4}>
                <Tips api={api} connected={props.connected} isFirstTime={props.isFirstTime} />
              </box>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

async function renderOnceSettled(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await new Promise((resolve) => setTimeout(resolve, 25))
  await app.renderOnce()
}

async function captureSettledFrame(app: Awaited<ReturnType<typeof testRender>>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const frame = app.captureCharFrame()
    if (frame.trim().length > 0) return frame
    await new Promise((resolve) => setTimeout(resolve, 25))
    await app.renderOnce()
  }
  return app.captureCharFrame()
}

test("home onboarding hint renders only for first-time users", async () => {
  const firstTime = await testRender(
    () => (
      <ThemeHarness>
        <HomeFirstTimeOnboardingHint isFirstTime={true} />
      </ThemeHarness>
    ),
    { width: 120, height: 4 },
  )
  const returning = await testRender(
    () => (
      <ThemeHarness>
        <HomeFirstTimeOnboardingHint isFirstTime={false} />
      </ThemeHarness>
    ),
    { width: 120, height: 4 },
  )

  try {
    await renderOnceSettled(firstTime)
    await renderOnceSettled(returning)

    const firstTimeFrame = await captureSettledFrame(firstTime)
    const returningFrame = await captureSettledFrame(returning)

    expect(firstTimeFrame).toContain("Get started:")
    expect(firstTimeFrame).toContain("/connect")
    expect(firstTimeFrame).toContain("/discover")
    expect(firstTimeFrame).toContain("Ctrl+P")
    expect(returningFrame).not.toContain("Get started:")
  } finally {
    firstTime.renderer.destroy()
    returning.renderer.destroy()
  }
})

test("tips use beginner pool only for first-time users", async () => {
  const random = spyOn(Math, "random").mockReturnValue(0)

  try {
    const firstTime = await testRender(() => <TipsHarness isFirstTime={true} connected={false} />, {
      width: 120,
      height: 4,
    })
    const returning = await testRender(() => <TipsHarness isFirstTime={false} connected={false} />, {
      width: 120,
      height: 4,
    })

    try {
      await renderOnceSettled(firstTime)
      await renderOnceSettled(returning)

      const firstTimeFrame = await captureSettledFrame(firstTime)
      const returningFrame = await captureSettledFrame(returning)

      expect(firstTimeFrame).toContain("add your API key and get started")
      expect(returningFrame).not.toContain("add your API key and get started")
      expect(returningFrame).toContain("add an AI provider")
    } finally {
      firstTime.renderer.destroy()
      returning.renderer.destroy()
    }
  } finally {
    random.mockRestore()
  }
})
