import { Provider } from "../provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { NotFoundError } from "../storage/db"
import { Session } from "../session"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { ErrorHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import type { Log } from "../util/log"
// altimate_change start — client-safe error responses
import { NamedError as CoreNamedError } from "@opencode-ai/core/util/error"
import { errorRef, unknownErrorBody, upstreamStatus } from "../altimate/server/error-response"
// altimate_change end

export function errorHandler(log: Log.Logger): ErrorHandler {
  return (err, c) => {
    // altimate_change start — one log line per error, under the ref an unknown error's response carries
    const ref = errorRef()
    log.error("failed", {
      ref,
      error: err,
    })
    // altimate_change end
    if (err instanceof NamedError) {
      let status: ContentfulStatusCode
      if (err instanceof NotFoundError) status = 404
      else if (err instanceof Provider.ModelNotFoundError) status = 400
      else if (err.name === "ProviderAuthValidationFailed") status = 400
      else if (err.name.startsWith("Worktree")) status = 400
      else status = 500
      return c.json(err.toObject(), { status })
    }
    if (err instanceof Session.BusyError) {
      return c.json(new NamedError.Unknown({ message: err.message }).toObject(), { status: 400 })
    }
    if (err instanceof HTTPException) return err.getResponse()
    // altimate_change start — a NamedError from @opencode-ai/core (config, remote config) isn't an instance of this
    // package's NamedError: answer with its own name and fields, never the stack trace below.
    if (err instanceof CoreNamedError) {
      return c.json(err.toObject(), { status: upstreamStatus(err.name) ?? 500 })
    }
    // Never send an error's text or stack to the client: a fixed message and a ref, logged in full.
    return c.json(unknownErrorBody(ref), {
      status: 500,
    })
    // altimate_change end
  }
}
