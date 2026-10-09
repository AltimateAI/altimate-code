#!/usr/bin/env bash
# Source after cd to harness/. IDs are names, never paths.
validate_id() {
  case "$1" in
    ''|.|..|*[!a-zA-Z0-9_.-]*|[!a-zA-Z0-9]*) echo "invalid id: $1" >&2; return 2 ;;
  esac
}
new_run_id() { python3 -c 'import common; print(common.new_run_id())'; }
fresh_run() {
  validate_id "$1" || return
  mkdir -p runs
  [ ! -L runs ] || { echo "runs must not be a symlink" >&2; return 2; }
  mkdir "runs/$1" || { echo "run already exists; choose a new run id" >&2; return 2; }
  mkdir "runs/$1/eval"
}
backend_args() {
  BACKEND="${BACKEND:-saas}"
  WS_ARGS=(--backend "$BACKEND")
  case "$BACKEND" in
    fake) ;;
    saas)
      [ "${ALLOW_REAL_SAAS:-}" = 1 ] && [[ "${WORKSPACE_ID:-}" =~ ^[1-9][0-9]*$ ]] && [ -n "${SAAS_CREDS_DIR:-}" ] || {
        echo "SaaS requires ALLOW_REAL_SAAS=1, positive WORKSPACE_ID, and SAAS_CREDS_DIR" >&2; return 2;
      }
      WS_ARGS+=(--workspace-id "$WORKSPACE_ID") ;;
    *) echo "unknown BACKEND: $BACKEND" >&2; return 2 ;;
  esac
}
