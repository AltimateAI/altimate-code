import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  booted,
  countVisibleRows,
  createMockMcpAuthServer,
  openSlashDialog,
  selectAgent,
  suiteEnabled,
  submitPrompt,
  type TmuxJourney,
  withJourney,
} from "./harness"

const maybeDescribe = suiteEnabled() ? describe : describe.skip
const journeyOptions = { timeout: 75_000, retry: 1 }

async function rejectPermission(tui: TmuxJourney) {
  tui.send("Escape")
  await tui.waitFor((plain) => /Reject permission|Tell Altimate Code what to do differently/i.test(plain), 20_000)
  tui.send("Enter")
  await tui.waitFor((plain) => !/Permission required|Reject permission/i.test(plain), 20_000)
}

function permissionDialogForCommand(plain: string, command: string) {
  return (
    /Permission required/i.test(plain) &&
    (plain.includes(`$ ${command}`) || plain.includes(command)) &&
    /Allow once|Allow always|Reject|esc\s+reject/i.test(plain)
  )
}

maybeDescribe("real-binary TUI journeys", () => {
  test(
    "baseline: TUI boots clean with logo and no log flood",
    async () => {
      await withJourney("baseline boot clean", async (tui) => {
        await booted(tui)
        const plain = tui.snapshot()
        expect(plain).toMatch(/ctrl\+p commands|altimate code|test\/test-model|Test Model|┃/i)
        expect(plain).not.toMatch(/\bservice=|\[INFO\]/)
      })
    },
    journeyOptions,
  )

  test(
    "baseline: ctrl+p command palette opens",
    async () => {
      await withJourney("baseline command palette", async (tui) => {
        await booted(tui)
        tui.send("C-p")
        await tui.waitFor((plain) => /Commands/i.test(plain) && /Switch model|New session|Search/i.test(plain), 20_000)
      })
    },
    journeyOptions,
  )

  test(
    "baseline: Tab agent switch reaches reviewer",
    async () => {
      await withJourney("baseline tab agent switch", async (tui) => {
        await booted(tui)
        await selectAgent(tui, "reviewer")
        expect(tui.snapshot().toLowerCase()).toContain("reviewer")
      })
    },
    journeyOptions,
  )

  test(
    "baseline: /models dialog opens",
    async () => {
      await withJourney("baseline models dialog", async (tui) => {
        await booted(tui)
        await openSlashDialog(tui, "/models", /Select model|Test Model|test-model|Models loading/i)
      })
    },
    journeyOptions,
  )

  test(
    "baseline: prompt round-trips and session trace file is written",
    async () => {
      await withJourney("baseline prompt trace", async (tui) => {
        await booted(tui)
        await tui.ctx.llm.text("round trip ok")
        await submitPrompt(tui, "say round trip")
        await tui.waitFor((plain) => plain.includes("round trip ok"), 30_000)
        await tui.waitFor(async () => (await tui.traceFiles()).length > 0, 20_000)
        expect(await tui.traceFiles()).not.toHaveLength(0)
      })
    },
    journeyOptions,
  )

  test(
    "baseline: ctrl+c clears a non-empty draft instead of killing the app",
    async () => {
      await withJourney("baseline ctrl-c clears draft", async (tui) => {
        await booted(tui)
        tui.type("clear-me")
        await tui.waitFor((plain) => plain.includes("clear-me"), 5_000)
        tui.send("C-c")
        await tui.waitFor((plain) => !plain.includes("clear-me") && tui.alive(), 10_000)
        expect(tui.alive()).toBe(true)
      })
    },
    journeyOptions,
  )

  test(
    "#973: multi-line draft Ctrl+A inserts at line start and Ctrl+E appends at line end",
    async () => {
      await withJourney("973 ctrl-a ctrl-e multiline", async (tui) => {
        await booted(tui)
        tui.type("alpha")
        tui.send("C-j")
        tui.type("beta")
        await tui.waitFor((plain) => plain.includes("alpha") && plain.includes("beta"), 5_000)
        tui.send("C-a")
        tui.type("AAstartAA")
        await tui.waitFor((plain) => plain.includes("AAstartAAbeta"), 5_000)
        tui.send("C-e")
        tui.type("ZZendZZ")
        await tui.waitFor((plain) => plain.includes("AAstartAAbetaZZendZZ"), 5_000)
      })
    },
    journeyOptions,
  )

  test(
    "#975: Up recalls previous prompt and Down restores the in-progress draft",
    async () => {
      await withJourney("975 history recall restore", async (tui) => {
        await booted(tui)
        await tui.ctx.llm.text("history response")
        await submitPrompt(tui, "previous prompt")
        await tui.waitFor((plain) => plain.includes("history response"), 30_000)
        tui.type("draft stays")
        await tui.waitFor((plain) => plain.includes("draft stays"), 5_000)
        tui.send("Up")
        await tui.waitFor((plain) => plain.includes("previous prompt") && !plain.includes("draft stays"), 10_000)
        tui.send("Down")
        await tui.waitFor((plain) => plain.includes("draft stays"), 10_000)
      })
    },
    journeyOptions,
  )

  test(
    "#971: typing /mcp shows exactly one /mcps autocomplete row",
    async () => {
      await withJourney("971 mcps autocomplete duplicate", async (tui) => {
        await booted(tui)
        tui.type("/mcp")
        await tui.waitFor((plain) => countVisibleRows(plain, "/mcps") >= 1, 10_000)
        expect(countVisibleRows(tui.snapshot(), "/mcps")).toBe(1)
      })
    },
    journeyOptions,
  )

  // FINDING(#972): a `needs_auth` MCP status requires a real OAuth-discoverable server; the hermetic
  // mock resolves to `failed` instead (the dialog shows "github failed"), so the "Needs authentication"
  // hint can't be driven end-to-end here. The fix itself IS verified by the unit test
  // test/session/mcps-command.test.ts ("needs_auth status includes the auth command hint"), which
  // asserts SessionPrompt.formatMcpStatusForDisplay renders exactly that string. Re-enable this
  // journey if a mock OAuth MCP is added to the harness.
  test.todo(
    "#972: unauthenticated MCP status shows the altimate auth command",
    async () => {
      const mcp = await createMockMcpAuthServer()
      try {
        await withJourney(
          "972 mcps needs auth",
          async (tui) => {
            await booted(tui)
            await openSlashDialog(tui, "/mcps", /MCPs|Needs authentication|github/i)
            await tui.waitFor(
              (plain) => /Needs authentication \(run: altimate mcp auth github\)/i.test(plain),
              25_000,
            )
          },
          {
            config: (base) => ({
              ...base,
              mcp: {
                github: {
                  type: "remote",
                  url: mcp.url,
                  timeout: 10_000,
                  oauth: { clientId: "journey-client", callbackPort: 19877, scope: "repo" },
                },
              },
            }),
          },
        )
      } finally {
        await mcp.close()
      }
    },
    journeyOptions,
  )

  // FINDING(#978): the reviewer DOES exhibit the fixed behavior — the artifact pane shows it attempting
  // `$ gh pr view 1` (pre-fix this bash call was hard-denied and errored instantly). But the TUI
  // permission dialog does not reliably render under the mock-model harness (the scripted tool call
  // doesn't surface the PermissionPrompt the way a live model does), so waiting on "Permission required"
  // times out. The permission RULES are verified by unit tests: test/agent/agent.test.ts and
  // test/altimate/carry-forward/agent-safety.test.ts assert reviewer bash="ask", external_directory="ask",
  // webfetch="allow", and DDL still "deny". Re-enable if the harness gains real permission-flow rendering.
  test.todo(
    "#978: reviewer mode asks permission for gh pr view and external reads",
    async () => {
      await withJourney("978 reviewer permission ask", async (tui, ctx) => {
        await booted(tui)
        await selectAgent(tui, "reviewer")

        await tui.ctx.llm.tool("bash", {
          command: "gh pr view 1",
          description: "View pull request details",
        })
        await submitPrompt(tui, "review PR 1")
        await tui.waitFor(
          (plain) => permissionDialogForCommand(plain, "gh pr view 1"),
          30_000,
        )

        await rejectPermission(tui)

        await tui.ctx.llm.tool("read", { filePath: ctx.outsideFile })
        await submitPrompt(tui, "read the outside file")
        await tui.waitFor(
          (plain) =>
            /Permission required/i.test(plain) &&
            (/Access external directory/i.test(plain) ||
              plain.includes(ctx.outsideDir) ||
              plain.includes(ctx.outsideFile)),
          30_000,
        )
      })
    },
    { timeout: 90_000, retry: 1 },
  )

  test.todo("#976: long URL hyperlink keeps full OSC 8 target while shortening display text", () => {
    // FINDING(#976): direct-mode scrollback uses @opentui Markdown/Text renderables, but this tree only wires
    // terminal-link shortening/OSC8 transforms in the legacy session route. Leave the journey pending until
    // a live TUI capture confirms the direct-mode ANSI pane contains OSC8 links.
  })

  test("#974: feedback template does not over-question when enough detail is present", async () => {
    const template = await fs.readFile(path.join(import.meta.dir, "../../src/command/template/feedback.txt"), "utf8")
    expect(template).toContain("feedback_submit")
    expect(template).toContain("Do not interview the user")
    expect(template).toContain("Ask at most one round of clarifying questions")
    expect(template).toContain("If the description is straightforward, proceed directly to filing")
    expect(template).toContain("Do not ask a separate session-context question")
    expect(template).toContain("Once the essential fields are available, submit directly")
  })
})
