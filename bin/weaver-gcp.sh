#!/bin/bash
#
# weaver-gcp — run the fleet's resident runner on a headless GCP VM.
#
#   weaver-gcp create [--external-store]  create + provision (does not start)
#   weaver-gcp set-store          install an external Postgres URL from hidden stdin
#   weaver-gcp push-env [--restart]  merge credentials/config (no restart by default)
#   weaver-gcp push-worker-secrets NAME...  exactly sync selected global secrets
#   weaver-gcp db-tunnel INSTANCE ZONE [--port N] [--remote-port N] [--attach-identity]
#                                            keep an IAP tunnel to a private database open on the VM
#   weaver-gcp tunnel             forward Postgres + serve to localhost
#   weaver-gcp join               print the exact commands a second machine runs
#   weaver-gcp ssh [--command cmd] SSH into the VM (IAP tunnel)
#   weaver-gcp status             VM + services + runner heartbeat
#   weaver-gcp logs [unit]        tail a unit's journal (default weaver-run)
#   weaver-gcp start              start the execution runner
#   weaver-gcp stop               stop runner + ingress
#   weaver-gcp restart            restart runner + serve (after push-env / git pull)
#   weaver-gcp update [--restart] git pull + yarn install (no restart by default)
#   weaver-gcp destroy            delete the VM (asks; bundled Postgres dies too)
#
# Design notes (why it is shaped this way):
#   - The VM carries NO service account and NO scopes: an agent workload on it
#     has zero GCP API reach. Blast radius is the box, not the project.
#   - No inbound ports are opened. SSH rides the project's existing IAP rule;
#     the bundled-store path reaches Postgres and `weaver serve` through
#     `weaver-gcp tunnel`. Exposing serve publicly is never a default.
#   - Secrets travel over SSH stdin into service-user-owned 0600 files.
#     They never pass through VM metadata, gcloud args, or the Weaver store —
#     the store refuses documents embedding known secret values, and this
#     script keeps values out of places `ps`/metadata viewers can read.
#   - The default bundled Postgres remains available for a one-box fleet.
#     `create --external-store` instead provisions execution only; `set-store`
#     points that runner at shared Postgres without ever receiving the URL as
#     a command argument.

set -euo pipefail

PROJECT="${WEAVER_GCP_PROJECT:-}"
ZONE="${WEAVER_GCP_ZONE:-europe-west2-a}"
REGION="${ZONE%-*}"
VM="${WEAVER_GCP_VM:-weaver-fleet}"
MACHINE="${WEAVER_GCP_MACHINE:-e2-standard-2}"
CONCURRENCY="${WEAVER_GCP_CONCURRENCY:-4}"
NETWORK="${WEAVER_GCP_NETWORK:-weaver-vpc}"
# Service account the VM runs as, ONLY if it must open an IAP tunnel to a
# private database (weaver-gcp db-tunnel). Unset = no identity at all.
TUNNEL_SA="${WEAVER_GCP_TUNNEL_SA:-}"
SUBNET="${WEAVER_GCP_SUBNET:-weaver-subnet}"
REPO_URL="https://github.com/NiallBrickell/weaver"
REPO="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)"
PREFLIGHT="$REPO/bin/weaver-gcp-preflight.sh"

GC=()
GSSH=()

usage() { sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

resolve_target() {
  if [ -z "$PROJECT" ]; then
    PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
    echo "❌ no GCP project configured — set WEAVER_GCP_PROJECT or run: gcloud config set project <project>" >&2
    exit 1
  fi
  GC=(gcloud --project "$PROJECT")
  GSSH=(gcloud compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap)
}

vm_exists() { "${GC[@]}" compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; }

wait_for_ssh() {
  echo "waiting for SSH…"
  for _ in $(seq 1 30); do
    "${GSSH[@]}" --command 'true' >/dev/null 2>&1 && return 0
    sleep 5
  done
  echo "❌ VM did not become reachable over IAP SSH" >&2
  exit 1
}

# ── create ────────────────────────────────────────────────────────────────────
# Isolation posture (deliberate, all three hold at once):
#   - no service account / no scopes: a compromised workload cannot call any
#     GCP API as anything;
#   - its own VPC: no network path to other VPCs in the project (VPCs don't
#     route to each other unless peered — we never peer this one); the only
#     ingress rule is IAP SSH;
#   - no personal GitHub or gcloud credentials on the box: repository access
#     uses only the dedicated App identity that push-env explicitly delivers.
ensure_network() {
  "${GC[@]}" compute networks describe "$NETWORK" >/dev/null 2>&1 || \
    "${GC[@]}" compute networks create "$NETWORK" --subnet-mode custom
  "${GC[@]}" compute networks subnets describe "$SUBNET" --region "$REGION" >/dev/null 2>&1 || \
    "${GC[@]}" compute networks subnets create "$SUBNET" \
      --network "$NETWORK" --region "$REGION" --range 10.170.0.0/24
  "${GC[@]}" compute firewall-rules describe "${NETWORK}-allow-iap-ssh" >/dev/null 2>&1 || \
    "${GC[@]}" compute firewall-rules create "${NETWORK}-allow-iap-ssh" \
      --network "$NETWORK" --direction INGRESS \
      --source-ranges 35.235.240.0/20 --allow tcp:22
}

cmd_create() {
  local store_mode="bundled"
  case "${1:-}" in
    --external-store) store_mode="external"; shift ;;
    "") ;;
    *) echo "❌ usage: weaver-gcp create [--external-store]" >&2; exit 1 ;;
  esac
  [ "$#" -eq 0 ] || { echo "❌ usage: weaver-gcp create [--external-store]" >&2; exit 1; }
  [[ "$CONCURRENCY" =~ ^[1-9][0-9]*$ ]] || {
    echo "❌ WEAVER_GCP_CONCURRENCY must be a positive integer" >&2; exit 1;
  }

  ensure_network
  if vm_exists; then
    if [ "$("${GC[@]}" compute instances describe "$VM" --zone "$ZONE" --format='value(status)')" != "RUNNING" ]; then
      echo "starting existing VM $VM for provisioning (Weaver services remain stopped)…"
      "${GC[@]}" compute instances start "$VM" --zone "$ZONE"
      wait_for_ssh
    else
      echo "✓ VM $VM already exists in $ZONE — provisioning only"
    fi
  else
    local -a identity=(--no-service-account --no-scopes)
    local identity_desc="no service account"
    if [ -n "$TUNNEL_SA" ]; then
      # Opt-in: the VM runs as a service account whose only powers are the
      # ones the IAP tunnel needs (see cmd_db_tunnel). No key ever exists —
      # gcloud on the box uses the metadata server.
      identity=(--service-account "$TUNNEL_SA" --scopes https://www.googleapis.com/auth/cloud-platform)
      identity_desc="identity $TUNNEL_SA (tunnel-only)"
    fi
    echo "creating $VM ($MACHINE, $ZONE, isolated VPC, $identity_desc, no open ports)…"
    "${GC[@]}" compute instances create "$VM" \
      --zone "$ZONE" \
      --machine-type "$MACHINE" \
      --image-family debian-12 --image-project debian-cloud \
      --boot-disk-size 30GB --boot-disk-type pd-balanced \
      --network "$NETWORK" --subnet "$SUBNET" \
      "${identity[@]}" \
      --labels app=weaver
    wait_for_ssh
  fi

  if [ "$store_mode" = "external" ]; then
    echo "provisioning execution runtime (node 22, yarn, docker, systemd units; external store; no start)…"
  else
    echo "provisioning runtime (node 22, yarn, docker, bundled postgres, systemd units; no start)…"
  fi
  "${GSSH[@]}" --command "sudo env WEAVER_GCP_STORE_MODE=$store_mode WEAVER_GCP_CONCURRENCY=$CONCURRENCY bash -s" <<'PROVISION'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Swap: yarn install and concurrent worker processes spike past bare RAM
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Base runtime
apt-get update -q
apt-get install -qy git curl ca-certificates gnupg jq iproute2

# The image ships gcloud; with no service account it can authenticate as
# nothing, but a credential-less box shouldn't carry the tool at all.
# (google-guest-agent stays — SSH key delivery depends on it.)
apt-get remove -qy google-cloud-cli >/dev/null 2>&1 || true

# Node 22 (nodesource) + corepack-managed yarn 4
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -qy nodejs
fi
corepack enable

# Docker supports the bundled Postgres path and container-backed executors.
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -qy docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras
fi
# Ordinary workers must not need the root-equivalent Docker group. The
# service user gets its own rootless daemon; rootful Docker remains separate
# for the optional localhost-only bundled Postgres provisioned by root.
apt-get install -qy docker-ce-rootless-extras uidmap dbus-user-session slirp4netns

# Service user + checkout
id weaver >/dev/null 2>&1 || useradd -m -s /bin/bash weaver
if ! grep -q '^weaver:' /etc/subuid; then
  subuid_start="$(awk -F: 'BEGIN { candidate=100000 } { end=$2+$3; if (end > candidate) candidate=end } END { print candidate }' /etc/subuid)"
  usermod --add-subuids "$subuid_start-$((subuid_start + 65535))" weaver
fi
if ! grep -q '^weaver:' /etc/subgid; then
  subgid_start="$(awk -F: 'BEGIN { candidate=100000 } { end=$2+$3; if (end > candidate) candidate=end } END { print candidate }' /etc/subgid)"
  usermod --add-subgids "$subgid_start-$((subgid_start + 65535))" weaver
fi
weaver_uid="$(id -u weaver)"
weaver_runtime="/run/user/$weaver_uid"
loginctl enable-linger weaver
systemctl start "user@$weaver_uid.service"
sudo -u weaver env \
  HOME=/home/weaver USER=weaver \
  XDG_RUNTIME_DIR="$weaver_runtime" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$weaver_runtime/bus" \
  dockerd-rootless-setuptool.sh install --force
sudo -u weaver env \
  HOME=/home/weaver USER=weaver \
  XDG_RUNTIME_DIR="$weaver_runtime" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$weaver_runtime/bus" \
  systemctl --user enable --now docker
if [ ! -d /opt/weaver/.git ]; then
  git clone https://github.com/NiallBrickell/weaver /opt/weaver
  chown -R weaver:weaver /opt/weaver
fi
sudo -u weaver bash -c 'cd /opt/weaver && git pull --ff-only && yarn install'
# Root-owned copy: the service account owns the checkout, so systemd must not
# trust the checkout itself for its launch gate.
install -o root -g root -m 755 /opt/weaver/bin/weaver-gcp-preflight.sh /usr/local/sbin/weaver-gcp-preflight

# Base env. `push-env` merges portable credentials/config into this file and
# preserves host-local settings instead of rebuilding it from two selected
# lines. The runner already holds every value in its process env, so allowing
# that same service user to read it widens nothing and keeps ad-hoc CLI honest.
mkdir -p /etc/weaver
touch /etc/weaver/env && chown weaver:weaver /etc/weaver/env && chmod 600 /etc/weaver/env
# Rootless Docker's `host-gateway` resolves to the daemon's inner bridge, not
# the VM host. The authenticated submission/MCP/provider bridges bind the host
# interfaces, so install the VM's actual private IPv4 as host-local config.
# Refresh it on every provision instead of shipping topology from the laptop.
openhands_host_gateway="$(ip -4 route get 192.0.2.1 | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
awk -v value="$openhands_host_gateway" 'BEGIN {
  count = split(value, octets, ".")
  if (count != 4) exit 1
  for (i = 1; i <= 4; i++) if (octets[i] !~ /^[0-9]+$/ || octets[i] > 255) exit 1
}' || { echo 'could not determine the VM private IPv4 for OpenHands bridges' >&2; exit 1; }
sed -i '\|^WEAVER_OPENHANDS_HOST_GATEWAY_IP=|d' /etc/weaver/env
printf '%s\n' "WEAVER_OPENHANDS_HOST_GATEWAY_IP=$openhands_host_gateway" >> /etc/weaver/env
# Older revisions sourced the env as shell syntax. Values such as JSON and
# tokens are data, not shell, so remove that legacy hook. The wrapper below
# validates and exports each complete KEY=value line without eval instead.
sed -i '\|etc/weaver/env|d' /home/weaver/.bashrc 2>/dev/null || true
cat > /usr/local/bin/weaver <<'EOF'
#!/bin/bash
# CLI onto the hosted fleet: same env the systemd services run with.
set -euo pipefail
if [ -r /etc/weaver/env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || {
      echo "malformed Weaver host env key: $key" >&2; exit 1;
    }
    export "$line"
  done < /etc/weaver/env
fi
cd /opt/weaver && exec yarn weaver "$@"
EOF
chmod 755 /usr/local/bin/weaver
grep -q '^WEAVER_HOME=' /etc/weaver/env || echo 'WEAVER_HOME=/home/weaver/state' >> /etc/weaver/env
grep -q '^WEAVER_WORKSPACE_ROOT=' /etc/weaver/env || echo 'WEAVER_WORKSPACE_ROOT=/home/weaver/workspaces' >> /etc/weaver/env
# Persist the VM's stable hostname as an explicit fleet runner identity. A
# later push-env preserves host-local values, so laptop identity can never
# overwrite this placement boundary.
grep -q '^WEAVER_RUNNER_ID=' /etc/weaver/env || printf 'WEAVER_RUNNER_ID=%s\n' "$(hostname)" >> /etc/weaver/env
mkdir -p /home/weaver/state /home/weaver/workspaces
chown -R weaver:weaver /home/weaver/state /home/weaver/workspaces

# One audited write path for the service-user env file. Both modes read
# values on stdin: credentials and database URLs never enter argv, gcloud's
# command log, or command output. `merge` replaces only the keys it receives
# and preserves every host-local line not in the render.
install -o root -g root -m 755 /opt/weaver/bin/weaver-install-env.sh /usr/local/sbin/weaver-install-env

if [ "$WEAVER_GCP_STORE_MODE" = "bundled" ]; then
  # Fleet Postgres: localhost-only, password generated once and kept on the box.
  if [ ! -f /etc/weaver/pg-password ]; then
    openssl rand -hex 16 > /etc/weaver/pg-password
    chmod 600 /etc/weaver/pg-password
  fi
  PGPASS="$(cat /etc/weaver/pg-password)"
  if ! docker inspect weaver-pg >/dev/null 2>&1; then
    docker run -d --name weaver-pg --restart unless-stopped \
      -p 127.0.0.1:5432:5432 \
      -e POSTGRES_USER=weaver -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=weaver \
      -v weaver-pg-data:/var/lib/postgresql/data \
      postgres:16
  fi
  grep -q '^WEAVER_STORE=' /etc/weaver/env || \
    echo "WEAVER_STORE=postgres://weaver:${PGPASS}@127.0.0.1:5432/weaver" >> /etc/weaver/env
fi

# systemd units
cat > /etc/systemd/system/weaver-run.service <<EOF
[Unit]
Description=Weaver resident runner
After=network-online.target user@$weaver_uid.service
Wants=network-online.target user@$weaver_uid.service

[Service]
User=weaver
Environment=DOCKER_HOST=unix:///run/user/$weaver_uid/docker.sock
WorkingDirectory=/opt/weaver
ExecStartPre=+/usr/local/sbin/weaver-gcp-preflight
ExecStart=/usr/local/bin/weaver run --interval 5 --concurrency $WEAVER_GCP_CONCURRENCY
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/weaver-serve.service <<'EOF'
[Unit]
Description=Weaver ingress adapter
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=weaver
WorkingDirectory=/opt/weaver
ExecStart=/usr/local/bin/weaver serve --host 127.0.0.1 --port 9723
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
if [ "$WEAVER_GCP_STORE_MODE" = "external" ]; then
  # The explicit `start` is the cutover and enables only execution. A reboot
  # between provisioning and that act must not start against an unset/old DB.
  systemctl disable --now weaver-run weaver-serve >/dev/null 2>&1 || true
  echo "✓ provisioned (units installed but disabled; no service started)"
else
  systemctl enable weaver-run weaver-serve
  echo "✓ provisioned (units enabled; no service started)"
fi
PROVISION

  if [ "$store_mode" = "external" ]; then
    echo "✓ provisioned without starting — next: weaver-gcp set-store, then push-env, then start"
  else
    echo "✓ provisioned without starting — next: weaver-gcp push-env, then start"
  fi
}

# ── external store ───────────────────────────────────────────────────────────
# The URL is accepted only on stdin (hidden when interactive) and forwarded as
# SSH stdin. It is never a shell argument, command-log field, or output line.
cmd_set_store() {
  [ "$#" -eq 0 ] || { echo "❌ usage: weaver-gcp set-store" >&2; exit 1; }
  local store
  if [ -t 0 ]; then
    printf 'paste the external Postgres URL and press Enter (input hidden): ' >&2
    IFS= read -r -s store
    printf '\n' >&2
  else
    IFS= read -r store
  fi
  case "$store" in
    postgres://*|postgresql://*) ;;
    *) echo "❌ external store must be a postgres:// or postgresql:// URL" >&2; exit 1 ;;
  esac
  case "$store" in
    *[[:space:]]*) echo "❌ external Postgres URL must not contain whitespace" >&2; exit 1 ;;
  esac
  printf '%s\n' "$store" | "${GSSH[@]}" --command 'sudo /usr/local/sbin/weaver-install-env store'
  unset store
  echo "✓ external Postgres installed in /etc/weaver/env; services were not restarted"
}

# Ship this checkout's public installer before asking the host to consume any
# credential input. A host on an older Weaver revision may not know the mode;
# helper code and secret values travel on separate SSH calls.
push_remote_installer() {
  "${GSSH[@]}" --command 'helper="/tmp/weaver-install-env.local.$$"; staged="/usr/local/sbin/.weaver-install-env.$$"; trap "rm -f -- $helper; sudo rm -f -- $staged" EXIT; umask 077; cat > "$helper"; sudo install -o root -g root -m 755 "$helper" "$staged"; sudo mv -f "$staged" /usr/local/sbin/weaver-install-env' < "$REPO/bin/weaver-install-env.sh"
}

# ── push-env ──────────────────────────────────────────────────────────────────
# Renders the service env and the exact executor-only credential store from the
# laptop, then ships both over SSH stdin. Values never appear in argv or VM
# metadata. Adapters deliberately load the latter instead of ambient identity.
cmd_push_env() {
  local restart=0
  local hosted_worker_model hosted_worker_complex_model hosted_worker_fallbacks
  local hosted_coordinator_model hosted_coordinator_fallbacks
  case "${1:-}" in
    --restart) restart=1; shift ;;
    "") ;;
    *) echo "❌ usage: weaver-gcp push-env [--restart]" >&2; exit 1 ;;
  esac
  [ "$#" -eq 0 ] || { echo "❌ usage: weaver-gcp push-env [--restart]" >&2; exit 1; }
  hosted_worker_model="${WEAVER_GCP_WORKER_MODEL:-openrouter/z-ai/glm-5.3}"
  hosted_worker_complex_model="${WEAVER_GCP_WORKER_MODEL_COMPLEX:-$hosted_worker_model}"
  hosted_worker_fallbacks="${WEAVER_GCP_WORKER_FALLBACKS:-}"
  # The always-on controller starts on an explicitly registered Claude Code
  # setup-token. Opus on that same token is the first fallback: on 2026-09-02
  # the Fable seat's weekly allowance ran out while Opus still answered, and
  # with only the OpenRouter seat behind it (out of credits at the time) every
  # coordinator pass on the host failed for a day. The non-Claude OpenRouter
  # seat stays as the last hosted recovery path; Codex remains local-only
  # because personal device authentication is never copied to this
  # credential-bearing host.
  hosted_coordinator_model="${WEAVER_GCP_COORDINATOR_MODEL:-claude-fable-5}"
  hosted_coordinator_fallbacks="${WEAVER_GCP_COORDINATOR_FALLBACKS:-local-sdk:claude-opus-5,local-sdk:openrouter/z-ai/glm-5.3}"

  PUSH_ENV_RAW_TMP="$(mktemp)"
  PUSH_ENV_TMP="$(mktemp)"
  PUSH_EXECUTOR_SECRETS_RAW_TMP="$(mktemp)"
  PUSH_EXECUTOR_SECRETS_TMP="$(mktemp)"
  trap 'rm -f -- "${PUSH_ENV_RAW_TMP:-}" "${PUSH_ENV_TMP:-}" "${PUSH_EXECUTOR_SECRETS_RAW_TMP:-}" "${PUSH_EXECUTOR_SECRETS_TMP:-}"' EXIT
  chmod 600 "$PUSH_ENV_RAW_TMP" "$PUSH_ENV_TMP" "$PUSH_EXECUTOR_SECRETS_RAW_TMP" "$PUSH_EXECUTOR_SECRETS_TMP"
  env \
    WEAVER_EXECUTOR=openhands \
    WEAVER_WORKER_MODEL="$hosted_worker_model" \
    WEAVER_WORKER_MODEL_COMPLEX="$hosted_worker_complex_model" \
    WEAVER_WORKER_FALLBACKS="$hosted_worker_fallbacks" \
    WEAVER_COORDINATOR_EXECUTOR=local-sdk \
    WEAVER_COORDINATOR_MODEL="$hosted_coordinator_model" \
    WEAVER_COORDINATOR_FALLBACK_EXECUTOR=local-sdk \
    WEAVER_COORDINATOR_FALLBACK_MODEL="$hosted_coordinator_model" \
    WEAVER_COORDINATOR_FALLBACKS="$hosted_coordinator_fallbacks" \
    WEAVER_ACTION_EXECUTOR=local-sdk \
    WEAVER_DETERMINISTIC_ACTIONS_ONLY=1 \
    WEAVER_RUNNER_EXECUTORS=openhands,local-sdk \
    "$REPO/bin/weaver.mjs" login --render-remote-env > "$PUSH_ENV_RAW_TMP"
  # Provider/App identities have their own exact executor-only synchronization
  # below. Do not duplicate them into the ambient systemd environment; only
  # the ingress bearer and non-secret runner configuration belong there.
  awk -F= '
    {
      key = $1
      if (key ~ /_API_KEY$/ || key == "CLAUDE_CODE_OAUTH_TOKEN" ||
          key == "ANTHROPIC_AUTH_TOKEN" || key == "GH_TOKEN" ||
          key == "GITHUB_TOKEN") next
      print
    }
  ' "$PUSH_ENV_RAW_TMP" > "$PUSH_ENV_TMP"
  if [ ! -s "$PUSH_ENV_TMP" ]; then
    echo "❌ weaver login produced no remote env — run: weaver login" >&2; exit 1
  fi
  "$REPO/bin/weaver.mjs" login --render-remote-executor-secrets > "$PUSH_EXECUTOR_SECRETS_RAW_TMP"
  awk -F= '
    $1 == "CLAUDE_CODE_OAUTH_TOKEN" ||
    $1 == "OPENROUTER_API_KEY" ||
    $1 == "WEAVER_GITHUB_APP_ID" ||
    $1 == "WEAVER_GITHUB_APP_INSTALLATION_ID" ||
    $1 == "WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64" ||
    $1 == "WEAVER_PILOT_TOKEN" ||
    $1 == "WEAVER_SERVE_TOKEN" { print }
  ' "$PUSH_EXECUTOR_SECRETS_RAW_TMP" > "$PUSH_EXECUTOR_SECRETS_TMP"
  push_remote_installer
  "${GSSH[@]}" --command 'sudo /usr/local/sbin/weaver-install-env merge' < "$PUSH_ENV_TMP"
  "${GSSH[@]}" --command 'sudo /usr/local/sbin/weaver-install-env executor-secrets' < "$PUSH_EXECUTOR_SECRETS_TMP"
  if [ "$restart" -eq 1 ]; then
    run_after_execution_preflight restart
    echo "✓ env + executor identities installed, services restarted"
  else
    echo "✓ env + executor identities installed; services were not restarted"
  fi
  rm -f -- "$PUSH_ENV_RAW_TMP" "$PUSH_ENV_TMP" "$PUSH_EXECUTOR_SECRETS_RAW_TMP" "$PUSH_EXECUTOR_SECRETS_TMP"
  PUSH_ENV_RAW_TMP=""
  PUSH_ENV_TMP=""
  PUSH_EXECUTOR_SECRETS_RAW_TMP=""
  PUSH_EXECUTOR_SECRETS_TMP=""
  trap - EXIT
}

# ── push-worker-secrets ───────────────────────────────────────────────────────
# Global worker credentials are a separate scope from executor identities. The
# operator names the exact least-privilege set to install; the local CLI reads
# their values from Weaver's global 0600 store and renders only to this private
# temporary file. The host receives values solely on SSH stdin and atomically
# replaces its whole global store, so omitted names are revoked.
cmd_push_worker_secrets() {
  [ "$#" -gt 0 ] || {
    echo "❌ usage: weaver-gcp push-worker-secrets NAME..." >&2; exit 1;
  }

  local name
  local seen_names="|"
  for name in "$@"; do
    [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || {
      echo "❌ invalid worker secret name '$name' — use UPPER_SNAKE_CASE" >&2; exit 1;
    }
    case "$seen_names" in
      *"|$name|"*)
        echo "❌ duplicate worker secret name '$name'" >&2; exit 1;
        ;;
    esac
    seen_names="${seen_names}${name}|"
  done

  PUSH_WORKER_SECRETS_TMP="$(mktemp)"
  trap 'rm -f -- "${PUSH_WORKER_SECRETS_TMP:-}"' EXIT
  chmod 600 "$PUSH_WORKER_SECRETS_TMP"
  "$REPO/bin/weaver.mjs" secret render-selected "$@" > "$PUSH_WORKER_SECRETS_TMP"
  [ -s "$PUSH_WORKER_SECRETS_TMP" ] || {
    echo "❌ selected worker secret render was empty" >&2; exit 1;
  }

  push_remote_installer
  "${GSSH[@]}" --command 'sudo /usr/local/sbin/weaver-install-env worker-secrets' < "$PUSH_WORKER_SECRETS_TMP"
  echo "✓ $# selected worker secret(s) installed exactly; services were not restarted"

  rm -f -- "$PUSH_WORKER_SECRETS_TMP"
  PUSH_WORKER_SECRETS_TMP=""
  trap - EXIT
}

# ── tunnel ────────────────────────────────────────────────────────────────────
cmd_tunnel() {
  echo "forwarding localhost:6543 → fleet Postgres, localhost:9723 → weaver serve"
  echo "  laptop store URL: postgres://weaver:<pg-password>@127.0.0.1:6543/weaver"
  echo "  (password: weaver-gcp ssh 'sudo cat /etc/weaver/pg-password')"
  "${GSSH[@]}" -- -N -L 6543:127.0.0.1:5432 -L 9723:127.0.0.1:9723
}

# ── db-tunnel ────────────────────────────────────────────────────────────────
# A database with no public address is reached through an IAP tunnel to a
# bastion inside its VPC. Actions run on this host with the worker secrets in
# their env, so the tunnel lives here as a systemd unit on a fixed local port
# and the secret DSN points at 127.0.0.1:PORT. gcloud on the VM authenticates
# as the VM's service account (WEAVER_GCP_TUNNEL_SA) through the metadata
# server — no key on disk. That account should be able to open the tunnel to
# INSTANCE and read INSTANCE, nothing else in the project.
#
# Attaching the identity to an existing VM requires a stop/start, which ends
# whatever the runner is doing; it only happens with --attach-identity.
cmd_db_tunnel() {
  local instance="${1:-}" zone="${2:-}" port=55432 remote_port=5432 attach=0
  [ -n "$instance" ] && [ -n "$zone" ] || {
    echo "❌ usage: weaver-gcp db-tunnel INSTANCE ZONE [--port N] [--remote-port N] [--attach-identity]" >&2; exit 1;
  }
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --port) port="${2:?--port needs a value}"; shift 2 ;;
      --remote-port) remote_port="${2:?--remote-port needs a value}"; shift 2 ;;
      --attach-identity) attach=1; shift ;;
      *) echo "❌ unknown option $1" >&2; exit 1 ;;
    esac
  done
  [ -n "$TUNNEL_SA" ] || { echo "❌ set WEAVER_GCP_TUNNEL_SA to the service account the VM should run as" >&2; exit 1; }
  vm_exists || { echo "❌ VM $VM does not exist in $ZONE" >&2; exit 1; }

  local current
  current="$("${GC[@]}" compute instances describe "$VM" --zone "$ZONE" --format='value(serviceAccounts[0].email)')"
  if [ "$current" != "$TUNNEL_SA" ]; then
    if [ "$attach" -ne 1 ]; then
      echo "❌ $VM runs as '${current:-no service account}', not $TUNNEL_SA." >&2
      echo "   Attaching it stops and starts the VM (interrupting the runner); re-run with --attach-identity." >&2
      exit 1
    fi
    echo "attaching $TUNNEL_SA to $VM (stop → set identity → start)…"
    "${GC[@]}" compute instances stop "$VM" --zone "$ZONE"
    "${GC[@]}" compute instances set-service-account "$VM" --zone "$ZONE" \
      --service-account "$TUNNEL_SA" --scopes https://www.googleapis.com/auth/cloud-platform
    "${GC[@]}" compute instances start "$VM" --zone "$ZONE"
    wait_for_ssh
  fi

  echo "installing tunnel unit on $VM → $instance:$remote_port ($zone) at 127.0.0.1:$port…"
  "${GSSH[@]}" --command "sudo bash -s" <<INSTALL
set -euo pipefail
if ! command -v gcloud >/dev/null 2>&1; then
  apt-get install -qy apt-transport-https ca-certificates gnupg curl >/dev/null
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -q >/dev/null && apt-get install -qy google-cloud-cli >/dev/null
fi
cat > /etc/systemd/system/weaver-db-tunnel.service <<EOF
[Unit]
Description=IAP tunnel to the private database bastion ($instance)
After=network-online.target
Wants=network-online.target

[Service]
User=weaver
ExecStart=/usr/bin/gcloud compute start-iap-tunnel $instance $remote_port --project $PROJECT --zone $zone --local-host-port=localhost:$port
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now weaver-db-tunnel
for _ in \$(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then echo "✓ tunnel up on 127.0.0.1:$port"; exit 0; fi
  sleep 1
done
echo "❌ tunnel not accepting after 60s:" >&2
journalctl -u weaver-db-tunnel -n 30 --no-pager >&2
exit 1
INSTALL
  echo "   worker DSNs on this host should use 127.0.0.1:$port (push them with push-worker-secrets)"
}

# ── join ──────────────────────────────────────────────────────────────────────
# Everything a second machine needs, ready to paste. The store password is
# fetched over SSH and embedded in the link URL — which `weaver link` persists
# into the (gitignored) repo .env and always prints redacted.
cmd_join() {
  local pw
  pw="$("${GSSH[@]}" --command 'sudo cat /etc/weaver/pg-password' 2>/dev/null | tr -d '[:space:]')"
  [ -n "$pw" ] || { echo "❌ could not read the fleet Postgres password (is the VM up?)" >&2; exit 1; }
  cat <<EOF
On the joining machine (needs: this repo cloned, gcloud authed with IAP access):

  # 1. keep a tunnel to the fleet open
  bin/weaver-gcp.sh tunnel

  # 2. in another terminal — join the fleet, then register execution identity
  weaver link "postgres://weaver:${pw}@127.0.0.1:6543/weaver"
  weaver login
EOF
}

# ── small ones ────────────────────────────────────────────────────────────────
cmd_ssh()     { "${GSSH[@]}" "$@"; }
cmd_logs()    { "${GSSH[@]}" --command "sudo journalctl -u ${1:-weaver-run} -n 100 -f"; }
run_after_execution_preflight() {
  local action="$1" remote_systemctl
  [ -r "$PREFLIGHT" ] || { echo "❌ missing GCP execution preflight: $PREFLIGHT" >&2; exit 1; }
  case "$action" in
    start) remote_systemctl='enable --now weaver-run' ;;
    restart) remote_systemctl='restart weaver-run weaver-serve' ;;
    *) echo "❌ internal error: unknown post-preflight action" >&2; exit 1 ;;
  esac
  "${GSSH[@]}" --command "preflight=/tmp/weaver-gcp-preflight.\$\$; trap 'rm -f -- \"\$preflight\"' EXIT; umask 077; cat > \"\$preflight\"; sudo install -o root -g root -m 755 \"\$preflight\" /usr/local/sbin/weaver-gcp-preflight; sudo /usr/local/sbin/weaver-gcp-preflight; sudo systemctl $remote_systemctl" < "$PREFLIGHT"
}
cmd_start()   { run_after_execution_preflight start; echo "✓ runner enabled + started"; }
cmd_stop()    { "${GSSH[@]}" --command 'sudo systemctl stop weaver-run weaver-serve'; echo "✓ stopped"; }
cmd_restart() { run_after_execution_preflight restart; echo "✓ restarted"; }
cmd_update()  {
  local restart=0
  case "${1:-}" in
    --restart) restart=1; shift ;;
    "") ;;
    *) echo "❌ usage: weaver-gcp update [--restart]" >&2; exit 1 ;;
  esac
  [ "$#" -eq 0 ] || { echo "❌ usage: weaver-gcp update [--restart]" >&2; exit 1; }
  "${GSSH[@]}" --command 'sudo -u weaver bash -c "cd /opt/weaver && git pull --ff-only && yarn install"'
  if [ "$restart" -eq 1 ]; then
    run_after_execution_preflight restart
    echo "✓ updated + restarted"
  else
    echo "✓ updated; services were not restarted"
  fi
}
cmd_status()  {
  "${GC[@]}" compute instances describe "$VM" --zone "$ZONE" \
    --format='value(name,status,machineType.basename(),networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null \
    || { echo "VM $VM: not created"; exit 1; }
  "${GSSH[@]}" --command '
    systemctl is-active weaver-run weaver-serve docker | paste - - - | sed "s/^/services (run serve docker): /"
    hb=/home/weaver/state/.runner.heartbeat
    if sudo test -f $hb; then echo "runner heartbeat: $(( $(date +%s) - $(sudo stat -c %Y $hb) ))s ago"; else echo "runner heartbeat: none yet"; fi
  '
}
cmd_destroy() {
  read -r -p "Delete VM $VM and any bundled Postgres data? Type the VM name to confirm: " ans
  [ "$ans" = "$VM" ] || { echo "aborted"; exit 1; }
  "${GC[@]}" compute instances delete "$VM" --zone "$ZONE" --quiet
}

case "${1:-}" in -h|--help|help|"") usage;; esac
resolve_target

case "${1:-}" in
  create)   shift; cmd_create "$@";;
  set-store) shift; cmd_set_store "$@";;
  push-env) shift; cmd_push_env "$@";;
  push-worker-secrets) shift; cmd_push_worker_secrets "$@";;
  tunnel)   shift; cmd_tunnel "$@";;
  db-tunnel) shift; cmd_db_tunnel "$@";;
  join)     shift; cmd_join "$@";;
  ssh)      shift; cmd_ssh "$@";;
  logs)     shift; cmd_logs "$@";;
  start)    shift; cmd_start "$@";;
  stop)     shift; cmd_stop "$@";;
  restart)  shift; cmd_restart "$@";;
  update)   shift; cmd_update "$@";;
  status)   shift; cmd_status "$@";;
  destroy)  shift; cmd_destroy "$@";;
  *) echo "❌ unknown command: $1 (see --help)" >&2; exit 1;;
esac
