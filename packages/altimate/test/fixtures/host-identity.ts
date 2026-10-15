import { ServiceConfig } from "../../../cli/src/services/service-config"
import { selfCommand } from "../../../cli/src/util/process"
import { fallback } from "../../../client/src/service-probe"
import { logo, go } from "../../../tui/src/logo"
import { Identity } from "../../../util/src/identity"

if (process.argv.includes("--change-directory")) process.chdir(process.env.TMPDIR!)

console.log(
  JSON.stringify({
    app: Identity.app,
    ports: ["latest", "dev", "beta", "next", "local", "preview-a"].map((channel) => ServiceConfig.defaultPort(channel)),
    file: fallback(),
    logo,
    narrowLogo: go,
    title: Identity.title,
    selfCommand: selfCommand(),
  }),
)
