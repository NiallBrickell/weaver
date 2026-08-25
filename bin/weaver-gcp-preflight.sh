#!/bin/bash
# Fail-closed execution profile for the credential-bearing GCP helper.
#
# This is intentionally narrower than Weaver's general executor model. The GCP
# host carries operator/model identities, so ordinary work must cross the
# existing disposable OpenHands container seam. Host-process executors remain
# valid on operator-controlled machines; they are not valid ordinary-worker
# routes on this host.

set -euo pipefail

env_file="${WEAVER_GCP_PREFLIGHT_ENV_FILE:-/etc/weaver/env}"
service_user="${WEAVER_GCP_PREFLIGHT_SERVICE_USER:-weaver}"
executor_secrets_file="${WEAVER_GCP_PREFLIGHT_EXECUTOR_SECRETS_FILE:-/home/weaver/state/executor-secrets.env}"

fail() {
  printf '❌ GCP execution preflight refused: %s\n' "$1" >&2
  exit 1
}

[ -r "$env_file" ] || fail 'host env is missing or unreadable'

# Read raw KEY=value records as data. Never source/eval the credential-bearing
# file, and never print a value while reporting a configuration failure.
env_count() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { count++ } END { print count + 0 }' "$env_file"
}

env_has() {
  [ "$(env_count "$1")" -gt 0 ]
}

env_value() {
  local key="$1" count
  count="$(env_count "$key")"
  [ "$count" -le 1 ] || fail "host env contains duplicate $key records"
  [ "$count" -eq 1 ] || return 0
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2) }' "$env_file"
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

parse_target_executor() {
  local entry="$1" env_name="$2" executor model
  case "$entry" in
    *:*) executor="$(trim "${entry%%:*}")"; model="$(trim "${entry#*:}")" ;;
    *) fail "$env_name contains a malformed capacity target" ;;
  esac
  [ -n "$executor" ] && [ -n "$model" ] || fail "$env_name contains a malformed capacity target"
  printf '%s' "$executor"
}

csv_entries() {
  local raw="$1" entry
  IFS=',' read -r -a entries <<< "$raw"
  for entry in "${entries[@]}"; do
    entry="$(trim "$entry")"
    [ -z "$entry" ] || printf '%s\n' "$entry"
  done
}

worker_executor="$(env_value WEAVER_EXECUTOR)"
[ "$worker_executor" = openhands ] || fail 'WEAVER_EXECUTOR must be openhands on this credential-bearing host'

worker_fallbacks="$(env_value WEAVER_WORKER_FALLBACKS)"
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  executor="$(parse_target_executor "$entry" WEAVER_WORKER_FALLBACKS)"
  [ "$executor" = openhands ] || fail 'every WEAVER_WORKER_FALLBACKS target must use openhands on this host'
done < <(csv_entries "$worker_fallbacks")

# The coordinator is a separate, tool-restricted process seam. Codex is
# permitted there, but listing codex-sdk as a normal worker fallback above is
# still refused. A local-sdk coordinator cannot be represented in the coarse
# runner capability set without also enabling the currently unsafe action
# lane, so this host keeps its coordinator entirely on Codex.
coordinator_executor="$(env_value WEAVER_COORDINATOR_EXECUTOR)"
[ -n "$coordinator_executor" ] || coordinator_executor=local-sdk
[ "$coordinator_executor" = codex-sdk ] || fail 'WEAVER_COORDINATOR_EXECUTOR must be codex-sdk on this host'

coordinator_executors=("$coordinator_executor")
if env_has WEAVER_COORDINATOR_FALLBACKS; then
  coordinator_fallbacks="$(env_value WEAVER_COORDINATOR_FALLBACKS)"
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    executor="$(parse_target_executor "$entry" WEAVER_COORDINATOR_FALLBACKS)"
    [ "$executor" = codex-sdk ] || fail 'every WEAVER_COORDINATOR_FALLBACKS target must use codex-sdk on this host'
    coordinator_executors+=("$executor")
  done < <(csv_entries "$coordinator_fallbacks")
else
  coordinator_fallback_executor="$(env_value WEAVER_COORDINATOR_FALLBACK_EXECUTOR)"
  [ -n "$coordinator_fallback_executor" ] || coordinator_fallback_executor="$coordinator_executor"
  [ "$coordinator_fallback_executor" = codex-sdk ] || fail 'WEAVER_COORDINATOR_FALLBACK_EXECUTOR must be codex-sdk on this host'
  coordinator_executors+=("$coordinator_fallback_executor")
fi

# local-sdk remains the intended action target, but this GCP host must not
# claim it until Pilot has authenticated, container-unreachable ingress. A
# liveness-only check would bless the current unauthenticated host bridge, so
# the safe state is an honest capability wait rather than executable actions.
action_executor="$(env_value WEAVER_ACTION_EXECUTOR)"
[ -n "$action_executor" ] || action_executor=local-sdk
[ "$action_executor" = local-sdk ] || fail 'WEAVER_ACTION_EXECUTOR must remain local-sdk; this host deliberately does not claim it'

runner_caps="$(env_value WEAVER_RUNNER_EXECUTORS)"
[ -n "$runner_caps" ] || fail 'WEAVER_RUNNER_EXECUTORS must be explicit on this host'
capabilities=()
while IFS= read -r executor; do
  [ -z "$executor" ] && continue
  case "$executor" in
    openhands|codex-sdk) capabilities+=("$executor") ;;
    local-sdk) capabilities+=("$executor") ;;
    *) fail 'WEAVER_RUNNER_EXECUTORS contains a host-process ordinary-worker capability' ;;
  esac
done < <(csv_entries "$runner_caps")

capability_has() {
  local wanted="$1" candidate
  for candidate in "${capabilities[@]}"; do
    [ "$candidate" != "$wanted" ] || return 0
  done
  return 1
}

capability_has openhands || fail 'WEAVER_RUNNER_EXECUTORS must include openhands for ordinary work'
for executor in "${coordinator_executors[@]}"; do
  capability_has "$executor" || fail 'WEAVER_RUNNER_EXECUTORS is missing a configured coordinator capability'
done

secure_pilot_boundary() {
  local pilot_url token_count pilot_token pilot_user pilot_pid pilot_listeners
  local listener_count listener_address wrong_status correct_status auth_header

  pilot_url="$(env_value WEAVER_PILOT_URL)"
  [ -n "$pilot_url" ] || pilot_url='http://127.0.0.1:9721'
  [ "$pilot_url" = 'http://127.0.0.1:9721' ] || \
    fail 'WEAVER_PILOT_URL must be the fixed loopback endpoint http://127.0.0.1:9721'
  systemctl is-active --quiet weaver-pilot.service || fail 'weaver-pilot.service is not active'
  pilot_user="$(systemctl show --property=User --value weaver-pilot.service 2>/dev/null)"
  [ "$pilot_user" = weaver-pilot ] || fail 'weaver-pilot.service must run as the separate weaver-pilot user'
  pilot_pid="$(systemctl show --property=MainPID --value weaver-pilot.service 2>/dev/null)"
  case "$pilot_pid" in ''|0|*[!0-9]*) fail 'weaver-pilot.service has no live main process' ;; esac

  pilot_listeners="$(ss -H -ltnp 'sport = :9721' 2>/dev/null)" || \
    fail 'could not inspect the Pilot listener'
  listener_count="$(printf '%s\n' "$pilot_listeners" | awk 'NF { count++ } END { print count + 0 }')"
  listener_address="$(printf '%s\n' "$pilot_listeners" | awk 'NF { print $4 }')"
  [ "$listener_count" -eq 1 ] && [ "$listener_address" = '127.0.0.1:9721' ] || \
    fail 'Pilot must have exactly one TCP listener at 127.0.0.1:9721'
  case "$pilot_listeners" in
    *"pid=$pilot_pid,"*) ;;
    *) fail 'the loopback Pilot listener is not owned by weaver-pilot.service' ;;
  esac
  unset pilot_listeners

  [ -r "$executor_secrets_file" ] || fail 'executor secret store is missing or unreadable'
  token_count="$(awk 'index($0, "WEAVER_PILOT_TOKEN=") == 1 { count++ } END { print count + 0 }' "$executor_secrets_file")"
  [ "$token_count" -eq 1 ] || fail 'executor secret store must contain exactly one WEAVER_PILOT_TOKEN'
  pilot_token="$(awk 'index($0, "WEAVER_PILOT_TOKEN=") == 1 { print substr($0, 20) }' "$executor_secrets_file")"
  [ -n "$pilot_token" ] || fail 'WEAVER_PILOT_TOKEN must be nonempty'

  wrong_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 \
    --header 'Authorization: Bearer weaver-preflight-deliberately-invalid' \
    "$pilot_url/internal/auth-check" || true)"
  [ "$wrong_status" = 401 ] || fail 'Pilot auth check did not reject an invalid bearer'

  auth_header="$(mktemp)"
  chmod 600 "$auth_header"
  trap 'rm -f -- "${auth_header:-}"' EXIT
  printf 'Authorization: Bearer %s\n' "$pilot_token" > "$auth_header"
  unset pilot_token
  correct_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 \
    --header "@$auth_header" "$pilot_url/internal/auth-check" || true)"
  rm -f -- "$auth_header"
  auth_header=''
  trap - EXIT
  [ "$correct_status" = 204 ] || fail 'Pilot auth check did not accept the registered bearer'
}

if capability_has local-sdk; then
  secure_pilot_boundary
  # The server boundary is necessary but not sufficient: until every Weaver
  # Pilot client sends this bearer, enabling the action capability would turn
  # legitimate actions into denials or tempt an unauthenticated fallback.
  fail 'local-sdk action capability remains disabled until Weaver Pilot bearer clients are installed'
fi

id "$service_user" >/dev/null 2>&1 || fail 'Weaver service user does not exist'
service_uid="$(id -u "$service_user")"
docker_host="unix:///run/user/$service_uid/docker.sock"
sudo -u "$service_user" env DOCKER_HOST="$docker_host" docker info >/dev/null 2>&1 || \
  fail 'rootless Docker is not accessible to the Weaver service user'

echo '✓ GCP execution preflight passed (ordinary workers containerized; action lane not claimed)'
