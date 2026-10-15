import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
// altimate_change start — upstream_fix: backport 82d4c89031 redact debug configuration credentials
import { redactConfig } from "./redact"
// altimate_change end

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.debug.config")(function* () {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    // altimate_change start — upstream_fix: backport 82d4c89031 redact debug configuration credentials
    process.stdout.write(JSON.stringify(redactConfig(config), null, 2) + EOL)
    // altimate_change end
  }),
})
