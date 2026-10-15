// altimate: ALT-F02
import assert from "node:assert/strict"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { ConfigProvider, useConfig, type Config } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { LocalProvider } from "../../src/context/local"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { AttentionProvider } from "../../src/context/attention"
import { StorageProvider } from "../../src/context/storage"
import { SessionTabsProvider } from "../../src/context/session-tabs"
import { PromptRefProvider } from "../../src/context/prompt"
import { TuiAppProvider, TuiLifecycleProvider } from "../../src/context/runtime"
import { ToastProvider, useToast } from "../../src/ui/toast"
import { DialogProvider } from "../../src/ui/dialog"
import { PluginProvider, usePlugin } from "../../src/plugin/context"
import { tmpdir } from "./fixture"
import { createApi, createEventStream, createFetch } from "./tui-client"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"

const scenario = process.argv[2]
if (scenario !== "stock") await import("../../../altimate/script/identity-preload")
if (scenario === "throw" || scenario === "load-throw") {
  // Exercise the same build/preload boundary with an intentionally broken distribution entry.
  globalThis.__OPENCODE_HOST_PLUGINS__ = {
    server: [],
    tui: [
      {
        id: "altimate",
        protected: true,
        plugin: async () => {
          if (scenario === "load-throw") throw new Error("intentional Altimate load failure")
          return {
            default: {
              id: "altimate",
              setup() {
                throw new Error("intentional Altimate setup failure")
              },
            },
          }
        },
      },
    ],
  }
}
await using temporary = await tmpdir()
const duplicate = path.join(temporary.path, "tui.ts")
await Bun.write(duplicate, 'export default { id: "altimate", setup() { throw new Error("replacement executed") } }')
await Bun.write(
  path.join(temporary.path, "additional", "tui.ts"),
  'export default { id: "fixture.additional", setup() {} }',
)
let plugins!: ReturnType<typeof usePlugin>
let config!: ReturnType<typeof useConfig>
let toast!: ReturnType<typeof useToast>
let commands!: ReturnType<typeof Keymap.useState>
const logs: string[] = []
const finalizers = new Set<() => Promise<void>>()
const info: { current: Config.Info } = { current: {} }
const events = createEventStream()
const transport = createFetch(undefined, events)
const lifecycle = {
  add(finalizer: () => Promise<void>) {
    finalizers.add(finalizer)
    return () => finalizers.delete(finalizer)
  },
}
function Probe() {
  plugins = usePlugin()
  config = useConfig()
  toast = useToast()
  commands = Keymap.useState()
  return <box />
}
const output = await testRender(
  () => (
    <TestTuiContexts
      directory={temporary.path}
      paths={{ home: temporary.path, state: temporary.path }}
      log={(_, message) => {
        logs.push(message)
      }}
    >
      <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
        <TuiLifecycleProvider value={lifecycle}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider
                config={createTuiResolvedConfig()}
                service={{
                  get: async () => info.current,
                  update: async (update) => {
                    update(info.current)
                    return info.current
                  },
                }}
              >
                <Keymap.Provider>
                  <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                    <ToastProvider>
                      <RouteProvider initialRoute={{ type: "home" }}>
                        <ClientProvider api={createApi(transport.fetch)}>
                          <DataProvider directory={temporary.path}>
                            <LocationProvider>
                              <PermissionProvider>
                                <LocalProvider>
                                  <SessionTabsProvider>
                                    <DialogProvider>
                                      <PromptRefProvider>
                                        <AttentionProvider>
                                          <PluginProvider
                                            directories={[]}
                                            packages={{
                                              prepare: async (target) => ({
                                                directory:
                                                  target === "additional-fixture"
                                                    ? path.join(temporary.path, "additional")
                                                    : temporary.path,
                                              }),
                                            }}
                                          >
                                            <Probe />
                                          </PluginProvider>
                                        </AttentionProvider>
                                      </PromptRefProvider>
                                    </DialogProvider>
                                  </SessionTabsProvider>
                                </LocalProvider>
                              </PermissionProvider>
                            </LocationProvider>
                          </DataProvider>
                        </ClientProvider>
                      </RouteProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiLifecycleProvider>
      </TuiAppProvider>
    </TestTuiContexts>
  ),
  { width: 80, height: 20, kittyKeyboard: true },
)

try {
  await waitFor(() => plugins?.ready())
  const active = () =>
    plugins.registered().some((entry) => entry.id === "altimate" && entry.source === "builtin" && entry.active)
  if (scenario === "stock") {
    assert.equal(
      plugins.registered().some((entry) => entry.id === "altimate"),
      false,
    )
  } else if (scenario === "throw" || scenario === "load-throw") {
    assert.equal(active(), false)
    assert.match(toast.currentToast?.message ?? "", /Protected host TUI plugin "altimate" failed/)
    assert.match(toast.currentToast?.message ?? "", /intentional Altimate (setup|load) failure/)
    assert(logs.includes("TUI plugin bootstrap failed"))
  } else {
    assert.equal(active(), true)
    assert(commands.commands().some((command) => command.id === "altimate.warehouse"))
    await assert.rejects(plugins.deactivate("altimate"), /Cannot disable protected host plugin: altimate/)
    assert.equal(active(), true)
    for (const selector of ["-altimate", "-*", "-altimate.*"]) {
      const completed = logs.filter((line) => line === "plugin reconciliation completed").length
      await config.update((draft) => {
        draft.plugins = [selector]
      })
      await waitFor(() => logs.filter((line) => line === "plugin reconciliation completed").length > completed)
      assert.equal(active(), true)
    }
    await config.update((draft) => {
      draft.plugins = ["duplicate-fixture"]
    })
    await waitFor(() => plugins.list().some((entry) => entry.status === "failed"))
    assert(
      plugins
        .list()
        .some(
          (entry) =>
            entry.status === "failed" && entry.error.includes("Cannot replace protected host plugin: altimate"),
        ),
    )
    assert.equal(active(), true)
    assert(commands.commands().some((command) => command.id === "altimate.warehouse"))
    await config.update((draft) => {
      draft.plugins = ["additional-fixture"]
    })
    await waitFor(() => plugins.registered().some((entry) => entry.id === "fixture.additional" && entry.active))
    assert.equal(active(), true)
    assert(commands.commands().some((command) => command.id === "altimate.warehouse"))
    const completed = logs.filter((line) => line === "plugin reconciliation completed").length
    await config.update((draft) => {
      draft.plugins = []
    })
    await waitFor(() => logs.filter((line) => line === "plugin reconciliation completed").length > completed)
    assert.equal(active(), true)
  }
  process.stdout.write(`H2 TUI ${scenario}: PASS\n`)
} catch (error) {
  process.stderr.write(JSON.stringify({ logs, states: plugins?.list(), registered: plugins?.registered() }) + "\n")
  throw error
} finally {
  await Promise.all([...finalizers].map((finalizer) => finalizer()))
  output.renderer.destroy()
  events.disconnect()
}

async function waitFor(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 10_000) throw new Error("TUI plugin operation timed out")
    await Bun.sleep(10)
  }
}
