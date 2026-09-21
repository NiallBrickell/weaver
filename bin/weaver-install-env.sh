#!/bin/bash
# Atomic installer for a hosted runner's raw KEY=value env file.
#
# Values arrive on stdin and are never evaluated as shell. Production uses the
# fixed defaults below; the WEAVER_INSTALL_* overrides exist only so the same
# installer can be exercised against temporary files without root in tests.

set -euo pipefail

mode="${1:-merge}"
env_file="${WEAVER_INSTALL_ENV_FILE:-/etc/weaver/env}"
owner="${WEAVER_INSTALL_ENV_OWNER:-weaver:weaver}"
executor_secrets_file="${WEAVER_INSTALL_EXECUTOR_SECRETS_FILE:-/home/weaver/state/executor-secrets.env}"
executor_secrets_owner="${WEAVER_INSTALL_EXECUTOR_SECRETS_OWNER:-weaver:weaver}"
worker_secrets_file="${WEAVER_INSTALL_WORKER_SECRETS_FILE:-/home/weaver/state/secrets.env}"
worker_secrets_owner="${WEAVER_INSTALL_WORKER_SECRETS_OWNER:-weaver:weaver}"
# `user:` is the account plus its login group.
pilot_config_owner="${WEAVER_INSTALL_PILOT_CONFIG_OWNER:-weaver-pilot:}"
env_dir="$(dirname "$env_file")"

# The file the hosted Pilot reads its rules from, resolved exactly as Pilot
# resolves it: PILOT_CONFIG, else $PILOT_HOME/pilot.toml, else
# ~/.pilot/pilot.toml of the weaver-pilot account — taking PILOT_* from the
# unit's Environment= settings. bin/weaver-gcp-preflight.sh carries the same
# resolver to refuse a runner whose Pilot has no rules file; the gcpScript
# test installs through this one and launches through that one, so the two
# cannot drift apart unnoticed.
hosted_pilot_config_path() {
  local unit_env assignment pilot_config='' pilot_home='' home
  local -a assignments=()
  unit_env="$(systemctl show --property=Environment --value weaver-pilot.service 2>/dev/null || true)"
  read -r -a assignments <<< "$unit_env" || true
  for assignment in ${assignments[@]+"${assignments[@]}"}; do
    assignment="${assignment#\"}"; assignment="${assignment%\"}"
    case "$assignment" in
      PILOT_CONFIG=?*) pilot_config="${assignment#PILOT_CONFIG=}" ;;
      PILOT_HOME=?*) pilot_home="${assignment#PILOT_HOME=}" ;;
    esac
  done
  if [ -z "$pilot_config" ]; then
    if [ -z "$pilot_home" ]; then
      home="$(getent passwd weaver-pilot 2>/dev/null | cut -d: -f6)"
      [ -n "$home" ] || return 1
      pilot_home="$home/.pilot"
    fi
    pilot_config="$pilot_home/pilot.toml"
  fi
  case "$pilot_config" in /*) printf '%s\n' "$pilot_config" ;; *) return 1 ;; esac
}

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
        split("CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENROUTER_API_KEY ZHIPU_API_KEY ZAI_API_KEY PRIME_API_KEY WEAVER_MODEL_API_KEY WEAVER_SERVE_TOKEN WEAVER_EXECUTOR WEAVER_WORKER_MODEL WEAVER_COORDINATOR_MODEL WEAVER_COORDINATOR_EXECUTOR WEAVER_COORDINATOR_FALLBACK_MODEL WEAVER_COORDINATOR_FALLBACK_EXECUTOR WEAVER_COORDINATOR_FALLBACKS WEAVER_WORKER_MODEL_COMPLEX WEAVER_WORKER_FALLBACKS WEAVER_ASK_MODEL WEAVER_ACTION_MODEL WEAVER_ACTION_EXECUTOR WEAVER_DETERMINISTIC_ACTIONS_ONLY WEAVER_RUNNER_EXECUTORS WEAVER_WORKER_MAX_TURNS WEAVER_ATTEMPT_STALE_MS WEAVER_LOCAL_SDK_CONTAINER WEAVER_LOCAL_SDK_CONTAINER_IMAGE", names, " ")
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
  executor-secrets)
    # This is an exact synchronization, not a merge: removing a registered
    # laptop credential must revoke it on the host too. Adapter credentials
    # stay in Weaver's canonical executor-only store because adapters load
    # that file deliberately instead of trusting ambient process identity.
    executor_secrets_dir="$(dirname "$executor_secrets_file")"
    mkdir -p "$executor_secrets_dir"
    executor_candidate="$(mktemp "$executor_secrets_dir/.executor-secrets-candidate.XXXXXX")"
    trap 'rm -f "$incoming" "$candidate" "${executor_candidate:-}"' EXIT
    chmod 600 "$executor_candidate"
    awk '
      {
        key = $0; sub(/=.*/, "", key)
        if (seen[key]++) exit 1
      }
    ' "$incoming" || {
      echo 'remote executor secret render contained a duplicate key' >&2; exit 1;
    }
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in *=*) ;; *) echo 'remote executor secret render contained a malformed line' >&2; exit 1 ;; esac
      key="${line%%=*}"
      [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || {
        echo 'remote executor secret render contained a malformed key' >&2; exit 1;
      }
      printf '%s\n' "$line" >> "$executor_candidate"
    done < "$incoming"
    if [ "$executor_secrets_owner" != ':' ]; then chown "$executor_secrets_owner" "$executor_candidate"; fi
    chmod 600 "$executor_candidate"
    mv "$executor_candidate" "$executor_secrets_file"
    executor_candidate=""
    exit 0
    ;;
  worker-secrets)
    # The caller selected an exact least-privilege set from the local global
    # store. Replacing instead of merging makes omission a deterministic
    # revocation and keeps this scope independent from executor identities.
    [ -s "$incoming" ] || {
      echo 'remote worker secret render is empty' >&2; exit 1;
    }
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in *=*) ;; *) echo 'remote worker secret render contained a malformed line' >&2; exit 1 ;; esac
      key="${line%%=*}"
      value="${line#*=}"
      [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || {
        echo 'remote worker secret render contained a malformed key' >&2; exit 1;
      }
      [ -n "$value" ] || {
        echo "remote worker secret render contained an empty value for $key" >&2; exit 1;
      }
      case "$value" in *$'\r'*)
        echo "remote worker secret render contained a malformed value for $key" >&2; exit 1 ;;
      esac
    done < "$incoming"
    awk '
      {
        key = $0; sub(/=.*/, "", key)
        if (seen[key]++) exit 1
      }
    ' "$incoming" || {
      echo 'remote worker secret render contained a duplicate key' >&2; exit 1;
    }
    worker_secrets_dir="$(dirname "$worker_secrets_file")"
    mkdir -p "$worker_secrets_dir"
    worker_candidate="$(mktemp "$worker_secrets_dir/.worker-secrets-candidate.XXXXXX")"
    trap 'rm -f "$incoming" "$candidate" "${worker_candidate:-}"' EXIT
    chmod 600 "$worker_candidate"
    cat "$incoming" > "$worker_candidate"
    if [ "$worker_secrets_owner" != ':' ]; then chown "$worker_secrets_owner" "$worker_candidate"; fi
    chmod 600 "$worker_candidate"
    mv "$worker_candidate" "$worker_secrets_file"
    worker_candidate=""
    exit 0
    ;;
  pilot-config)
    # The hosted Pilot's rules file, replaced exactly with the operator's copy
    # (weaver-gcp.sh push-pilot-config). An empty file would parse to no rules
    # at all, so it is refused and the installed file is left untouched.
    [ -s "$incoming" ] || { echo 'hosted Pilot config is empty' >&2; exit 1; }
    pilot_config_file="$(hosted_pilot_config_path)" || {
      echo 'cannot resolve the hosted Pilot config path (no weaver-pilot account home, or a relative PILOT_CONFIG/PILOT_HOME)' >&2; exit 1;
    }
    pilot_config_dir="$(dirname "$pilot_config_file")"
    if [ ! -d "$pilot_config_dir" ]; then
      mkdir -p "$pilot_config_dir"
      chmod 700 "$pilot_config_dir"
      if [ "$pilot_config_owner" != ':' ]; then chown "$pilot_config_owner" "$pilot_config_dir"; fi
    fi
    pilot_candidate="$(mktemp "$pilot_config_dir/.pilot-config-candidate.XXXXXX")"
    trap 'rm -f "$incoming" "$candidate" "${pilot_candidate:-}"' EXIT
    chmod 600 "$pilot_candidate"
    cat "$incoming" > "$pilot_candidate"
    if [ "$pilot_config_owner" != ':' ]; then chown "$pilot_config_owner" "$pilot_candidate"; fi
    chmod 600 "$pilot_candidate"
    mv "$pilot_candidate" "$pilot_config_file"
    pilot_candidate=""
    echo "installed hosted Pilot config at $pilot_config_file"
    exit 0
    ;;
  *) echo 'usage: weaver-install-env [merge|store|executor-secrets|worker-secrets|pilot-config]' >&2; exit 1 ;;
esac

if [ "$owner" != ':' ]; then chown "$owner" "$candidate"; fi
chmod 600 "$candidate"
mv "$candidate" "$env_file"
