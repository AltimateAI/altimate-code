import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
// altimate_change start - yolo mode + smooth streaming
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Yolo from "../util/yolo"
// altimate_change end

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      // altimate_change start - yolo mode: per-session override, keyed by ROOT session.
      // Absent = inherit the process-wide Flag.ALTIMATE_CLI_YOLO default (set by --yolo);
      // present = explicit user choice for this session, which can turn a globally
      // enabled yolo back off. Deliberately in-memory only: yolo must never survive a
      // restart, or resuming an old session would silently reinstate it.
      yolo: {
        [sessionID: string]: boolean
      }
      // Choice made on the welcome screen, before any session exists. Adopted by the
      // first session created and then cleared, so it does NOT become a process-wide
      // default that silently yolos every later session ("current session only").
      yolo_pending: boolean | undefined
      // altimate_change end
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      // altimate_change start (AI-7519) — active pre-first-visible phase per session,
      // e.g. "bootstrap.resolve-tools". Populated by session.phase events from the
      // backend; consumed by the prompt status renderer to show an honest label.
      session_phase: {
        [sessionID: string]: string | undefined
      }
      // altimate_change end
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      // altimate_change start — yolo mode: per-session override map (see type above)
      yolo: {},
      yolo_pending: undefined,
      // altimate_change end
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      // altimate_change start (AI-7519)
      session_phase: {},
      // altimate_change end
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string> }>()
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    // altimate_change start - line streaming: buffer deltas, flush only on \n or message completion
    const lineBuffer = new Map<string, string>()

    function flushLineBuffer(messageID: string, partID: string, field: string, forceAll: boolean) {
      const key = `${messageID}:${partID}:${field}`
      const buffer = lineBuffer.get(key)
      if (!buffer) return
      let textToFlush: string
      if (forceAll) {
        textToFlush = buffer
        lineBuffer.delete(key)
      } else {
        const lastNewline = buffer.lastIndexOf("\n")
        if (lastNewline === -1) return
        textToFlush = buffer.slice(0, lastNewline + 1)
        const remainder = buffer.slice(lastNewline + 1)
        if (remainder) lineBuffer.set(key, remainder)
        else lineBuffer.delete(key)
      }
      if (!textToFlush) return
      const parts = store.part[messageID]
      if (!parts) return
      const result = search(parts, partID, (p) => p.id)
      if (!result.found) return
      const existing = parts[result.index][field as keyof (typeof parts)[number]] as string | undefined
      setStore("part", messageID, result.index, field as any, ((existing ?? "") + textToFlush) as any)
    }

    function flushAllBuffersForMessage(messageID: string) {
      for (const [key] of lineBuffer) {
        if (!key.startsWith(messageID + ":")) continue
        const [, partID, field] = key.split(":")
        flushLineBuffer(messageID, partID, field, true)
      }
    }
    // altimate_change end

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    // altimate_change start - yolo mode scoping. The rules (root-session normalization
    // so subagents inherit, explicit-choice-beats---yolo, and fail-closed on an
    // unresolvable chain) live in util/yolo.ts so they are unit-testable without a
    // renderer; these are thin bindings to the store.
    const getSessionNode = (sessionID: string) => result.session.get(sessionID)

    function rootSessionID(sessionID: string): string | undefined {
      return Yolo.resolveRoot(sessionID, getSessionNode)
    }

    // The process-wide default ONLY. A welcome-screen (pending) choice deliberately does
    // NOT feed this: it belongs to the session about to be created, and letting it act as
    // a fallback would auto-approve for every other undecided session — including one
    // still streaming in the background after `session.new` navigated away from it.
    function yoloFallback(): boolean {
      return Flag.ALTIMATE_CLI_YOLO
    }

    function yoloEnabled(sessionID: string): boolean {
      return Yolo.yoloEnabled({
        sessionID,
        overrides: store.yolo,
        getSession: getSessionNode,
        fallback: yoloFallback(),
      })
    }

    // Insert a permission request into the store so the normal prompt renders. Extracted
    // from the permission.asked handler so the yolo path can fall back to it.
    function enqueuePermission(request: PermissionRequest) {
      const requests = store.permission[request.sessionID]
      if (!requests) {
        setStore("permission", request.sessionID, [request])
        return
      }
      const match = search(requests, request.id, (r) => r.id)
      if (match.found) {
        setStore("permission", request.sessionID, match.index, reconcile(request))
        return
      }
      setStore(
        "permission",
        request.sessionID,
        produce((draft) => {
          draft.splice(match.index, 0, request)
        }),
      )
    }

    // Remove a settled permission request from the store. Idempotent — both the
    // `permission.replied` event and a successful auto-approve call it.
    function removePermission(sessionID: string, requestID: string) {
      const requests = store.permission[sessionID]
      if (!requests?.length) return
      const match = search(requests, requestID, (r) => r.id)
      if (!match.found) return
      setStore(
        "permission",
        sessionID,
        produce((draft) => {
          draft.splice(match.index, 1)
        }),
      )
    }

    // Requests currently being auto-approved. A reply is not removed from
    // store.permission until the server's `permission.replied` event lands, so without
    // this a second flush (toggle off then on again, or two set() calls) would reply to
    // the same request twice. The second reply targets an already-settled request, the
    // server rejects it, and the rejection would be misread as a lost reply — putting a
    // prompt back on screen for something already answered.
    const autoApproving = new Set<string>()

    // Auto-approve on behalf of the user. MUST fail loudly: the handler does not enqueue
    // the request, so if the reply is lost the server-side Deferred in Permission.ask
    // never settles and the agent hangs with nothing on screen explaining why.
    //
    // `throwOnError: true` is required — the generated SDK client defaults to returning
    // `{ error }` rather than throwing (packages/sdk/js/src/gen/client/client.gen.ts), so
    // a plain `.catch()` here would never fire on an ordinary HTTP failure.
    //
    // The workspace is read here rather than taken from callers: the session permission
    // UI passes `project.workspace.current()` on every reply, and threading it through
    // each call site is exactly how it went missing on the flush path.
    async function autoApprove(request: PermissionRequest, workspace?: string) {
      if (autoApproving.has(request.id)) return
      autoApproving.add(request.id)
      try {
        await sdk.client.permission.reply(
          { requestID: request.id, reply: "once", workspace: workspace ?? project.workspace.current() },
          { throwOnError: true },
        )
        // Drop it now rather than waiting for the server's `permission.replied` event.
        // The in-flight set above only covers concurrent duplicates; a later flush (toggle
        // off, then on again) would still find the request sitting in the store and reply
        // to an already-settled id. The event handler's removal is idempotent.
        removePermission(request.sessionID, request.id)
      } catch (e) {
        console.error("yolo mode auto-approve failed", {
          error: e instanceof Error ? e.message : String(e),
          requestID: request.id,
        })
        // Fall back to asking the user rather than silently swallowing the request.
        enqueuePermission(request)
      } finally {
        autoApproving.delete(request.id)
      }
    }

    // Enabling yolo while a prompt is already on screen must clear that prompt too.
    // Without this, the most natural moment to press ctrl+y — the agent is blocked
    // asking for approval — shows "YOLO ON" next to a still-blocked agent.
    function flushPendingPermissions(root: string, workspace?: string) {
      for (const [sessionID, requests] of Object.entries(store.permission)) {
        if (!requests?.length) continue
        if (rootSessionID(sessionID) !== root) continue
        for (const request of [...requests]) void autoApprove(request, workspace)
      }
    }
    // altimate_change end

    event.subscribe((event, { workspace }) => {
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied": {
          // altimate_change start — was inline; shares removePermission with the yolo
          // auto-approve path so the removal logic exists in one place.
          removePermission(event.properties.sessionID, event.properties.requestID)
          // altimate_change end
          break
        }

        case "permission.asked": {
          const request = event.properties
          // altimate_change start - yolo mode: auto-approve without showing prompt.
          // Scoped to the request's root session so a subagent's own child session
          // inherits the choice the user made on the conversation they can actually see.
          //
          // Safety note: this can only ever answer requests the SERVER already decided
          // to ask about. Permission.ask (packages/opencode/src/permission/index.ts)
          // evaluates the ruleset first and returns DeniedError without emitting any
          // event for a "deny" match, so configured guardrails (DROP DATABASE, DROP
          // SCHEMA, TRUNCATE) never reach this handler and cannot be auto-approved.
          if (yoloEnabled(request.sessionID)) {
            void autoApprove(request, workspace)
            break
          }
          // Upstream inlined the store insertion here; extracted to enqueuePermission so
          // the yolo path can fall back to it when an auto-approve reply fails.
          enqueuePermission(request)
          // altimate_change end
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          // altimate_change start — yolo mode: drop the override with the session.
          // Harmless today (ids are unique, so a stale entry cannot be re-matched) but a
          // stale `true` outliving its session is exactly what turns into a bug if this
          // map ever gains persistence.
          setStore(
            "yolo",
            produce((draft) => {
              delete draft[event.properties.info.id]
            }),
          )
          // altimate_change end
          break
        }
        case "session.updated": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        // altimate_change start (AI-7519) — track the active bootstrap / per-turn phase per
        // session. `active=true` sets the phase; `active=false` clears it iff it's still the
        // current phase (defensive against reordered events).
        case "session.phase": {
          const { sessionID, phase, active } = event.properties as {
            sessionID: string
            phase: string
            active: boolean
          }
          if (active) {
            setStore("session_phase", sessionID, phase)
          } else if (store.session_phase[sessionID] === phase) {
            setStore("session_phase", sessionID, undefined)
          }
          break
        }
        // altimate_change end

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          // altimate_change start - line streaming: flush remaining buffer when message completes
          if (
            Flag.ALTIMATE_LINE_STREAMING &&
            "completed" in event.properties.info.time &&
            event.properties.info.time.completed
          ) {
            flushAllBuffersForMessage(event.properties.info.id)
          }
          // altimate_change end
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          // altimate_change start - line streaming: clean up buffers for removed/aborted messages
          if (Flag.ALTIMATE_LINE_STREAMING) {
            flushAllBuffersForMessage(event.properties.messageID)
          }
          // altimate_change end
          // altimate_change start — upstream_fix: removal events can arrive before message hydration.
          const messages = store.message[event.properties.sessionID] ?? []
          // altimate_change end
          const result = search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          // altimate_change start - line streaming: discard buffered text when part is
          // authoritatively set by the server (via reconcile). Without this, the buffer
          // would append stale text on top of the server's complete content, duplicating
          // the trailing partial line.
          if (Flag.ALTIMATE_LINE_STREAMING) {
            const { messageID, id: partID } = event.properties.part
            for (const key of lineBuffer.keys()) {
              if (key.startsWith(`${messageID}:${partID}:`)) lineBuffer.delete(key)
            }
          }
          // altimate_change end
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          // altimate_change start - line streaming: buffer deltas, flush only on \n
          // Note: when line streaming is enabled (including via calm mode), this branch
          // handles all delta processing and breaks — the smooth streaming branch below
          // is not reached. This is intentional: flushLineBuffer already does direct
          // store path updates, so the produce() bypass is not needed.
          if (Flag.ALTIMATE_LINE_STREAMING) {
            const { messageID, partID, field, delta } = event.properties
            const key = `${messageID}:${partID}:${field}`
            lineBuffer.set(key, (lineBuffer.get(key) ?? "") + delta)
            flushLineBuffer(messageID, partID, field, false)
            break
          }
          // altimate_change end
          // altimate_change start - smooth streaming: direct path update avoids produce() proxy overhead
          if (Flag.ALTIMATE_SMOOTH_STREAMING) {
            const field = event.properties.field as keyof (typeof parts)[number]
            const existing = parts[result.index][field] as string | undefined
            setStore(
              "part",
              event.properties.messageID,
              result.index,
              field as any,
              ((existing ?? "") + event.properties.delta) as any,
            )
          } else {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                const part = draft[result.index]
                const field = event.properties.field as keyof typeof part
                const existing = part[field] as string | undefined
                ;(part[field] as string) = (existing ?? "") + event.properties.delta
              }),
            )
          }
          // altimate_change end
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          // altimate_change start - line streaming: discard buffers for removed parts
          if (Flag.ALTIMATE_LINE_STREAMING) {
            const { messageID, partID } = event.properties
            for (const key of lineBuffer.keys()) {
              if (key.startsWith(`${messageID}:${partID}:`)) lineBuffer.delete(key)
            }
          }
          // altimate_change end
          // altimate_change start — upstream_fix: part removals can arrive before part hydration.
          const parts = store.part[event.properties.messageID] ?? []
          // altimate_change end
          const result = search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const consoleState = responses[3]
            const agents = responses[4]
            const config = responses[5]
            const sessions = responses[6]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      // altimate_change start - yolo mode: per-session toggle surfaced to the TUI.
      // Reads go through yoloEnabled() so callers get root-session semantics and the
      // --yolo default for free; reactivity comes from the underlying store.
      yolo: {
        // sessionID is optional so the welcome screen (no session yet) can read and
        // set the mode with the same API the session view uses. With no session this
        // reports the PENDING choice — a display value only; it never influences the
        // decision made for any real session.
        enabled(sessionID?: string) {
          if (!sessionID) return store.yolo_pending ?? Flag.ALTIMATE_CLI_YOLO
          return yoloEnabled(sessionID)
        },
        set(sessionID: string | undefined, value: boolean, workspace?: string) {
          if (!sessionID) {
            setStore("yolo_pending", value)
            return
          }
          // An unresolvable chain still has to be settable — key it by the id we were
          // given so the user's explicit choice is recorded somewhere.
          const root = rootSessionID(sessionID) ?? sessionID
          setStore("yolo", root, value)
          if (value) flushPendingPermissions(root, workspace)
        },
        // Hand a pre-session choice to the session that was just CREATED, then clear it.
        // Deliberately called from the creation path rather than from a route effect:
        // a route effect fires on any navigation into a session, so resuming an old
        // conversation after a welcome-screen enable would silently yolo that one.
        adopt(sessionID: string) {
          const pending = store.yolo_pending
          if (pending === undefined) return
          const root = rootSessionID(sessionID) ?? sessionID
          if (store.yolo[root] === undefined) setStore("yolo", root, pending)
          setStore("yolo_pending", undefined)
        },
      },
      // altimate_change end
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: 100 }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
            ])
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data!)
                draft.todo[sessionID] = todo.data ?? []
                const currentMessages = draft.message[sessionID] ?? []
                const infos = (messages.data ?? []).flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                const removed = infos.slice(0, -100)
                const visible = infos.slice(-100)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of messages.data ?? []) {
                  if (!visibleIDs.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
                draft.session_diff[sessionID] = diff.data ?? []
              }),
            )
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      bootstrap,
    }
    return result
  },
})
