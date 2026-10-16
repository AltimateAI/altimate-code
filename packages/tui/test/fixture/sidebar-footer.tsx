/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createStore, produce } from "solid-js/store"
import { SidebarOnboarding } from "../../src/feature-plugins/sidebar/footer"

export function context(options?: {
  dismissed?: boolean
  integrations?: Array<{ connections: unknown[] }>
  dispatched?: string[]
}) {
  const color = RGBA.fromInts(200, 200, 200)
  const [onboarding, setOnboarding] = createStore({ dismissed: options?.dismissed ?? false })
  const location = { directory: "/workspace" }
  return {
    location,
    theme: {
      background: { raised: { high: color } },
      text: { base: color, muted: color },
    },
    storage: {
      store: () => [
        onboarding,
        (mutation: (draft: { dismissed: boolean }) => void) => {
          setOnboarding(produce(mutation))
          return Promise.resolve()
        },
      ],
    },
    keymap: {
      dispatch: (id: string) => options?.dispatched?.push(id),
    },
    ui: {
      format: { path: (value: string) => value },
    },
    data: {
      session: {
        get: () => ({ location }),
      },
      location: {
        integration: { list: () => options?.integrations },
        vcs: { info: () => undefined },
      },
    },
  } as unknown as Context
}

export async function render(input: Context, height = 22, copy?: { lines: string[]; connect: string }) {
  const app = await testRender(
    () => (
      <box width={38}>
        <SidebarOnboarding context={input} sessionID="session" copy={copy} />
      </box>
    ),
    { width: 38, height },
  )
  await app.renderOnce()
  return app
}

if (import.meta.main) {
  const dispatched: string[] = []
  const app = await render(context({ integrations: [], dispatched }))
  try {
    const frame = app.captureCharFrame()
    const connect = app.renderer.root.findDescendantById("sidebar.footer.getting-started.connect")!
    await app.mockMouse.click(connect.x, connect.y)
    process.stdout.write(JSON.stringify({ frame, dispatched }) + "\n")
  } finally {
    app.renderer.destroy()
  }
}
