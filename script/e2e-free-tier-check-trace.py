"""Check a Langfuse trace for free-tier identity and redaction.

Usage: <trace json on stdin> | e2e-free-tier-check-trace.py <fake-secret>

Asserts the properties altimate-gateway's README calls a healthy free-tier trace, plus the
one the client is responsible for: that the client's session id actually arrived, which is
what X-Session-Id carries. Exits non-zero if any check fails.
"""

import json
import sys

GREEN = "\033[32mPASS\033[0m"
RED = "\033[31mFAIL\033[0m"

failures = 0


def ok(message):
    print("  %s %s" % (GREEN, message))


def bad(message):
    global failures
    failures += 1
    print("  %s %s" % (RED, message))


def main():
    fake_key = sys.argv[1]
    try:
        trace = json.load(sys.stdin)
    except ValueError as err:
        bad("could not parse the trace: %s" % err)
        return 1

    user = trace.get("userId") or ""
    if user.startswith("free-"):
        ok("trace_user_id is a free-tier principal (%s)" % user)
    else:
        bad("trace_user_id is not a free- principal: %r" % (user,))

    session = trace.get("sessionId") or ""
    if session.startswith("free:"):
        ok("session is namespaced free: (%s)" % session)
    else:
        bad("session is not namespaced free:: %r" % (session,))

    # The client's own session id must survive into the trace. This was silently absent
    # until session/llm.ts started sending X-Session-Id, and nothing else in the stack
    # would have noticed: traces still landed, just ungrouped.
    if "ses_" in session:
        ok("the client session id reached the trace")
    else:
        bad("no client session id in %r — is X-Session-Id being sent?" % (session,))

    tags = trace.get("tags") or []
    if "tier:free" in tags:
        ok("tagged tier:free")
    else:
        bad("tier:free missing from tags %s" % (tags,))
    if any(str(tag).startswith("policy:") for tag in tags):
        ok("tagged with a policy version")
    else:
        bad("policy: tag missing from tags %s" % (tags,))

    blob = json.dumps({"input": trace.get("input"), "output": trace.get("output")})
    if fake_key in blob:
        bad("THE FAKE AWS KEY IS STORED IN THE TRACE — redaction did not fire")
    else:
        ok("the fake AWS key does not appear in the stored trace")
    if "[REDACTED:aws_access_key]" in blob:
        ok("typed redaction placeholder present")
    else:
        bad("no [REDACTED:aws_access_key] placeholder in the trace")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
