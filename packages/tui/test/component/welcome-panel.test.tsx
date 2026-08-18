/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { resetSetupComplete } from "../../src/component/altimate-onboarding"
import { WelcomePanel } from "../../src/component/welcome-panel"
import { TuiConfigProvider } from "../../src/config"
import { FULL_MIN_HEIGHT, FULL_MIN_WIDTH, MEDIUM_MIN_WIDTH } from "../../src/component/welcome-panel-utils"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"

// Render the REAL WelcomePanel through the routes' variant sizing and assert the
// rendered content per variant — the piece the pure welcomePanelVariant unit test
// can't cover (that the .tsx Switch actually renders the right box for a variant).
// Sizing is driven by the availableWidth/availableHeight props exactly as the
// routes pass them; the canvas is generous so content is captured without clipping.
async function renderPanel(availableWidth: number, availableHeight: number) {
  resetSetupComplete() // ready() = false → deterministic (unconnected: shows the connect CTA)
  const calls = createFetch()
  const source = createEventSource()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ExitProvider exit={() => {}}>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            <ArgsProvider>
              <KVProvider>
                <ToastProvider>
                  <RouteProvider>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={source.source}>
                      <ProjectProvider>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <WelcomePanel availableWidth={availableWidth} availableHeight={availableHeight} />
                          </ThemeProvider>
                        </SyncProvider>
                      </ProjectProvider>
                    </SDKProvider>
                  </RouteProvider>
                </ToastProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </ExitProvider>
      </TestTuiContexts>
    ),
    { width: 160, height: 40 },
  )
  await app.renderOnce()
  await new Promise((resolve) => setTimeout(resolve, 25))
  await app.renderOnce()
  let frame = app.captureCharFrame()
  for (let attempt = 0; attempt < 5 && frame.trim().length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    await app.renderOnce()
    frame = app.captureCharFrame()
  }
  return { app, frame }
}

// Own the renderer per test and destroy it in the same test's finally (plus reset
// onboarding state), so nothing leaks between tests or races under parallel bun test.
async function withPanel(width: number, height: number, check: (frame: string) => void) {
  const { app, frame } = await renderPanel(width, height)
  try {
    check(frame)
  } finally {
    app.renderer.destroy()
    resetSetupComplete()
  }
}

test("full variant renders the wordmark + what-is section at a large available size", async () => {
  await withPanel(FULL_MIN_WIDTH, FULL_MIN_HEIGHT, (frame) => {
    // "What is Altimate Code" is unique to the full two-column box.
    expect(frame).toContain("What is Altimate Code")
  })
})

test("medium variant renders the condensed line (no what-is section) below the full width floor", async () => {
  await withPanel(FULL_MIN_WIDTH - 1, FULL_MIN_HEIGHT, (frame) => {
    expect(frame).toContain("Gives your AI real context")
    expect(frame).not.toContain("What is Altimate Code")
  })
})

test("compact variant renders a single line below the medium width floor", async () => {
  await withPanel(MEDIUM_MIN_WIDTH - 1, FULL_MIN_HEIGHT, (frame) => {
    // Unconnected → the connect CTA; neither the medium nor full body is present.
    expect(frame).toContain("Connect your AI model to start")
    expect(frame).not.toContain("Gives your AI real context")
    expect(frame).not.toContain("What is Altimate Code")
  })
})
