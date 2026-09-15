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
# The Node used to parse MCP configuration files; the hosted runner ships its own.
node_binary="${WEAVER_GCP_PREFLIGHT_NODE:-$(command -v node || true)}"
# The checkout the runner executes from: the SDK's native Claude Code binary
# lives there and is what a containerized worker runs.
checkout_dir="${WEAVER_GCP_PREFLIGHT_CHECKOUT:-/opt/weaver}"

fail() {
  printf '❌ GCP execution preflight refused: %s\n' "$1" >&2
  exit 1
}

[ -r "$env_file" ] || fail 'host env is missing or unreadable'
id "$service_user" >/dev/null 2>&1 || fail 'Weaver service user does not exist'
[ -d "$service_home" ] || fail 'Weaver service home does not exist'
[ ! -s "$service_home/.codex/auth.json" ] || \
  fail 'personal Codex device authentication is forbidden on this host'
[ ! -s "$service_home/.claude/.credentials.json" ] || \
  fail 'personal Claude device authentication is forbidden on this host; use a setup-token'

# Read raw KEY=value records as data. Never source/eval the credential-bearing
# file, and never print a value while reporting a configuration failure.
env_count() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { count++ } END { print count + 0 }' "$env_file"
}

env_has() {
  [ "$(env_count "$1")" -gt 0 ]
}

# A hosted GitHub MCP server is refused by what the files DECLARE, never by a
# substring. Claude Code's ~/.claude.json is a 40 KB state file that caches
# feature-flag names, and on 2026-09-15 one of them
# (`tengu_kairos_github_webhooks: false`) matched a whole-file grep for
# "github": the launch gate refused every restart and the fleet sat down for
# an hour on a flag name while the file declared no MCP server at all. Only an
# MCP server declaration (`mcpServers`/`servers` entries, at any depth — the
# state file keeps them per project) is inspected: a GitHub-named server, or
# one whose declaration carries a GitHub token or endpoint, is refused. A file
# that is not JSON fails closed — it cannot be shown clean.
refuse_github_mcp_config() {
  local file files='' verdict
  for file in "$@"; do
    [ -s "$file" ] || continue
    files="${files}${file}
"
  done
  [ -n "$files" ] || return 0
  [ -n "$node_binary" ] && [ -x "$node_binary" ] || fail 'node is missing; hosted MCP configuration cannot be inspected'
  verdict="$(WEAVER_GCP_PREFLIGHT_MCP_FILES="$files" "$node_binary" -e '
const fs = require("fs");
const forbidden = /github|GH_TOKEN|GITHUB_TOKEN/i;
const walk = (node, hit) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const item of node) walk(item, hit); return; }
  for (const [key, value] of Object.entries(node)) {
    if ((key === "mcpServers" || key === "servers") && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [name, decl] of Object.entries(value)) {
        if (forbidden.test(name) || forbidden.test(JSON.stringify(decl))) hit();
      }
    }
    walk(value, hit);
  }
};
for (const file of process.env.WEAVER_GCP_PREFLIGHT_MCP_FILES.split("\n").filter(Boolean)) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { console.log("unreadable " + file); process.exit(0); }
  walk(doc, () => { console.log("forbidden " + file); process.exit(0); });
}
console.log("clean");
' 2>/dev/null)" || fail 'hosted MCP configuration inspection failed'
  case "$verdict" in
    clean) ;;
    unreadable\ *) fail "hosted MCP configuration is not readable JSON: ${verdict#unreadable }" ;;
    forbidden\ *) fail 'hosted GitHub MCP credentials are forbidden' ;;
    *) fail 'hosted MCP configuration inspection failed' ;;
  esac
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
  local -a entries=()
  IFS=',' read -r -a entries <<< "$raw"
  for entry in "${entries[@]}"; do
    entry="$(trim "$entry")"
    [ -z "$entry" ] || printf '%s\n' "$entry"
  done
}

# Ordinary work must be structurally confined: a worker sharing the controller
# UID can read absolute credential paths. Two routes satisfy that: the
# OpenHands agent-server container on OpenRouter, and — since 2026-09-15 —
# Claude Code itself started inside the same rootless Docker seam
# (WEAVER_LOCAL_SDK_CONTAINER=1, src/executor/claudeContainer.ts), which is
# how the host puts its Claude subscription first for workers. A bare local-sdk
# worker on this host remains a same-UID model process and is refused.
worker_executor="$(env_value WEAVER_EXECUTOR)"
local_sdk_container="$(env_value WEAVER_LOCAL_SDK_CONTAINER)"
require_worker_executor() {
  local executor="$1" env_name="$2"
  case "$executor" in
    openhands) ;;
    local-sdk)
      [ "$local_sdk_container" = 1 ] || \
        fail "$env_name may use local-sdk only with WEAVER_LOCAL_SDK_CONTAINER=1: a host-process worker would share the controller UID"
      ;;
    *) fail "$env_name must be openhands or containerized local-sdk on this credential-bearing host" ;;
  esac
}
# A worker seat's model follows its executor: the OpenHands route is the
# OpenRouter seat, the containerized Claude route is the subscription seat.
# Claude through OpenRouter is refused on both (every hosted Claude run stays
# subscription-backed), and OpenRouter through the subscription route is
# simply not a thing.
require_worker_model() {
  local executor="$1" model="$2" env_name="$3"
  case "$executor" in
    openhands)
      case "$model" in
        openrouter/*) ;;
        *) fail "$env_name must be an openrouter/ provider-qualified model for an openhands seat on this host" ;;
      esac
      ;;
    local-sdk)
      case "$model" in
        openrouter/*) fail "$env_name must be a subscription-backed Claude model for a containerized local-sdk seat, not an openrouter/ route" ;;
      esac
      ;;
  esac
}
require_worker_executor "$worker_executor" WEAVER_EXECUTOR
openhands_host_gateway="$(env_value WEAVER_OPENHANDS_HOST_GATEWAY_IP)"
awk -v value="$openhands_host_gateway" 'BEGIN {
  count = split(value, octets, ".")
  if (count != 4) exit 1
  for (i = 1; i <= 4; i++) if (octets[i] !~ /^[0-9]+$/ || octets[i] > 255) exit 1
}' || fail 'WEAVER_OPENHANDS_HOST_GATEWAY_IP must be one IPv4 address'
ip -4 -o addr show scope global | awk -v expected="$openhands_host_gateway" '
  { split($4, address, "/"); if (address[1] == expected) found = 1 }
  END { exit found ? 0 : 1 }
' || fail 'WEAVER_OPENHANDS_HOST_GATEWAY_IP must be owned by this execution host'
worker_model="$(env_value WEAVER_WORKER_MODEL)"
[ -n "$worker_model" ] || fail 'WEAVER_WORKER_MODEL must be explicit on this host'
require_worker_model "$worker_executor" "$worker_model" WEAVER_WORKER_MODEL
worker_complex_model="$(env_value WEAVER_WORKER_MODEL_COMPLEX)"
if [ -n "$worker_complex_model" ]; then
  require_worker_model "$worker_executor" "$worker_complex_model" WEAVER_WORKER_MODEL_COMPLEX
fi

worker_executors=("$worker_executor")
worker_fallbacks="$(env_value WEAVER_WORKER_FALLBACKS)"
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  executor="$(parse_target_executor "$entry" WEAVER_WORKER_FALLBACKS)"
  require_worker_executor "$executor" 'every WEAVER_WORKER_FALLBACKS target'
  model="$(trim "${entry#*:}")"
  require_worker_model "$executor" "$model" 'every WEAVER_WORKER_FALLBACKS model'
  worker_executors+=("$executor")
done < <(csv_entries "$worker_fallbacks")

# The coordinator is a separate, tool-restricted process seam. Its primary is
# an explicitly registered `claude setup-token` subscription identity in
# executor-only storage, never ambient credentials or copied CLI/device state.
# A non-Claude OpenRouter fallback may use the same zero-outside-tools,
# fresh-config coordinator boundary. Claude through OpenRouter is forbidden:
# every Claude seat on this host must use the registered setup-token.
coordinator_executor="$(env_value WEAVER_COORDINATOR_EXECUTOR)"
[ -n "$coordinator_executor" ] || coordinator_executor=local-sdk
[ "$coordinator_executor" = local-sdk ] || fail 'WEAVER_COORDINATOR_EXECUTOR must be local-sdk on this host'
coordinator_model="$(env_value WEAVER_COORDINATOR_MODEL)"
case "$coordinator_model" in
  '') fail 'WEAVER_COORDINATOR_MODEL must name the direct Claude model on this host' ;;
  openrouter/*) fail 'WEAVER_COORDINATOR_MODEL must use the registered Claude Code setup-token; OpenRouter coordination is forbidden on this host' ;;
esac

coordinator_executors=("$coordinator_executor")
if env_has WEAVER_COORDINATOR_FALLBACKS; then
  coordinator_fallbacks="$(env_value WEAVER_COORDINATOR_FALLBACKS)"
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    executor="$(parse_target_executor "$entry" WEAVER_COORDINATOR_FALLBACKS)"
    [ "$executor" = local-sdk ] || fail 'every WEAVER_COORDINATOR_FALLBACKS target must use local-sdk on this host'
    model="$(trim "${entry#*:}")"
    [ -n "$model" ] || fail 'every WEAVER_COORDINATOR_FALLBACKS target must name a model'
    case "$model" in
      openrouter/~anthropic/*|openrouter/anthropic/*|openrouter/*claude*) \
        fail 'Claude coordinator fallbacks must use the registered setup-token, never OpenRouter' ;;
      openrouter/z-ai/glm-5.3) ;;
      openrouter/*) fail 'hosted OpenRouter coordinator fallback must use the reviewed fixed model openrouter/z-ai/glm-5.3' ;;
    esac
    coordinator_executors+=("$executor")
  done < <(csv_entries "$coordinator_fallbacks")
else
  coordinator_fallback_executor="$(env_value WEAVER_COORDINATOR_FALLBACK_EXECUTOR)"
  [ -n "$coordinator_fallback_executor" ] || coordinator_fallback_executor="$coordinator_executor"
  [ "$coordinator_fallback_executor" = local-sdk ] || fail 'WEAVER_COORDINATOR_FALLBACK_EXECUTOR must be local-sdk on this host'
  coordinator_fallback_model="$(env_value WEAVER_COORDINATOR_FALLBACK_MODEL)"
  [ -n "$coordinator_fallback_model" ] || fail 'WEAVER_COORDINATOR_FALLBACK_MODEL must name a model'
  case "$coordinator_fallback_model" in
    openrouter/~anthropic/*|openrouter/anthropic/*|openrouter/*claude*) \
      fail 'a Claude coordinator fallback must use the registered setup-token, never OpenRouter' ;;
    openrouter/z-ai/glm-5.3) ;;
    openrouter/*) fail 'hosted OpenRouter coordinator fallback must use the reviewed fixed model openrouter/z-ai/glm-5.3' ;;
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
for executor in "${worker_executors[@]}"; do
  capability_has "$executor" || fail 'WEAVER_RUNNER_EXECUTORS is missing a configured worker capability'
done

secure_openrouter_boundary() {
  local count value
  [ "$(env_count OPENROUTER_API_KEY)" -eq 0 ] || \
    fail 'OPENROUTER_API_KEY belongs only in the executor secret store'
  [ -r "$executor_secrets_file" ] || fail 'executor secret store is missing or unreadable'
  count="$(awk 'index($0, "OPENROUTER_API_KEY=") == 1 { count++ } END { print count + 0 }' "$executor_secrets_file")"
  [ "$count" -eq 1 ] || fail 'executor secret store must contain exactly one OPENROUTER_API_KEY'
  value="$(awk 'index($0, "OPENROUTER_API_KEY=") == 1 { print substr($0, 20) }' "$executor_secrets_file")"
  [ -n "$value" ] || fail 'OPENROUTER_API_KEY must be nonempty'
  unset value
}

secure_openrouter_boundary

secure_claude_code_subscription_boundary() {
  local key_count oauth_count oauth_value
  [ "$(env_count ANTHROPIC_API_KEY)" -eq 0 ] || \
    fail 'ANTHROPIC_API_KEY is forbidden in the ambient host env'
  [ "$(env_count CLAUDE_CODE_OAUTH_TOKEN)" -eq 0 ] || \
    fail 'CLAUDE_CODE_OAUTH_TOKEN belongs only in the executor secret store'
  key_count="$(awk 'index($0, "ANTHROPIC_API_KEY=") == 1 { count++ } END { print count + 0 }' "$executor_secrets_file")"
  oauth_count="$(awk 'index($0, "CLAUDE_CODE_OAUTH_TOKEN=") == 1 { count++ } END { print count + 0 }' "$executor_secrets_file")"
  [ "$key_count" -eq 0 ] || fail 'ANTHROPIC_API_KEY is forbidden on this host; hosted Claude must use a setup-token subscription'
  [ "$oauth_count" -eq 1 ] || fail 'hosted Claude requires exactly one CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`'
  oauth_value="$(awk 'index($0, "CLAUDE_CODE_OAUTH_TOKEN=") == 1 { print substr($0, 25) }' "$executor_secrets_file")"
  [ -n "$oauth_value" ] || fail 'CLAUDE_CODE_OAUTH_TOKEN must be nonempty'
  case "$oauth_value" in
    *,*) fail 'hosted Claude requires one setup-token, not a comma-separated token list' ;;
  esac
  unset oauth_value
}

secure_claude_code_subscription_boundary

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

  # The runner unit uses systemd's `+` ExecStartPre prefix so this root-owned
  # gate can see the other service's PID metadata. The runner process itself
  # still starts as the unprivileged `weaver` account.
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

  refuse_github_mcp_config "$service_home/.claude.json" "$service_home/.mcp.json"
  if [ -d "$service_home/.claude" ]; then
    while IFS= read -r config_file; do
      refuse_github_mcp_config "$config_file"
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
      refuse_github_mcp_config "$config_file"
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

# A containerized Claude seat is only real if the image can run the SDK's
# native binary from its read-only mount: prove it the way the worker will
# (same user, same daemon, same mount, uid 0), not with a liveness ping.
if [ "$local_sdk_container" = 1 ]; then
  # The flag is honoured by the runner's code, not by this gate: a profile that
  # says "containerized" pushed onto a checkout that predates the spawner would
  # start every worker as a host process with the secret store readable. The
  # gate therefore refuses to launch a checkout that cannot honour the flag —
  # update the checkout (the self-update timer does this from main) first.
  [ -f "$checkout_dir/src/executor/claudeContainer.ts" ] || \
    fail "the checkout at $checkout_dir predates containerized local-sdk workers; roll it forward before pushing this profile"
  claude_binary="$checkout_dir/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
  [ -x "$claude_binary" ] || fail "the SDK's native Claude Code binary is missing from the checkout at $claude_binary"
  container_image="$(env_value WEAVER_LOCAL_SDK_CONTAINER_IMAGE)"
  [ -n "$container_image" ] || fail 'WEAVER_LOCAL_SDK_CONTAINER_IMAGE must be explicit when WEAVER_LOCAL_SDK_CONTAINER=1'
  claude_binary_dir="$(dirname "$claude_binary")"
  sudo -u "$service_user" env DOCKER_HOST="$docker_host" docker run --rm --user 0 \
    --volume "$claude_binary_dir:$claude_binary_dir:ro" "$container_image" "$claude_binary" --version >/dev/null 2>&1 || \
    fail "the worker image $container_image cannot run the SDK's Claude Code binary"
fi

echo '✓ GCP execution preflight passed (workers containerized; action lane supervised; GitHub machine identity authenticated)'
