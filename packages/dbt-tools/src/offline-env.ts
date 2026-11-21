// altimate_change - new file
// libpq reads these connection destinations from the environment, overriding the profile host that offline
// mode checked. Offline dbt runs drop them.
export const LIBPQ_DESTINATION_VARS = ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"] as const
