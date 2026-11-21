// altimate_change - new file
// libpq reads these connection destinations from the environment, overriding the profile host that offline
// mode checked. Offline dbt runs drop them.
export const LIBPQ_DESTINATION_VARS = ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"] as const

/** Remove the libpq destination variables from `env`, matching names case-insensitively as Windows does. */
export function dropLibpqDestinationVars(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env))
    if (LIBPQ_DESTINATION_VARS.some((name) => name === key.toUpperCase())) delete env[key]
}
