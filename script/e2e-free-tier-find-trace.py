"""Find the trace carrying our run marker in one or more Langfuse trace pages.

Usage: e2e-free-tier-find-trace.py <marker> <traces.json>...

Prints the matching trace as JSON, or nothing. Reads the pages from FILES rather than
argv: a page of traces runs to hundreds of kilobytes and exceeds ARG_MAX, which fails in a
way indistinguishable from the trace simply not being there.
"""

import json
import sys


def main():
    marker = sys.argv[1]
    for path in sys.argv[2:]:
        try:
            with open(path) as handle:
                data = json.load(handle).get("data", [])
        except Exception:
            continue
        for trace in data:
            haystack = json.dumps({"i": trace.get("input"), "o": trace.get("output")})
            if marker in haystack:
                print(json.dumps(trace))
                return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
