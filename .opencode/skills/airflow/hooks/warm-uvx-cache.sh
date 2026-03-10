#!/bin/bash
# Hook: SessionStart - Warm the uvx cache for astro-airflow-mcp
# This ensures subsequent `uvx --from astro-airflow-mcp af` calls are fast

# Run in background so we don't block session startup
(uvx --from astro-airflow-mcp@latest af --version > /dev/null 2>&1 &)

exit 0
