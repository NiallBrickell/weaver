#!/bin/bash
#
# weaver-gcp — run the fleet's resident runner on a headless GCP VM.
#
#   weaver-gcp create             create + provision the VM (idempotent-ish)
#   weaver-gcp push-env           render /etc/weaver/env on the VM from local creds
#   weaver-gcp tunnel             forward Postgres + serve to localhost
#   weaver-gcp join               print the exact commands a second machine runs
#   weaver-gcp ssh [cmd…]         SSH into the VM (IAP tunnel)
#   weaver-gcp status             VM + services + runner heartbeat
#   weaver-gcp logs [unit]        tail a unit's journal (default weaver-run)
#   weaver-gcp restart            restart runner + serve (after push-env / git pull)
#   weaver-gcp update             git pull + yarn install on the VM, then restart
#   weaver-gcp destroy            delete the VM (asks; Postgres data dies with it)
#
# Design notes (why it is shaped this way):
#   - The VM carries NO service account and NO scopes: an agent workload on it
#     has zero GCP API reach. Blast radius is the box, not the project.
#   - No inbound ports are opened. SSH rides the project's existing IAP rule;
#     laptops reach Postgres and `weaver serve` through `weaver-gcp tunnel`.
#     Exposing serve publicly is a later, deliberate step — not a default.
#   - Secrets travel over SSH stdin into a root-owned 0600 EnvironmentFile.
#     They never pass through VM metadata, gcloud args, or the Weaver store —
#     the store refuses documents embedding known secret values, and this
#     script keeps values out of places `ps`/metadata viewers can read.
#   - Postgres runs in Docker on the VM, bound to 127.0.0.1. The fleet store
#     is reachable from laptops only through the tunnel; `weaver login --remote`
#     (see docs-public/hosting.md) is how a laptop joins the fleet.

set -euo pipefail

PROJECT="${WEAVER_GCP_PROJECT:-erdo-ai}"
ZONE="${WEAVER_GCP_ZONE:-europe-west2-a}"
REGION="${ZONE%-*}"
VM="${WEAVER_GCP_VM:-weaver-fleet}"
MACHINE="${WEAVER_GCP_MACHINE:-e2-standard-2}"
NETWORK="${WEAVER_GCP_NETWORK:-weaver-vpc}"
SUBNET="${WEAVER_GCP_SUBNET:-weaver-subnet}"
REPO_URL="https://github.com/NiallBrickell/weaver"
REPO="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)"

GC=(gcloud --project "$PROJECT")
GSSH=(gcloud compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --tunnel-through-iap)

usage() { sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

vm_exists() { "${GC[@]}" compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; }

# ── create ────────────────────────────────────────────────────────────────────
# Isolation posture (deliberate, all three hold at once):
#   - no service account / no scopes: a compromised workload cannot call any
#     GCP API as anything;
#   - its own VPC: no network path to other VPCs in the project (VPCs don't
#     route to each other unless peered — we never peer this one); the only
#     ingress rule is IAP SSH;
#   - no GitHub or gcloud credentials on the box: only the model/provider
#     secrets push-env explicitly delivers.
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
  ensure_network
  if vm_exists; then
    echo "✓ VM $VM already exists in $ZONE — provisioning only"
  else
    echo "creating $VM ($MACHINE, $ZONE, isolated VPC, no service account, no open ports)…"
    "${GC[@]}" compute instances create "$VM" \
      --zone "$ZONE" \
      --machine-type "$MACHINE" \
      --image-family debian-12 --image-project debian-cloud \
      --boot-disk-size 30GB --boot-disk-type pd-balanced \
      --network "$NETWORK" --subnet "$SUBNET" \
      --no-service-account --no-scopes \
      --labels app=weaver,owner=niall
    echo "waiting for SSH…"
    for _ in $(seq 1 30); do
      "${GSSH[@]}" --command 'true' >/dev/null 2>&1 && break
      sleep 5
    done
  fi

  echo "provisioning runtime (node 22, yarn, docker, postgres, systemd units)…"
  "${GSSH[@]}" --command 'sudo bash -s' <<'PROVISION'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Swap: yarn install and concurrent worker processes spike past bare RAM
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Base runtime
apt-get update -q
apt-get install -qy git curl ca-certificates gnupg jq

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

# Docker (for the fleet Postgres)
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -qy docker-ce docker-ce-cli containerd.io
fi

# Service user + checkout
id weaver >/dev/null 2>&1 || useradd -m -s /bin/bash weaver
if [ ! -d /opt/weaver/.git ]; then
  git clone https://github.com/NiallBrickell/weaver /opt/weaver
  chown -R weaver:weaver /opt/weaver
fi
sudo -u weaver bash -c 'cd /opt/weaver && git pull --ff-only && yarn install'

# Fleet Postgres: localhost-only, password generated once and kept on the box
if [ ! -f /etc/weaver/pg-password ]; then
  mkdir -p /etc/weaver
  # openssl, not `tr </dev/urandom | head`: head's early close SIGPIPEs tr,
  # which `set -o pipefail` escalates into an abort of the whole provision.
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

# Base (non-secret) env — push-env appends the secret half. Owned by the
# weaver user: the runner already holds every value in its process env, so
# user-readability widens nothing — and it lets ad-hoc CLI use on the box
# (weaver status, weaver log) see the same fleet the services do.
touch /etc/weaver/env && chown weaver:weaver /etc/weaver/env && chmod 600 /etc/weaver/env
if ! grep -q 'etc/weaver/env' /home/weaver/.bashrc 2>/dev/null; then
  echo 'set -a; [ -r /etc/weaver/env ] && . /etc/weaver/env; set +a' >> /home/weaver/.bashrc
fi
cat > /usr/local/bin/weaver <<'EOF'
#!/bin/bash
# CLI onto the hosted fleet: same env the systemd services run with.
set -a; [ -r /etc/weaver/env ] && . /etc/weaver/env; set +a
cd /opt/weaver && exec yarn weaver "$@"
EOF
chmod 755 /usr/local/bin/weaver
grep -q '^WEAVER_STORE=' /etc/weaver/env || cat >> /etc/weaver/env <<EOF
WEAVER_STORE=postgres://weaver:${PGPASS}@127.0.0.1:5432/weaver
WEAVER_HOME=/home/weaver/state
EOF

# systemd units
cat > /etc/systemd/system/weaver-run.service <<'EOF'
[Unit]
Description=Weaver resident runner
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=weaver
WorkingDirectory=/opt/weaver
EnvironmentFile=/etc/weaver/env
ExecStart=/usr/bin/yarn weaver run --interval 5
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
EnvironmentFile=/etc/weaver/env
ExecStart=/usr/bin/yarn weaver serve --host 127.0.0.1 --port 9723
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable weaver-run weaver-serve
echo "✓ provisioned (units enabled; they start once push-env has delivered credentials)"
PROVISION

  echo "✓ create done — next: weaver-gcp push-env"
}

# ── push-env ──────────────────────────────────────────────────────────────────
# Renders the secret half of /etc/weaver/env from the laptop's credentials and
# ships it over SSH stdin. Values never appear in argv or VM metadata.
cmd_push_env() {
  local tmp; tmp="$(mktemp)"; trap 'rm -f "${tmp:-}"' EXIT
  "$REPO/bin/weaver.mjs" login --render-remote-env > "$tmp"
  if [ ! -s "$tmp" ]; then
    echo "❌ weaver login produced no remote env — run: weaver login" >&2; exit 1
  fi
  "${GSSH[@]}" --command 'sudo bash -c "
    set -euo pipefail
    umask 077
    grep ^WEAVER_STORE= /etc/weaver/env > /etc/weaver/env.base || true
    grep ^WEAVER_HOME= /etc/weaver/env >> /etc/weaver/env.base || true
    cat /etc/weaver/env.base - > /etc/weaver/env.new
    mv /etc/weaver/env.new /etc/weaver/env
    rm -f /etc/weaver/env.base
    chmod 600 /etc/weaver/env
  "' < "$tmp"
  # Codex auth rides alongside if the local machine has it
  if [ -f "$HOME/.codex/auth.json" ]; then
    "${GSSH[@]}" --command 'sudo -u weaver bash -c "umask 077; mkdir -p ~/.codex; cat > ~/.codex/auth.json"' \
      < "$HOME/.codex/auth.json"
    echo "✓ codex auth.json delivered"
  fi
  "${GSSH[@]}" --command 'sudo systemctl restart weaver-run weaver-serve'
  echo "✓ env delivered, services restarted"
}

# ── tunnel ────────────────────────────────────────────────────────────────────
cmd_tunnel() {
  echo "forwarding localhost:6543 → fleet Postgres, localhost:9723 → weaver serve"
  echo "  laptop store URL: postgres://weaver:<pg-password>@127.0.0.1:6543/weaver"
  echo "  (password: weaver-gcp ssh 'sudo cat /etc/weaver/pg-password')"
  "${GSSH[@]}" -- -N -L 6543:127.0.0.1:5432 -L 9723:127.0.0.1:9723
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
cmd_restart() { "${GSSH[@]}" --command 'sudo systemctl restart weaver-run weaver-serve'; echo "✓ restarted"; }
cmd_update()  {
  "${GSSH[@]}" --command 'sudo -u weaver bash -c "cd /opt/weaver && git pull --ff-only && yarn install" && sudo systemctl restart weaver-run weaver-serve'
  echo "✓ updated + restarted"
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
  read -r -p "Delete VM $VM and its Postgres data? Type the VM name to confirm: " ans
  [ "$ans" = "$VM" ] || { echo "aborted"; exit 1; }
  "${GC[@]}" compute instances delete "$VM" --zone "$ZONE" --quiet
}

case "${1:-}" in
  create)   shift; cmd_create "$@";;
  push-env) shift; cmd_push_env "$@";;
  tunnel)   shift; cmd_tunnel "$@";;
  join)     shift; cmd_join "$@";;
  ssh)      shift; cmd_ssh "$@";;
  logs)     shift; cmd_logs "$@";;
  restart)  shift; cmd_restart "$@";;
  update)   shift; cmd_update "$@";;
  status)   shift; cmd_status "$@";;
  destroy)  shift; cmd_destroy "$@";;
  -h|--help|help|"") usage;;
  *) echo "❌ unknown command: $1 (see --help)" >&2; exit 1;;
esac
