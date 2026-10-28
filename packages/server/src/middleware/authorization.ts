import { ServerAuth } from "../auth"
import { UnauthorizedError } from "../errors"
// altimate_change start — upstream_fix: authorize PTY ticket bypass from the matched route (anomalyco/opencode#58258)
import { PTY_CONNECT_PATH, PTY_CONNECT_TICKET_QUERY } from "../groups/pty"
// altimate_change end
import { Effect, Encoding, Layer, Redacted } from "effect"
// altimate_change start — upstream_fix: authorize PTY ticket bypass from the matched route (anomalyco/opencode#58258)
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
// altimate_change end
import { HttpApiMiddleware } from "effect/unstable/httpapi"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

export class Authorization extends HttpApiMiddleware.Service<Authorization>()("@opencode/HttpApiAuthorization", {
  error: UnauthorizedError,
}) {}

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        // altimate_change start — upstream_fix: authorize PTY ticket bypass from the matched route (anomalyco/opencode#58258)
        // Use the route selected by Effect so authorization and dispatch cannot disagree about the request path.
        const route = yield* HttpRouter.RouteContext
        const url = new URL(request.url, "http://localhost")
        if (route.route.path === PTY_CONNECT_PATH && !!url.searchParams.get(PTY_CONNECT_TICKET_QUERY))
          return yield* effect
        // altimate_change end
        const credential = yield* credentialFromRequest(request)
        if (ServerAuth.authorized(credential, config)) return yield* effect
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
        )
        return yield* new UnauthorizedError({ message: "Authentication required" })
      }),
    )
  }),
)
