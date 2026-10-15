// altimate: ALT-F01
import { Config, Redacted } from "effect"
import { Identity } from "@opencode/util/identity"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The opencode server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
// altimate: ALT-F01
export const password = Config.all(
  Identity.envPrefixes.map((prefix) =>
    Config.Redacted(`${prefix}PASSWORD`).pipe(
      Config.orElse(() => Config.Redacted(`${prefix}SERVER_PASSWORD`)),
      Config.withDefault(undefined),
    ),
  ),
).pipe(
  Config.map((values) =>
    values.find(
      (value, index) => value !== undefined && (Redacted.value(value) !== "" || index === values.length - 1),
    ),
  ),
)

export function session() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        // altimate: ALT-F01
        entry[1] !== undefined &&
        !Identity.envPrefixes.some((prefix) => entry[0] === `${prefix}PASSWORD` || entry[0] === `${prefix}SERVER_PASSWORD`),
    ),
  )
}

export * as Env from "./env"
