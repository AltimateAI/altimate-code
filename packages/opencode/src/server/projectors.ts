import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Database, eq } from "@/storage/db"

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        // altimate_change start — Session.Event.Updated is BusEvent so payload is { info }, not { sessionID }
        const info = (data as { info?: Session.Info }).info
        const id = info?.id
        if (!id) return data
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
        if (!row) return data
        return {
          info: Session.fromRow(row),
        }
        // altimate_change end
      }
      return data
    },
  })
}

initProjectors()
