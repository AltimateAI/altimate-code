import { NamedError } from "@opencode-ai/core/util/error"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerError, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"
// altimate_change start — the 502 and the opencode.log record the Hono handlers use
import { recordUnknownError, upstreamStatus } from "@/altimate/server/error-response"
// altimate_change end

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      // altimate_change start — an undeclared failure reaches this boundary too, such as the web UI proxy's
      // HttpClientError for a path no route serves (an unknown /api route): answer it as a defect is answered, not
      // with an empty 500 that nothing logs. Declared HttpApi errors are responses before they get here.
      const errors = cause.reasons.flatMap((reason) =>
        Cause.isDieReason(reason) ? [reason.defect] : Cause.isFailReason(reason) ? [reason.error] : [],
      )
      const index = errors.findIndex((error) => {
        if (HttpServerResponse.isHttpServerResponse(error)) return false
        if (HttpServerError.isHttpServerError(error)) return false
        if (HttpServerRespondable.isRespondable(error)) return false
        return true
      })
      if (index === -1) return Effect.failCause(cause)

      const error = errors[index]
      // altimate_change end
      if (
        ConfigErrorV1.JsonError.isInstance(error) ||
        ConfigErrorV1.InvalidError.isInstance(error) ||
        ConfigErrorV1.FrontmatterError.isInstance(error) ||
        ConfigErrorV1.DirectoryTypoError.isInstance(error)
      ) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
      }
      // altimate_change start — an unavailable remote config answers 502 with the remote's name and status, as the
      // Hono handlers do, instead of the fixed unknown-error body
      if (error instanceof NamedError) {
        const status = upstreamStatus(error.name)
        if (status) return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status }))
      }
      // altimate_change end

      const ref = `err_${crypto.randomUUID().slice(0, 8)}`

      // altimate_change start — recorded under the ref in opencode.log, as the Hono handlers do: the default logger
      // here prints to the console, which the in-process TUI owns, and leaves the ref in no file
      return Effect.promise(() => recordUnknownError("httpapi", ref, error)).pipe(
        // altimate_change end
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            new NamedError.Unknown({
              message: "Unexpected server error. Check server logs for details.",
              ref,
            }).toObject(),
            { status: 500 },
          ),
        ),
      )
    }),
  ),
).layer
