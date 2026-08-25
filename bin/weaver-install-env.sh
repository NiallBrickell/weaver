#!/bin/bash
# Atomic installer for a hosted runner's raw KEY=value env file.
#
# Values arrive on stdin and are never evaluated as shell. Production uses the
# fixed defaults below; WEAVER_INSTALL_ENV_FILE/OWNER exist only so the same
# installer can be exercised against a temporary file without root in tests.

set -euo pipefail

mode="${1:-merge}"
env_file="${WEAVER_INSTALL_ENV_FILE:-/etc/weaver/env}"
owner="${WEAVER_INSTALL_ENV_OWNER:-weaver:weaver}"
env_dir="$(dirname "$env_file")"
mkdir -p "$env_dir"
touch "$env_file"
chmod 600 "$env_file"
incoming="$(mktemp "$env_dir/.env-incoming.XXXXXX")"
candidate="$(mktemp "$env_dir/.env-candidate.XXXXXX")"
trap 'rm -f "$incoming" "$candidate"' EXIT
chmod 600 "$incoming" "$candidate"
cat > "$incoming"

case "$mode" in
  store)
    IFS= read -r store < "$incoming" || true
    [ -n "${store:-}" ] || { echo 'external Postgres URL is empty' >&2; exit 1; }
    if [ "$(awk 'END { print NR }' "$incoming")" -ne 1 ]; then
      echo 'external Postgres input must contain exactly one line' >&2; exit 1
    fi
    case "$store" in
      postgres://*|postgresql://*) ;;
      *) echo 'external store must be a postgres:// or postgresql:// URL' >&2; exit 1 ;;
    esac
    case "$store" in
      *[[:space:]]*) echo 'external Postgres URL must not contain whitespace' >&2; exit 1 ;;
    esac
    awk '!/^WEAVER_STORE=/' "$env_file" > "$candidate"
    printf 'WEAVER_STORE=%s\n' "$store" >> "$candidate"
    ;;
  merge)
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in *=*) ;; *) echo 'remote env render contained a malformed line' >&2; exit 1 ;; esac
      key="${line%%=*}"
      [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || {
        echo 'remote env render contained a malformed key' >&2; exit 1;
      }
      case "$key" in
        WEAVER_STORE|WEAVER_HOME)
          echo "remote env render attempted to replace host-local $key" >&2; exit 1 ;;
      esac
    done < "$incoming"
    awk '
      BEGIN {
        # Keys owned by `weaver login --render-remote-env`. Remove a previous
        # value when the new render omits it (credential revocation and
        # fallback removal must propagate). Host-local paths/context are not
        # in this list, so an ordinary refresh preserves them.
        split("CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENROUTER_API_KEY ZHIPU_API_KEY ZAI_API_KEY PRIME_API_KEY WEAVER_MODEL_API_KEY WEAVER_SERVE_TOKEN WEAVER_EXECUTOR WEAVER_WORKER_MODEL WEAVER_COORDINATOR_MODEL WEAVER_COORDINATOR_EXECUTOR WEAVER_COORDINATOR_FALLBACK_MODEL WEAVER_COORDINATOR_FALLBACK_EXECUTOR WEAVER_COORDINATOR_FALLBACKS WEAVER_WORKER_MODEL_COMPLEX WEAVER_WORKER_FALLBACKS WEAVER_ASK_MODEL WEAVER_ACTION_MODEL WEAVER_ACTION_EXECUTOR WEAVER_RUNNER_EXECUTORS WEAVER_WORKER_MAX_TURNS WEAVER_ATTEMPT_STALE_MS", names, " ")
        for (i in names) managed[names[i]] = 1
      }
      FILENAME == ARGV[1] {
        key = $0; sub(/=.*/, "", key)
        rendered[key] = $0
        if (!(key in ordered)) { order[++count] = key; ordered[key] = 1 }
        next
      }
      {
        key = $0; sub(/=.*/, "", key)
        if (key in rendered) {
          if (!(key in emitted)) { print rendered[key]; emitted[key] = 1 }
        } else if (!(key in managed)) print
      }
      END {
        for (i = 1; i <= count; i++) {
          key = order[i]
          if (!(key in emitted)) print rendered[key]
        }
      }
    ' "$incoming" "$env_file" > "$candidate"
    ;;
  *) echo 'usage: weaver-install-env [merge|store]' >&2; exit 1 ;;
esac

if [ "$owner" != ':' ]; then chown "$owner" "$candidate"; fi
chmod 600 "$candidate"
mv "$candidate" "$env_file"
