// altimate_change - new file
//
// The IDE extension's workspace pin.
//
// `altimate-code serve` is launched by the VS Code / Cursor extension, which already knows which
// datamate the user picked in its panel. That selection is what should govern the session's skills
// and memory — not whatever binding this project happens to carry on the backend. The extension
// hands it over in the child's environment and this module turns it back into a `CachedBinding`
// for `state.ts`'s `resolveBindingOutcome` to return.
//
// Why the environment, and not a `serve` argument: `resolveBindingOutcome` is reached from
// per-turn prompt assembly and from every memory write, neither of which has a path back to the
// command's parsed `args`. `session-context.ts` and `serve.ts`'s `ALTIMATE_CODE_SERVE` both made
// the same call, for the same reason — it has to be readable from every module realm. A `serve`
// flag can still be added as sugar, so long as its handler writes these vars before anything else
// runs.
//
// Why NOT the existing `ALTIMATE_RESOLVED_WORKSPACE_*` namespace, which looks like the obvious
// home: `launch-resolve.ts` sets `ALTIMATE_RESOLVED_WORKSPACE_ID` **alone** for the TUI's
// `--workspace <name>` flag — no name, no root. Reusing that namespace would make every such TUI
// session look like a half-populated pin, and the fail-closed rule below would then break
// `--workspace` outright. The two mechanisms are kept apart deliberately, and `readPin` additionally
// stands down outside `serve`.
import path from "node:path"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/altimate/util/log"

const log = Log.create({ service: "workspace-pin" })

const ENV_ID = "ALTIMATE_PINNED_WORKSPACE_ID"
const ENV_NAME = "ALTIMATE_PINNED_WORKSPACE_NAME"
const ENV_ROOT = "ALTIMATE_PINNED_WORKSPACE_ROOT"

export interface ValidPin {
  kind: "valid"
  datamateId: number
  datamateName: string
  /** The directory `serve` was launched for. The pin applies to this tree and nothing else. */
  root: string
}

/**
 * `absent` and `invalid` are deliberately NOT the same answer.
 *
 * Collapsing them — the shape `getResolvedWorkspaceId` uses, where anything unparseable returns
 * `null` — would make a malformed pin fall through to ordinary cache/server resolution, which can
 * legitimately return a DIFFERENT workspace. Silently doing work against a workspace the user did
 * not pick is the one outcome this feature must never produce, so a pin that is present but broken
 * fails closed instead.
 */
export type PinState = { kind: "absent" } | { kind: "invalid"; reason: string } | ValidPin

/**
 * Whether `directory` is the pinned root or lives underneath it.
 *
 * Delegates to `Filesystem.containsReal`, which resolves symlinks and — critically — walks up to
 * the nearest existing ancestor when the path itself does not exist yet, rejecting `..` segments
 * along the way. An earlier version here compared `realpathSync` output with a LEXICAL fallback
 * when resolution failed, which a not-yet-created path under a symlinked ancestor defeated:
 * `<root>/link/new`, with `link -> /outside`, resolved to nothing, fell back to the literal string,
 * and passed the prefix test. Since the directory arrives from the caller-supplied
 * `x-opencode-directory` header on an unsecured server, that was enough to attribute an outside
 * project's skills and memory to the pinned workspace.
 */
export function withinRoot(directory: string, root: string): boolean {
  return Filesystem.containsReal(root, directory)
}

/**
 * Read the pin out of the environment.
 *
 * Returns `absent` outside `serve`: the pin is the extension's channel, and the TUI has its own
 * (`--workspace`, via `launch-resolve.ts`). Keeping them from ever being live in the same process
 * is cheaper than reasoning about what should win.
 */
export function readPin(env: NodeJS.ProcessEnv = process.env): PinState {
  if (env["ALTIMATE_CODE_SERVE"] !== "1") return { kind: "absent" }

  const rawId = env[ENV_ID]
  const name = env[ENV_NAME]
  const root = env[ENV_ROOT]

  // `absent` means the extension set NOTHING. Tested on key presence, not truthiness: three
  // present-but-empty variables are a broken pin, not the absence of one, and collapsing them into
  // `absent` let a malformed pin fall through to ordinary cache/server resolution — the exact
  // fall-open this function exists to prevent.
  if (rawId === undefined && name === undefined && root === undefined) {
    return { kind: "absent" }
  }

  // Partial or empty is invalid, never "good enough". The extension sets all three or none;
  // anything else means something rewrote the environment and we no longer know what was intended.
  if (!rawId || !name || !root) {
    return { kind: "invalid", reason: "pin is partially set or empty" }
  }

  const datamateId = Number(rawId)
  if (!Number.isSafeInteger(datamateId) || datamateId <= 0) {
    return { kind: "invalid", reason: `datamate id ${JSON.stringify(rawId)} is not a positive integer` }
  }
  if (!path.isAbsolute(root)) {
    return { kind: "invalid", reason: "pinned root is not an absolute path" }
  }

  return { kind: "valid", datamateId, datamateName: name, root }
}

/** `readPin`, with the refusal logged once at the point it is taken. */
export function readPinLogged(env: NodeJS.ProcessEnv = process.env): PinState {
  const pin = readPin(env)
  if (pin.kind === "invalid") log.warn("ignoring workspace pin and failing closed", { reason: pin.reason })
  return pin
}
