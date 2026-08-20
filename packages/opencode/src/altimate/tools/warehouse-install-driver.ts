import z from "zod"
import { Tool } from "../../tool/tool"
import {
  DRIVER_PACKAGES,
  driverInstallDir,
  driverLabel,
  installOptionalDriver,
  isDriverInstalled,
  type DriverName,
} from "@altimateai/drivers/resolve"

// Listed literally rather than derived from DRIVER_PACKAGES so zod infers a
// concrete union; the catalogue test in packages/drivers keeps the two in step.
const DRIVER_NAMES = [
  "postgres",
  "redshift",
  "snowflake",
  "bigquery",
  "databricks",
  "mysql",
  "sqlserver",
  "oracle",
  "duckdb",
  "mongodb",
  "clickhouse",
  "trino",
] as const

/**
 * Declared rather than inferred: Tool.define infers its metadata type from the
 * execute return, and cannot unify branches whose object literals carry
 * different keys.
 */
interface InstallDriverMetadata {
  [key: string]: any
  driver: DriverName
  installed: boolean
  alreadyPresent: boolean
  dir: string
  error?: string
}

interface InstallDriverResult {
  title: string
  metadata: InstallDriverMetadata
  output: string
}

export const WarehouseInstallDriverTool = Tool.define("warehouse_install_driver", {
  description:
    "Install the database driver a warehouse type needs. Drivers are optional dependencies installed on demand; " +
    "use this when a connection reports that its driver is not installed. The driver is installed into Altimate " +
    "Code's own directory, so it survives CLI upgrades, and takes effect immediately — no session restart.",
  parameters: z.object({
    driver: z.enum(DRIVER_NAMES).describe("Warehouse type whose driver should be installed"),
  }),
  async execute(args): Promise<InstallDriverResult> {
    // The zod enum above guarantees one of the 12 driver names; the assertion
    // re-narrows it, since z.enum over a readonly tuple widens to string.
    const driver = args.driver as DriverName
    const label = driverLabel(driver)
    const dir = driverInstallDir()

    if (isDriverInstalled(driver)) {
      return {
        title: `${label} driver: already installed`,
        metadata: { driver, installed: true, alreadyPresent: true, dir },
        output: `The ${label} driver is already installed and resolvable. No action taken.`,
      }
    }

    const result = await installOptionalDriver(driver)
    const packages = result.packages.join(" ")

    if (!result.installed) {
      return {
        title: `${label} driver: install FAILED`,
        metadata: {
          driver,
          installed: false,
          alreadyPresent: false,
          dir: result.dir,
          error: result.error ?? "unknown error",
        },
        output:
          `Could not install the ${label} driver (${packages}).\n` +
          `${result.error}\n\n` +
          `Install it manually with:\n  npm install --prefix ${result.dir} ${packages}`,
      }
    }

    return {
      title: `${label} driver: installed`,
      metadata: { driver, installed: true, alreadyPresent: false, dir: result.dir },
      output:
        `Installed the ${label} driver (${packages}) into ${result.dir}.\n` +
        `It is available now — connections using ${driver} will work without restarting the session.`,
    }
  },
})

/**
 * Driver name for a warehouse config `type`, or undefined when the type needs
 * no optional SDK (sqlite ships with the runtime).
 */
export function driverForWarehouseType(type: string): DriverName | undefined {
  const normalized = type.trim().toLowerCase()
  return (DRIVER_NAMES as readonly string[]).includes(normalized) ? (normalized as DriverName) : undefined
}

export { DRIVER_PACKAGES, driverInstallDir, isDriverInstalled, installOptionalDriver, driverLabel }
export type { DriverName }
