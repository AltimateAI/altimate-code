"""Check what the registration put on the wire against what it stored locally.

Usage: e2e-free-tier-check-register.py <auth.json> <proxy.jsonl>

The property under test is the one the whole consent design rests on: the gateway learns
a hash, and the machine keeps the secret. Exits non-zero if any check fails.
"""

import hashlib
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
    auth_file, proxy_log = sys.argv[1], sys.argv[2]

    try:
        entry = json.load(open(auth_file)).get("altimate-free")
    except Exception as err:
        bad("could not read %s: %s" % (auth_file, err))
        return 1
    if not entry:
        bad("no altimate-free entry in auth.json")
        return 1
    secret = entry.get("metadata", {}).get("install_secret", "")

    raw_log = open(proxy_log).read()
    body = None
    for line in raw_log.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if record.get("path") == "/register":
            body = json.loads(record.get("body") or "{}")
    if body is None:
        bad("no /register request captured by the proxy")
        return 1

    sent = body.get("install_secret_hash", "")
    if len(sent) == 64 and all(c in "0123456789abcdef" for c in sent):
        ok("install_secret_hash is 64 lowercase hex chars")
    else:
        bad("install_secret_hash malformed: %r" % (sent,))

    if secret and sent == hashlib.sha256(secret.encode()).hexdigest():
        ok("the hash sent is the sha256 of the secret stored locally")
    else:
        bad("the hash sent does not match the stored install secret")

    # The headline assertion. Checked against the whole log, not just the register body,
    # so a leak on any other request would also be caught.
    if secret and secret in raw_log:
        bad("THE RAW INSTALL SECRET WAS SENT TO THE GATEWAY")
    else:
        ok("the raw install secret never left the machine")

    if body.get("cli_version"):
        ok("cli_version sent (%s)" % body["cli_version"])
    else:
        bad("cli_version missing from the registration body")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
