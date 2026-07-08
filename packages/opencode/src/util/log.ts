// altimate_change start — re-export shim. Upstream deleted util/log.ts in the Effect-logging
// migration (no successor). The fork's Log replacement lives at altimate/util/log.ts; this shim
// keeps the many survivor + test importers of `@/util/log` / `../util/log` resolving without a
// per-file repoint, matching the existing util/* re-export-shim pattern (error/token/locale).
export { Log } from "@/altimate/util/log"
// altimate_change end
