# Hosting Weaver

*A resident runner plus stateless browser/bot surfaces over one Postgres*

On your laptop Weaver is a CLI over local files — nothing to host. To share one
fleet across machines and let people or bots reach it from anywhere, run the
same code as separate processes against a shared database:

```
   bots (any language, anywhere)          one Postgres = one fleet
        │  register / observe / read              ▲
        ▼                                          │
   weaver serve  ── ingress adapter ──────────────►│  workstreams, decisions,
        (accepts what bots send, reads back)       │  adopted results, policies
                                                   │
   weaver ui     ── operator workspace ───────────►│
        (browser intake and inspection)            │
                                                   │
   weaver run    ── resident brain ───────────────►│  coordinator passes: verify,
        (ticks active workstreams, runs models)    ▼  adopt, decide, remember
```

Both point at the same `WEAVER_STORE`; neither holds durable state of its own.
`serve` never runs a model and never touches authority — it only accepts ingress
and reads status back ([Connecting bots](./bots.md)). `run` is the only thing
that executes work.

## The three ingredients

1. **A Postgres database.** Any plain instance — Railway, Supabase, Neon, RDS,
   a `docker run postgres:16`. No extensions. See [Hosted state](./hosted-state.md)
   for what moves to the database (workstreams, artifacts, learned policies) and
   what stays local (secret *values*).
2. **`weaver run`** — the resident runner. It ticks active workstreams, runs the
   coordinator and worker models, and carries each outcome forward across waits.
3. **`weaver serve`** — the HTTP ingress your bots call. Refuses to start without
   `WEAVER_SERVE_TOKEN`; exposes only register-workstream, post-observation, and
   read-status. No steer, approve, or adopt — those stay with the human.
4. **`weaver ui`** *(optional)* — the browser board/workspace for people to
   create and inspect work. A non-loopback listener requires Clerk or the
   private-network Basic fallback.

## Environment every hosted process needs

```bash
export WEAVER_STORE="postgres://user:pass@host:5432/weaver"   # the shared fleet
export WEAVER_SERVE_TOKEN="<a-strong-secret>"                 # serve only — the bot bearer token
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="<publishable-key>"  # ui only — safe browser key
export CLERK_SECRET_KEY="<secret-key>"                         # ui only — server-side secret
export WEAVER_UI_ALLOWED_EMAIL_DOMAINS="company.example"      # exact verified domains
export WEAVER_UI_PUBLIC_ORIGIN="https://weaver.example.com"   # Clerk authorized party
```

The UI treats those four Clerk settings as one configuration and fails closed
if any is missing. A private self-hosted listener may instead set
`WEAVER_UI_TOKEN`; a complete Clerk configuration always wins and ignores that
fallback.

On your laptop the SDK borrows your Claude Code login, so no credential is
needed. A host has no login to borrow — but exporting `ANTHROPIC_API_KEY` in
the runner's environment does **not** work: Weaver strips ambient Claude
credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`) from every SDK subprocess, so a stray export can
never silently switch the billing principal. The supported path is to
**register** the identity in the executor-only secret store on the host:

```bash
weaver login          # interactive: pick the executor, paste the credential (never echoed)
# or directly:
weaver secret set CLAUDE_CODE_OAUTH_TOKEN --executor   # from `claude setup-token` — subscription billing
weaver secret set ANTHROPIC_API_KEY --executor         # or an API key — API billing
```

A registered credential is a deliberate operator act against a `0600` file, so
it is the one exception the strip allows: exactly one principal is injected
into SDK children (the subscription token wins if both are registered). See
[Registered execution identity](./secrets-and-access.md#registered-execution-identity).
The **serve** process runs no model and needs no identity. To provision a
fresh host from a laptop where identity is already registered,
`weaver login --render-remote-env` emits the credentials plus the complete
portable runner configuration — configured coordinator and worker fallbacks,
complex-work model, repository context, workspace root, and Pilot endpoint —
as env lines for piping over SSH (it refuses to print to a terminal).

## Joining the fleet from another machine

Any machine that can reach the database — directly, or through a tunnel you
bring up (an SSH port-forward, a cloud SQL proxy) — can join the fleet with one
command:

```bash
weaver link "postgres://user:pass@host:5432/weaver"
weaver login    # then register this machine's execution identity, if it has none
```

`link` proves the connection before persisting anything: it opens the store
through the same layer every other command uses, enumerates the workstreams,
and loads the most recent one back as evidence of real fleet data. It is
strictly **read-only** — linking never writes to the fleet it is joining. On
success it writes `WEAVER_STORE` into the repo `.env` (passwords are never
echoed back). `weaver link` with no argument reports where `WEAVER_STORE`
points now and re-checks reachability; `weaver link --unlink` returns the
machine to its local filesystem store. Resident processes snapshot `.env` at
launch, so restart `weaver run` / `weaver watch` after linking.

## One fleet, one runner per host

The runner takes a pid lock per `WEAVER_HOME`, so only one `weaver run` lives per
state directory — a second is refused, which is what you want, since two brains
ticking the same local dir would race. Across *machines* the coordination moves
to the database: each host runs its own runner against the shared Postgres, and
per-workstream advisory locks let exactly one runner tick a given workstream at a
time. Postgres releases a dead holder's lock instantly, so a crashed runner never
wedges its workstream — another host picks it up on the next tick.

Start simple: **one runner, one serve, one Postgres.** Add runners on more hosts
only when one can't keep up; the fleet stays correct because the database, not
the process, is the source of truth.

When hosts have different execution substrates, set
`WEAVER_RUNNER_EXECUTORS` on each one (for example `openhands` on a container
host and `codex-sdk,local-sdk` on a logged-in workstation). The runner reserves
the first capacity-available model target for a host declaring that substrate
and rechecks the declaration in the attempt/lease claim, so an incapable host
never wins a Postgres lock and silently substitutes a less-preferred model.
Reviewed automatic routes select models only within the configured worker
substrate. A durable coordinator host preference prevents process-local model
configuration from becoming a Postgres lock race:

```bash
weaver coordinator-runners <workstream> mac-primary gcp-standby
```

Resident runners publish shared heartbeats. The standby becomes eligible for a
fresh coordinator lease only after every earlier runner has been absent for
120 seconds. This does not stop it from executing workers, sends, or exact
machine-placed actions in the same tick; it governs only coordination. Pass
and lease provenance record the host that actually took over.

Give every hosted execution process a stable `WEAVER_RUNNER_ID`; the OS
hostname default is intended for normal local machines, not replaceable
containers. Most assignments remain unplaced and may run on any capable host.
When intended work names one exact runner — typically because the effect is
machine-local — every other runner leaves it queued with no mutation, and the
attempt records which runner actually claimed it.

### A narrow machine-local action scheduler

A workstation can join a shared fleet without becoming another general brain.
Set a stable identity plus placement-only posture in the scheduler's
environment and run one bounded command per target workstream:

```bash
WEAVER_RUNNER_ID=mac-studio \
WEAVER_RUNNER_PLACEMENT_ONLY=1 \
weaver tick machine-maintenance --engine-only
```

`--engine-only` requires that posture. It processes only already-approved,
deterministic `exec.run` actions explicitly placed on `mac-studio`, plus the
crash/legacy reconciliation needed to preserve the one-shot action rule and
their readback. It does not send interactions, call Pilot, launch model-backed
work/actions, or run a coordinator. Do not use placement-only mode with
`weaver run`; the resident runner refuses it so unplaced fleet work cannot be
silently stranded.

## Deploying the runner on a GCP VM

[`bin/weaver-gcp.sh`](../bin/weaver-gcp.sh) provisions an isolated execution
host: the VM carries **no service account and no scopes** (a compromised
workload cannot call any GCP API as anything), sits on **its own VPC** whose
only ingress rule is IAP SSH, and receives secrets **over SSH stdin** into
service-user-owned `0600` files, never via instance metadata or a command
argument.

The recommended shared-team shape keeps durable truth in hosted Postgres and
uses GCP only for execution. Provisioning, credentials, code updates, and store
selection deliberately do not start or restart Weaver: the final `start` is
the visible cutover. `create` starts a stopped compute instance when necessary
to provision it, but leaves both Weaver systemd units stopped.

```bash
# On the configured operator laptop. Re-running create is provisioning-only.
bin/weaver-gcp.sh stop                    # first, when reusing a live VM
bin/weaver-gcp.sh create --external-store # VM/runtime/systemd; no bundled DB, no start
bin/weaver-gcp.sh set-store               # hidden prompt; URL goes only over SSH stdin

# These optional values are configuration, not credentials. A later push-env
# without them preserves the installed host values.
WEAVER_HOUSE_JSON='{"repoMap":"Primary application: /srv/application","tags":["application"]}' \
WEAVER_WORKSPACE_ROOT=/home/weaver/workspaces \
WEAVER_PILOT_URL=http://127.0.0.1:9721 \
  bin/weaver-gcp.sh push-env               # install hosted profile + executor identities

# Install only these organization-owned global worker credentials. This exact
# selection replaces the previous hosted worker set; omitted names are revoked.
bin/weaver-gcp.sh push-worker-secrets SENTRY_AUTH_TOKEN READONLY_DB_URL

bin/weaver-gcp.sh update                   # pull/install only; still no restart
bin/weaver-gcp.sh start                    # starts weaver-run: the explicit cutover
bin/weaver-gcp.sh status                   # services + runner heartbeat
```

Provisioning also records the VM's current private IPv4 as host-local
`WEAVER_OPENHANDS_HOST_GATEWAY_IP`. Rootless Docker's generic `host-gateway`
points at its inner bridge rather than the VM, so OpenHands uses this exact
local address to reach Weaver's ephemeral bearer-authenticated submission, MCP,
and provider proxies. Preflight refuses a missing, malformed, or non-local
address; the worker stays on its ordinary container bridge and never receives
host networking or access to host loopback.

The project defaults to the active gcloud project; zone, VM name, machine type,
network, and every override use `WEAVER_GCP_*` variables at the top of the
script. The resident unit defaults to four concurrent workstreams on the
default 8 GB VM (`WEAVER_GCP_CONCURRENCY=4`) and still applies the runner's
load-aware throttling below that ceiling. `push-env --restart` and `update --restart`
retain the old one-command restart when explicitly wanted; plain `push-env`
and `update` never disturb a running process. `logs` tails the runner journal;
on the box itself, `weaver status <slug>` works as-is — the safe launcher reads
the same raw env records as the services without evaluating credential or JSON
values as shell.

`start`, `restart`, `push-env --restart`, and `update --restart` all run the
same fail-closed host preflight before systemd can launch the runner. This GCP
helper is deliberately narrower than Weaver's general executor support:
ordinary work and every worker fallback must use `openhands`, the coordinator
uses the tool-restricted Claude SDK directly with a registered
`CLAUDE_CODE_OAUTH_TOKEN` created by `claude setup-token`, the capability
declaration is explicit, and the service user's rootless Docker daemon must
answer. The hosted coordinator chain is Claude through that setup-token, then
non-Claude OpenRouter through a fresh isolated API home. OpenRouter-backed
Claude is refused so every Claude run stays subscription-backed. Pi,
local-login Claude, and Codex remain valid on
operator-controlled machines; copied device-login state and Anthropic API keys
are refused on this credential-bearing host.
Rootless Docker is separate from the root-owned daemon used by the optional
bundled Postgres, so disposable workers do not make the service account
root-equivalent through the Docker group.

The hosted action lane is deterministic-only: exact `exec_run` commands are
evaluated by Pilot and executed by the engine, while same-UID model-driven
actions are refused because they could read controller credentials. This host
claims the action capability only after proving both the Pilot boundary and a
dedicated GitHub App machine identity. The separately
installed `weaver-pilot.service` must run as `weaver-pilot`, own the only TCP
listener on port 9721 at exactly `127.0.0.1`, and expose its authenticated
check only at that fixed loopback URL. `WEAVER_PILOT_TOKEN` must exist in the
executor-only secret store; the preflight proves a deliberately wrong bearer
receives 401 and the registered bearer receives 204 without putting that
bearer in argv or output. It then runs `/usr/local/bin/weaver
pilot-auth-check` as the service user, proving the exact shared client used by
engine and worker actions can load the bearer and receive the authenticated
204. Any failed proof refuses the systemd launch before an action-capable
runner exists. The Pilot account, unit, and token are installation
prerequisites rather than a bundled Pilot binary or configuration.

The same preflight refuses a personal `gh` login, Git credential helper/store,
SSH private key, credential-bearing workspace remote, GitHub MCP
configuration, or a static `GH_TOKEN`/`GITHUB_TOKEN` anywhere in Weaver's
hosted secret files. It
requires `WEAVER_GITHUB_APP_ID`, `WEAVER_GITHUB_APP_INSTALLATION_ID`, and
`WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64` in executor-only scope and runs
`/usr/local/bin/weaver github-auth-check` as the service user. The private key
stays on the controller host; ordinary OpenHands containers receive no GitHub
credential. Approved exact repo commands get one-hour installation tokens
narrowed to their exact repository and explicit permission profile, while
preflight and readback use independently minted read-only tokens. See [GitHub
access on a hosted runner](./github-app.md).

`create` without `--external-store` remains the one-box option: it provisions a
localhost-only Docker Postgres, and `tunnel`/`join` expose that database only
through IAP. Do not run `set-store` until the external database contains the
fleet you intend to execute: changing the URL selects a store; it does not copy
one. Use the [exact filesystem-to-Postgres copy](./hosted-state.md) first.

`push-env` synchronizes two distinct host inputs before any optional restart:
the helper's fixed hosted execution profile plus ingress configuration remains
in `/etc/weaver/env`, while the hosted allowlist of registered credentials
(Claude Code setup-token for primary coordination; OpenRouter for isolated workers and non-Claude coordinator fallback; Pilot,
serve, and the GitHub App identity) is installed at
`/home/weaver/state/executor-secrets.env`. Both are mode `0600`; the second is
the canonical adapter-only store read by Weaver executors. Removing a locally
registered allowed credential and pushing again removes it from the host too.
Provider keys are filtered out of the ambient systemd environment and exist
only in that executor store. The hosted OpenRouter worker defaults to
`openrouter/z-ai/glm-5.2`: its checked-in cohort completed the submission
boundary 10/10, while the earlier Kimi K3 cohort and production smoke both
exited at least once without the required `submit_result`. This is an explicit
host profile choice, not an automatic model route. `WEAVER_GCP_WORKER_MODEL`,
`WEAVER_GCP_WORKER_MODEL_COMPLEX`, `WEAVER_GCP_WORKER_FALLBACKS`,
`WEAVER_GCP_COORDINATOR_MODEL`, and `WEAVER_GCP_COORDINATOR_FALLBACKS` may
override the profile's model seats without weakening its substrate checks.
Personal CLI and device-login state is never copied to the host. In particular,
`push-env` does not deliver Claude's credential file, `~/.codex/auth.json`, `gh`
authentication, or `gcloud` authentication. It delivers only the deliberately
registered setup-token value through SSH stdin into the mode-`0600` executor
store.

Global worker credentials use a third, deliberately separate delivery path:
`push-worker-secrets NAME...` reads exactly those names from the operator
laptop's global Weaver secret store and atomically replaces
`/home/weaver/state/secrets.env` with that selected set. Unknown, malformed,
duplicate, or empty records fail before replacement. Values travel only on SSH
stdin, never in gcloud arguments, VM metadata, or command output; the installed
file is owned by `weaver` and mode `0600`. The command never copies a
per-workstream overlay, executor identity, personal CLI/device login, or an
ambient environment variable. Omission is revocation, so every invocation must
name the complete hosted worker set. Workers reload the store for each attempt,
therefore this command never restarts the resident services.

## Deploying with Docker Compose (any host)

The repo ships a [`Dockerfile`](../Dockerfile) (published as
`ghcr.io/niallbrickell/weaver`) and a [`docker-compose.yml`](../docker-compose.yml)
that runs the full fleet — Postgres, runner, serve — on any Docker host:

```bash
weaver login --render-remote-env > compose.env   # on a configured machine
echo "WEAVER_PG_PASSWORD=$(openssl rand -hex 16)" >> .env
docker compose up -d
```

`serve` is published on `127.0.0.1:9723` only; widening that to the world is a
deliberate edit, not a default. The `openhands` executor needs a Docker daemon
of its own and stays a VM-level substrate — run `local-sdk` / `codex-sdk` / `pi`
work in the composed runner.

## Deploying on Railway

The recommended first Railway shape is a dedicated Postgres service plus the
browser operator UI, with `weaver run` remaining on an already-provisioned
execution host. That host has the real repositories, model/CLI identities, MCP
connections, and Pilot supervision; an otherwise empty web container does not.

The [Railway deployment guide](./railway.md) covers the topology, exact
filesystem-to-Postgres copy, service variables, health check, browser access,
and the requirements for moving execution into a persistent hosted volume
later. Deploy `weaver serve` separately only when machine clients need the bot
API.

## What hosting does not change

- **The store contract is identical.** Revision-checked writes, artifact
  pinning, and the policy store behave the same hosted as local — one
  contract-test suite runs over filesystem, SQLite, and Postgres. Resident
  runners validate a local document cache against cheap revision heads before
  each scan, so unchanged hosted documents are not repeatedly transferred;
  the cache is disposable and never becomes durable truth.
- **The authority firewall holds.** `serve` still exposes no steer / approve /
  adopt. A hosted fleet does not hand bots authority they don't have locally; a
  person (or the coordinator under its own ceilings) still decides what evidence
  means. The bearer token is a machine-to-machine boundary, not a login system —
  Weaver has no tenancy or orgs, hosted or not.
- **Secrets stay out of the database.** Credential *values* live in each host's
  environment; the store refuses any document that embeds a known secret value.

See also: [Hosted state](./hosted-state.md) · [Connecting bots](./bots.md) ·
[Configuration](./configuration.md).
