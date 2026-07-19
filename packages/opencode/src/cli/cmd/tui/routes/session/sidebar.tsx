import { useSync } from "@tui/context/sync"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"
import path from "path"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { useKeybind } from "../../context/keybind"
import { TodoItem } from "../../component/todo-item"
// altimate_change — community/docs links: plain copyable text, underlined for
// affordance; clicking the line opens the browser. (OSC-8 word-links are not
// supported by the current @opentui/solid JSX layer — raw TextChunk children crash.)
import open from "open"
// altimate_change start - trace section
// altimate_change end

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const [expanded, setExpanded] = createStore({
    diff: true,
    todo: true,
  })

  const cost = createMemo(() => {
    const total = messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  // altimate_change — light dotted divider between sidebar sections
  const Dotted = () => <text fg={theme.border}>┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄</text>

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        // altimate_change — subtle left edge to separate the panel from the main area
        border={["left"]}
        borderColor={theme.border}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <box>
              <text fg={theme.text}>
                <b>Context</b>
              </text>
              <text fg={theme.textMuted}>{context()?.tokens ?? 0} tokens</text>
              <text fg={theme.textMuted}>{context()?.percentage ?? 0}% used</text>
              <text fg={theme.textMuted}>{cost()} spent</text>
            </box>
            <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
                >
                  <Show when={todo().length > 2}>
                    <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Todo</b>
                  </text>
                </box>
                <Show when={todo().length <= 2 || expanded.todo}>
                  <For each={todo()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
                </Show>
              </box>
            </Show>
            <Show when={diff().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
                >
                  <Show when={diff().length > 2}>
                    <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Modified Files</b>
                  </text>
                </box>
                <Show when={diff().length <= 2 || expanded.diff}>
                  <For each={diff() || []}>
                    {(item) => {
                      return (
                        <box flexDirection="row" gap={1} justifyContent="space-between">
                          <text fg={theme.textMuted} wrapMode="none">
                            {item.file}
                          </text>
                          <box flexDirection="row" gap={1} flexShrink={0}>
                            <Show when={item.additions}>
                              <text fg={theme.diffAdded}>+{item.additions}</text>
                            </Show>
                            <Show when={item.deletions}>
                              <text fg={theme.diffRemoved}>-{item.deletions}</text>
                            </Show>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </box>
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          {/* altimate_change start — reference/help anchored to the bottom of the
              panel (runtime status stays up top in the scroll area). JTBD first,
              then community/docs, then branding last. */}
          <box gap={1}>
            <box>
              <text fg={theme.text}>
                <b>HERE'S WHAT YOU CAN DO</b>
              </text>
              <text fg={theme.textMuted}>• Build &amp; ship dbt pipelines</text>
              <text fg={theme.textMuted}>• Migrate legacy SQL to dbt</text>
              <text fg={theme.textMuted}>• Optimize warehouse cost &amp; speed</text>
              <text fg={theme.textMuted}>• Debug &amp; monitor your warehouse</text>
              <text fg={theme.textMuted}>• Govern data: lineage, PII, tests</text>
            </box>
          </box>
          <Dotted />
          <box gap={1}>
            <text fg={theme.textMuted} wrapMode="word" width="100%">
              Ideas or issues? Join the community.
            </text>
            <text
              wrapMode="word"
              width="100%"
              onMouseUp={() => open("https://altimate.studio/join-agentic-data-engineering-slack").catch(() => {})}
            >
              <span style={{ fg: theme.textMuted }}>Community · </span>
              <span style={{ fg: theme.accent, underline: true }}>altimate.studio/join-agentic-data-engineering-slack</span>
            </text>
            <text
              wrapMode="word"
              width="100%"
              onMouseUp={() => open("https://help.altimate.ai/code/").catch(() => {})}
            >
              <span style={{ fg: theme.textMuted }}>Docs · </span>
              <span style={{ fg: theme.accent, underline: true }}>help.altimate.ai/code</span>
            </text>
          </box>
          {/* altimate_change end */}
          <Dotted />
          {/* altimate_change start — sidebar branding */}
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Altimate</b>
            <span style={{ fg: theme.text }}>
              <b> Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
          {/* altimate_change end */}
        </box>
      </box>
    </Show>
  )
}
