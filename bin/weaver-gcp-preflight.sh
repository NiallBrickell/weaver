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
service_home="${WEAVER_GCP_PREFLIGHT_SERVICE_HOME:-/home/$service_user}"
executor_secrets_file="${WEAVER_GCP_PREFLIGHT_EXECUTOR_SECRETS_FILE:-/home/weaver/state/executor-secrets.env}"
weaver_binary="${WEAVER_GCP_PREFLIGHT_WEAVER_BIN:-/usr/local/bin/weaver}"

fail() {
  printf '❌ GCP execution preflight refused: %s\n' "$1" >&2
  exit 1
}

[ -r "$env_file" ] || fail 'host env is missing or unreadable'
id "$service_user" >/dev/null 2>&1 || fail 'Weaver service user does not exist'
[ -d "$service_home" ] || fail 'Weaver service home does not exist'
[ ! -s "$service_home/.codex/auth.json" ] || \
  fail 'personal Codex device authentication is forbidden on this host'

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
worker_model="$(env_value WEAVER_WORKER_MODEL)"
case "$worker_model" in
  openrouter/*) ;;
  *) fail 'WEAVER_WORKER_MODEL must be an openrouter/ provider-qualified model on this host' ;;
esac
worker_complex_model="$(env_value WEAVER_WORKER_MODEL_COMPLEX)"
if [ -n "$worker_complex_model" ]; then
  case "$worker_complex_model" in
    openrouter/*) ;;
    *) fail 'WEAVER_WORKER_MODEL_COMPLEX must use the openrouter/ provider prefix on this host' ;;
  esac
fi

worker_fallbacks="$(env_value WEAVER_WORKER_FALLBACKS)"
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  executor="$(parse_target_executor "$entry" WEAVER_WORKER_FALLBACKS)"
  [ "$executor" = openhands ] || fail 'every WEAVER_WORKER_FALLBACKS target must use openhands on this host'
  model="$(trim "${entry#*:}")"
  case "$model" in
    openrouter/*) ;;
    *) fail 'every WEAVER_WORKER_FALLBACKS model must use the openrouter/ provider prefix on this host' ;;
  esac
done < <(csv_entries "$worker_fallbacks")

# The coordinator is a separate, tool-restricted process seam. On this hosted
# profile it uses the Claude Agent SDK against OpenRouter's supported Anthropic
# API surface: an organization API key, never a copied CLI/device login. The
# provider prefix stays on the durable target so attempts name their real
# billing pool; the adapter removes it only when calling the upstream model.
coordinator_executor="$(env_value WEAVER_COORDINATOR_EXECUTOR)"
[ -n "$coordinator_executor" ] || coordinator_executor=local-sdk
[ "$coordinator_executor" = local-sdk ] || fail 'WEAVER_COORDINATOR_EXECUTOR must be local-sdk on this host'
coordinator_model="$(env_value WEAVER_COORDINATOR_MODEL)"
case "$coordinator_model" in
  openrouter/*) ;;
  *) fail 'WEAVER_COORDINATOR_MODEL must be an openrouter/ provider-qualified model on this host' ;;
esac

coordinator_executors=("$coordinator_executor")
if env_has WEAVER_COORDINATOR_FALLBACKS; then
  coordinator_fallbacks="$(env_value WEAVER_COORDINATOR_FALLBACKS)"
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    executor="$(parse_target_executor "$entry" WEAVER_COORDINATOR_FALLBACKS)"
    [ "$executor" = local-sdk ] || fail 'every WEAVER_COORDINATOR_FALLBACKS target must use local-sdk on this host'
    model="$(trim "${entry#*:}")"
    case "$model" in
      openrouter/*) ;;
      *) fail 'every WEAVER_COORDINATOR_FALLBACKS model must use the openrouter/ provider prefix on this host' ;;
    esac
    coordinator_executors+=("$executor")
  done < <(csv_entries "$coordinator_fallbacks")
else
  coordinator_fallback_executor="$(env_value WEAVER_COORDINATOR_FALLBACK_EXECUTOR)"
  [ -n "$coordinator_fallback_executor" ] || coordinator_fallback_executor="$coordinator_executor"
  [ "$coordinator_fallback_executor" = local-sdk ] || fail 'WEAVER_COORDINATOR_FALLBACK_EXECUTOR must be local-sdk on this host'
  coordinator_fallback_model="$(env_value WEAVER_COORDINATOR_FALLBACK_MODEL)"
  case "$coordinator_fallback_model" in
    openrouter/*) ;;
    *) fail 'WEAVER_COORDINATOR_FALLBACK_MODEL must use the openrouter/ provider prefix on this host' ;;
  esac
  coordinator_executors+=("$coordinator_fallback_executor")
fi

# local-sdk remains the intended action target, but this GCP host must not
# claim it until Pilot has authenticated, container-unreachable ingress and
# the installed shared client proves it can use that boundary. A liveness-only
# check would bless an unauthenticated endpoint.
action_executor="$(env_value WEAVER_ACTION_EXECUTOR)"
[ -n "$action_executor" ] || action_executor=local-sdk
[ "$action_executor" = local-sdk ] || fail 'WEAVER_ACTION_EXECUTOR must remain local-sdk; this host deliberately does not claim it'
deterministic_actions_only="$(env_value WEAVER_DETERMINISTIC_ACTIONS_ONLY)"
[ "$deterministic_actions_only" = 1 ] || \
  fail 'WEAVER_DETERMINISTIC_ACTIONS_ONLY must be 1 on this credential-bearing host'

runner_caps="$(env_value WEAVER_RUNNER_EXECUTORS)"
[ -n "$runner_caps" ] || fail 'WEAVER_RUNNER_EXECUTORS must be explicit on this host'
capabilities=()
while IFS= read -r executor; do
  [ -z "$executor" ] && continue
  case "$executor" in
    openhands|local-sdk) capabilities+=("$executor") ;;
    codex-sdk) fail 'codex-sdk requires forbidden personal device authentication on this host' ;;
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

secure_openrouter_coordinator_boundary() {
  local count value
  [ -r "$executor_secrets_file" ] || fail 'executor secret store is missing or unreadable'
  count="$(awk 'index($0, "OPENROUTER_API_KEY=") == 1 { count++ } END { print count + 0 }' "$executor_secrets_file")"
  [ "$count" -eq 1 ] || fail 'executor secret store must contain exactly one OPENROUTER_API_KEY'
  value="$(awk 'index($0, "OPENROUTER_API_KEY=") == 1 { print substr($0, 20) }' "$executor_secrets_file")"
  [ -n "$value" ] || fail 'OPENROUTER_API_KEY must be nonempty'
  unset value
}

secure_openrouter_coordinator_boundary

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

  # ExecStartPre inherits User=weaver from the runner unit. Linux may hide a
  # different service user's PID metadata from that account even though the
  # socket itself is visible; inspect through the already-required narrow sudo
  # boundary so the ownership assertion sees the same facts as provisioning.
  pilot_listeners="$(sudo ss -H -ltnp 'sport = :9721' 2>/dev/null)" || \
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
  # The raw HTTP checks prove the server boundary. This exact installed client
  # check separately proves the code that the engine and worker use can load
  # the executor-only bearer and receive the authenticated 204. Do not replace
  # it with another curl: that would verify different plumbing than actions use.
  [ -x "$weaver_binary" ] || fail 'installed Weaver client is missing or not executable'
  sudo -u "$service_user" "$weaver_binary" pilot-auth-check >/dev/null || \
    fail 'installed Weaver Pilot authentication probe failed'
fi

secure_github_app_boundary() {
  local key count value state_root credential_file workspace_root config_file

  [ -r "$executor_secrets_file" ] || fail 'executor secret store is missing or unreadable'
  for key in \
    WEAVER_GITHUB_APP_ID \
    WEAVER_GITHUB_APP_INSTALLATION_ID \
    WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64
  do
    count="$(awk -v key="$key" 'index($0, key "=") == 1 { count++ } END { print count + 0 }' "$executor_secrets_file")"
    [ "$count" -eq 1 ] || fail "executor secret store must contain exactly one $key"
    value="$(awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2) }' "$executor_secrets_file")"
    [ -n "$value" ] || fail "$key must be nonempty"
    unset value
  done

  [ ! -s "$service_home/.config/gh/hosts.yml" ] || \
    fail 'personal GitHub CLI authentication is forbidden on this host'
  [ ! -s "$service_home/.git-credentials" ] || \
    fail 'persistent Git credential files are forbidden on this host'
  if sudo -u "$service_user" env HOME="$service_home" git -C "$service_home" config --get-all credential.helper 2>/dev/null \
    | awk 'NF { found=1 } END { exit found ? 0 : 1 }'; then
    fail 'persistent Git credential helpers are forbidden on this host'
  fi
  if [ -d "$service_home/.ssh" ]; then
    while IFS= read -r credential_file; do
      if grep -Eq 'BEGIN ([A-Z0-9]+ )?PRIVATE KEY' "$credential_file" 2>/dev/null; then
        fail 'personal SSH private keys are forbidden on this host'
      fi
    done < <(find "$service_home/.ssh" -maxdepth 1 -type f -print 2>/dev/null)
  fi
  command -v gh >/dev/null 2>&1 || fail 'GitHub CLI is missing'
  if sudo -u "$service_user" env -u GH_TOKEN -u GITHUB_TOKEN HOME="$service_home" gh auth status >/dev/null 2>&1; then
    fail 'personal GitHub CLI authentication is forbidden on this host'
  fi

  for credential_file in "$env_file" "$executor_secrets_file"; do
    if awk 'BEGIN { found=0 } /^(GH_TOKEN|GITHUB_TOKEN)=./ { found=1 } END { exit found ? 0 : 1 }' "$credential_file"; then
      fail 'static GitHub tokens are forbidden in hosted secret files'
    fi
  done
  state_root="$(dirname "$executor_secrets_file")"
  while IFS= read -r credential_file; do
    if awk 'BEGIN { found=0 } /^(GH_TOKEN|GITHUB_TOKEN)=./ { found=1 } END { exit found ? 0 : 1 }' "$credential_file"; then
      fail 'static GitHub tokens are forbidden in hosted secret files'
    fi
  done < <(find "$state_root" -type f -name 'secrets.env' -print 2>/dev/null)

  for config_file in "$service_home/.claude.json" "$service_home/.mcp.json"; do
    if [ -s "$config_file" ] && grep -Eqi 'github|GH_TOKEN|GITHUB_TOKEN' "$config_file"; then
      fail 'hosted GitHub MCP credentials are forbidden'
    fi
  done
  if [ -d "$service_home/.claude" ]; then
    while IFS= read -r config_file; do
      if grep -Eqi 'github|GH_TOKEN|GITHUB_TOKEN' "$config_file"; then
        fail 'hosted GitHub MCP credentials are forbidden'
      fi
    done < <(find "$service_home/.claude" -type f -name '*.json' -print 2>/dev/null)
  fi

  workspace_root="$(env_value WEAVER_WORKSPACE_ROOT)"
  [ -n "$workspace_root" ] || workspace_root="$service_home/workspaces"
  if [ -d "$workspace_root" ]; then
    while IFS= read -r config_file; do
      if grep -Eqi '^[[:space:]]*url[[:space:]]*=.*(x-access-token|https?://[^/@[:space:]]+:[^/@[:space:]]+@|git@github\.com|ssh://)' "$config_file"; then
        fail 'workspace remotes must not persist GitHub or SSH credentials'
      fi
    done < <(find "$workspace_root" -path '*/.git/config' -type f -print 2>/dev/null)
    while IFS= read -r config_file; do
      if grep -Eqi 'github|GH_TOKEN|GITHUB_TOKEN' "$config_file"; then
        fail 'hosted GitHub MCP credentials are forbidden'
      fi
    done < <(find "$workspace_root" -type f \( -name '.mcp.json' -o -path '*/.claude/*.json' \) -print 2>/dev/null)
  fi

  [ -x "$weaver_binary" ] || fail 'installed Weaver client is missing or not executable'
  sudo -u "$service_user" env HOME="$service_home" "$weaver_binary" github-auth-check >/dev/null || \
    fail 'installed Weaver GitHub App authentication probe failed'
}

secure_github_app_boundary

service_uid="$(id -u "$service_user")"
docker_host="unix:///run/user/$service_uid/docker.sock"
sudo -u "$service_user" env DOCKER_HOST="$docker_host" docker info >/dev/null 2>&1 || \
  fail 'rootless Docker is not accessible to the Weaver service user'

echo '✓ GCP execution preflight passed (workers containerized; action lane supervised; GitHub machine identity authenticated)'
