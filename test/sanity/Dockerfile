FROM oven/bun:1.3.10-debian

# System deps (what a real user would have)
RUN apt-get update && apt-get install -y \
    git python3 python3-pip python3-venv curl sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# dbt in venv (matches real user setup)
RUN python3 -m venv /opt/dbt && \
    /opt/dbt/bin/pip install --quiet dbt-core dbt-duckdb dbt-postgres
ENV PATH="/opt/dbt/bin:$PATH"

# Fresh user, clean HOME — simulates new user
ENV HOME=/home/testuser
RUN useradd -m testuser
USER testuser
WORKDIR /home/testuser

# Copy the built binary directly (simulates what postinstall does)
# The real npm publish pipeline rewrites workspace:* deps — we can't use npm pack directly.
# Instead, copy the built binary + run postinstall manually.
COPY --chown=testuser packages/opencode/dist/@altimateai/ /home/testuser/.altimate-install/dist/@altimateai/
COPY --chown=testuser packages/opencode/script/postinstall.mjs /home/testuser/.altimate-install/postinstall.mjs
COPY --chown=testuser packages/opencode/package.json /home/testuser/.altimate-install/package.json
COPY --chown=testuser .opencode/skills/ /home/testuser/.altimate-install/skills/

# Install altimate-core native binding (required at runtime).
# NOTE: Database drivers (pg, snowflake-sdk, mysql2, etc.) are NOT installed here
# because a real `npm install -g altimate-code` doesn't install them either —
# they're optionalDependencies in the workspace @altimateai/drivers package which
# is never published. This is issue #295. Driver resolvability tests are expected
# to FAIL here, proving the bug exists for real users.
RUN cd /home/testuser/.altimate-install && \
    echo '{"dependencies":{"@altimateai/altimate-core":"latest"}}' > package.json && \
    bun install && \
    node -e "require('@altimateai/altimate-core')" 2>/dev/null || { echo "FATAL: altimate-core install failed"; exit 1; }

# Link binary to PATH and copy skills to ~/.altimate/builtin/
# Detect architecture: use TARGETARCH from docker buildx, fall back to uname
ARG TARGETARCH
RUN ARCH="${TARGETARCH:-$(uname -m | sed 's/x86_64/x64/' | sed 's/aarch64/arm64/')}" && \
    mkdir -p /home/testuser/.local/bin && \
    cp /home/testuser/.altimate-install/dist/@altimateai/altimate-code-linux-${ARCH}/bin/altimate-code /home/testuser/.local/bin/altimate && \
    chmod +x /home/testuser/.local/bin/altimate && \
    mkdir -p /home/testuser/.altimate/builtin && \
    cp -r /home/testuser/.altimate-install/skills/* /home/testuser/.altimate/builtin/
ENV PATH="/home/testuser/.local/bin:$PATH"
ENV NODE_PATH="/home/testuser/.altimate-install/node_modules"

# Copy test scripts
COPY --chown=testuser test/sanity/ /home/testuser/sanity/
RUN chmod +x /home/testuser/sanity/run.sh \
    /home/testuser/sanity/phases/*.sh \
    /home/testuser/sanity/pr-tests/*.sh \
    /home/testuser/sanity/lib/*.sh

ENTRYPOINT ["/home/testuser/sanity/run.sh"]
