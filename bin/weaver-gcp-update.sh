#!/bin/bash
# The hosted runner rolls itself forward: fetch main, fast-forward the
# checkout, reinstall dependencies, restart the ingress adapter.
#
# Until 2026-09-15 nothing on the VM ever pulled. Every fix to the runner —
# the full-disk degraded probe, the tick-lock crash — reached the fleet only
# when a person with gcloud ran `weaver-gcp update --restart` by hand, and
# expired cloud credentials made that step the one every incident waited on.
# A merged fix that never deploys is not a fix.
#
# What this script deliberately does NOT do:
#   - It never copies anything root-executable out of the checkout. The
#     service user owns /opt/weaver, so the launch preflight
#     (/usr/local/sbin/weaver-gcp-preflight) and this updater itself stay
#     root-owned copies installed by the operator; code updates automatically,
#     the launch gate does not.
#   - It never restarts weaver-run. The runner notices its own checkout
#     moving (runnerSourceStale), stops dispatching, drains in-flight ticks
#     for a bounded window, and exits; systemd's Restart=always relaunches it
#     on the new code through the preflight. Killing it here would orphan
#     every in-flight action behind its lease.
#
# Installed by weaver-gcp.sh as /usr/local/sbin/weaver-gcp-update and run by
# weaver-update.timer. `install` writes the host's periodic units — that timer
# and the daily digest's — so `weaver-gcp update` brings an existing VM's units
# up to date, not only a freshly provisioned one. The digest shipped in code on
# 2026-09-21 and never reached the running fleet, because only provisioning
# wrote its units.

set -euo pipefail

repo="${WEAVER_GCP_UPDATE_REPO:-/opt/weaver}"
service_user="${WEAVER_GCP_UPDATE_SERVICE_USER:-weaver}"
unit_dir="${WEAVER_GCP_UPDATE_UNIT_DIR:-/etc/systemd/system}"
self="${WEAVER_GCP_UPDATE_SELF:-/usr/local/sbin/weaver-gcp-update}"
branch="${WEAVER_GCP_UPDATE_BRANCH:-main}"
lock_dir="${WEAVER_GCP_UPDATE_LOCK:-/run/lock/weaver-gcp-update}"
lock_wait="${WEAVER_GCP_UPDATE_LOCK_WAIT:-300}"

fail() {
  printf '❌ weaver-gcp-update: %s\n' "$1" >&2
  exit 1
}

# Run a command as the service user. Root drops to it; the service user (or a
# test running as itself) runs directly. Anyone else has no business here.
as_service_user() {
  if [ "$(id -u)" -eq 0 ]; then
    sudo -u "$service_user" -- "$@"
  elif [ "$(id -un)" = "$service_user" ]; then
    "$@"
  else
    fail "must run as root or as $service_user (running as $(id -un))"
  fi
}

install_units() {
  [ -d "$unit_dir" ] || fail "unit directory $unit_dir does not exist"
  cat > "$unit_dir/weaver-update.service" <<EOF
[Unit]
Description=Weaver hosted runner self-update (fast-forward the checkout to origin/$branch)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$self --quiet
EOF
  cat > "$unit_dir/weaver-update.timer" <<'EOF'
[Unit]
Description=Roll the Weaver hosted runner forward every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  # The daily needs-you digest has its own unit and timer, independent of
  # weaver-run: it must still reach the operator when the runner has crashed,
  # wedged, or is refused by its preflight — that is when it matters most. It is
  # a read-only, model-free render delivered to the operator's own configured
  # destination (see docs/harness.md), so it carries no execution preflight.
  # Persistent=true posts a missed 07:30 on the next boot; the command reads the
  # channel back first, so a late or repeated run never posts twice.
  # The units are written but never enabled here: the timer is opt-in, turned
  # on by the operator once (`systemctl enable --now weaver-digest.timer`) on
  # a fleet that wants the push. An operator who has switched it off must not
  # find it back on after the next self-update or cutover.
  cat > "$unit_dir/weaver-digest.service" <<'EOF'
[Unit]
Description=Weaver daily needs-you digest (model-free, readback-idempotent)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=weaver
WorkingDirectory=/opt/weaver
ExecStart=/usr/local/bin/weaver digest --post
TimeoutStartSec=5min
EOF
  cat > "$unit_dir/weaver-digest.timer" <<'EOF'
[Unit]
Description=Push the Weaver needs-you digest to the operator every morning
[Timer]
OnCalendar=*-*-* 07:30:00 Europe/London
Persistent=true
[Install]
WantedBy=timers.target
EOF
  # Workspace garbage collection is host hygiene, so unlike the digest it is
  # switched on wherever the runner is installed: nothing ever removed a
  # resolved workstream's checkouts, and on 2026-09-24 71 GB of them filled
  # the disk and put the runner below its free-space floor (dispatching
  # nothing). It reads the fleet once a day and removes only children no live
  # work names, keeping anything with uncommitted or unpushed work (see
  # src/workspaceGc.ts). 04:30 London is after the digest window's quietest
  # hour and before the morning's dispatch.
  cat > "$unit_dir/weaver-gc.service" <<'EOF'
[Unit]
Description=Weaver workspace garbage collection (removes checkouts no live workstream names)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=weaver
WorkingDirectory=/opt/weaver
ExecStart=/usr/local/bin/weaver gc-workspaces
TimeoutStartSec=30min
EOF
  cat > "$unit_dir/weaver-gc.timer" <<'EOF'
[Unit]
Description=Collect the Weaver workspace root every night
[Timer]
OnCalendar=*-*-* 04:30:00 Europe/London
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now weaver-update.timer
  systemctl enable --now weaver-gc.timer
  echo "✓ weaver-update.timer enabled (every 5 minutes, from origin/$branch)"
  echo "✓ weaver-gc.timer enabled (nightly workspace garbage collection)"
  echo "· weaver-digest.timer installed, not enabled (opt in: systemctl enable --now weaver-digest.timer)"
}

# One updater at a time. `systemctl enable --now` fires the timer's first run
# the instant it is installed, and on 2026-09-15 that run raced the operator's
# own `weaver-gcp update` on the same fetch: one of them lost git's ref lock.
# A mkdir lock is atomic and needs no flock binary (macOS tests run this too);
# a holder that died is recognised by its dead pid and taken over.
take_lock() {
  local waited=0 holder
  while ! mkdir "$lock_dir" 2>/dev/null; do
    holder="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$lock_dir"
      continue
    fi
    [ "$waited" -lt "$lock_wait" ] || fail "another update (pid ${holder:-unknown}) still holds $lock_dir after ${lock_wait}s"
    sleep 1
    waited=$((waited + 1))
  done
  printf '%s\n' "$$" > "$lock_dir/pid"
  trap 'rm -rf "$lock_dir"' EXIT
}

update() {
  [ -d "$repo/.git" ] || fail "$repo is not a git checkout"
  take_lock
  as_service_user git -C "$repo" fetch --quiet origin "$branch"
  local before after
  before="$(as_service_user git -C "$repo" rev-parse HEAD)"
  after="$(as_service_user git -C "$repo" rev-parse FETCH_HEAD)"
  if [ "$before" = "$after" ]; then
    [ "${1:-}" = --quiet ] || echo "up to date at ${before:0:12}"
    return 0
  fi
  # A checkout that cannot fast-forward (a local commit, a lockfile a hand-run
  # install rewrote) stays where it is and says so; it must never be reset,
  # since the operator may be in the middle of something on the box.
  as_service_user git -C "$repo" merge --ff-only FETCH_HEAD >/dev/null \
    || fail "checkout at ${before:0:12} cannot fast-forward to origin/$branch ${after:0:12}; resolve it on the host"
  # --immutable: a lockfile that would change is a checkout that would stop
  # fast-forwarding next time. The runner's source-stale exit has already been
  # armed by the merge above, so this must finish before systemd relaunches it
  # (RestartSec=10 after a drain that starts on the next 5s poll); an install
  # that loses that race fails the preflight once and Restart=always retries.
  (cd "$repo" && as_service_user yarn install --immutable >/dev/null) \
    || fail "yarn install failed after fast-forwarding to ${after:0:12}; the runner will relaunch on the new checkout without it"
  # serve has no source-stale exit of its own; the runner restarts itself.
  systemctl restart weaver-serve
  echo "updated ${before:0:12} → ${after:0:12} (origin/$branch); weaver-serve restarted, weaver-run drains and relaunches itself"
}

case "${1:-}" in
  install) install_units ;;
  ""|--quiet) update "${1:-}" ;;
  *) fail "usage: weaver-gcp-update [install|--quiet]" ;;
esac
