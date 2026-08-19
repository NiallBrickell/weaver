# Hosting Weaver

*Two long-lived processes over one Postgres: the resident runner that carries outcomes, and the ingress adapter your bots reach*

On your laptop Weaver is a CLI over local files — nothing to host. To share one
fleet across machines and let bots reach it from anywhere, you run the same code
as two long-lived processes against a shared database:

```
   bots (any language, anywhere)          one Postgres = one fleet
        │  register / observe / read              ▲
        ▼                                          │
   weaver serve  ── ingress adapter ──────────────►│  workstreams, decisions,
        (accepts what bots send, reads back)       │  adopted results, policies
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

## Environment every hosted process needs

```bash
export WEAVER_STORE="postgres://user:pass@host:5432/weaver"   # the shared fleet
export WEAVER_SERVE_TOKEN="<a-strong-secret>"                 # serve only — the bot bearer token
```

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
`weaver login --render-remote-env` emits the credentials and model config as
env lines for piping over SSH (it refuses to print to a terminal).

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
substrate. Cross-executor preference waits for durable Workstream execution
policy rather than trusting process-local environment agreement.

## Deploying on Railway

Railway fits this cleanly — a Postgres plugin and two services in one project.
The walkthrough below uses the names you'll see in the dashboard.

**1. Project + database.** Create a project and add a Postgres database to it.
Railway exposes its connection string as `DATABASE_URL` on services that
reference it.

**2. The runner service.** Point a service at this repo (build: `yarn install`,
start: `yarn weaver run`). Set variables:

```
WEAVER_STORE = ${{Postgres.DATABASE_URL}}     # reference the database plugin
WEAVER_COORDINATOR_MODEL = claude-fable-5      # optional; this is the default
WEAVER_WORKER_MODEL = sonnet                   # optional; this is the default
```

Setting `ANTHROPIC_API_KEY` as a Railway service variable alone is **not**
enough — Weaver strips ambient Claude credentials from SDK children (see
above), so the runner would boot but every model pass would fail to
authenticate. Register the identity into the executor store on the service's
volume instead: open a shell on the runner service once and run
`weaver secret set ANTHROPIC_API_KEY --executor` (or register a
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` the same way). Note the
store lives under `WEAVER_HOME` (default `<repo>/state`), so the service needs
a persistent volume there for the registration to survive redeploys.

The runner needs no inbound port — it dials out to Postgres and to the model. It
should be a single always-on instance (do not scale it past one replica; the pid
lock will refuse the second, and one runner per host is the design).

**3. The serve service.** A second service from the same repo, start
`yarn weaver serve --host 0.0.0.0 --port $PORT`. Set variables:

```
WEAVER_STORE = ${{Postgres.DATABASE_URL}}     # the same fleet
WEAVER_SERVE_TOKEN = <a-strong-secret>
```

Bind `0.0.0.0` and read the port from Railway's injected `$PORT`. Generate a
public domain for this service and hand your bots that URL plus the token — those
are the two things [a bot needs to connect](./bots.md). `serve` may scale
horizontally: it is stateless, so more replicas behind the domain just add
ingress throughput.

**4. Verify.**

```bash
export URL=https://<your-serve-domain>
export TOKEN=<the-serve-token>

# create-or-get is idempotent on the source key
curl -X POST $URL/workstreams -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"source_key":"smoke:1","title":"Smoke","objective":"Confirm hosted ingress works"}'
# → 201 {"slug":"smoke", …, "created":true}   (a second call → 200 created:false)

# read it back
curl $URL/workstreams/smoke -H "Authorization: Bearer $TOKEN"

# and confirm auth fails closed
curl -o /dev/null -w '%{http_code}\n' $URL/workstreams/smoke   # → 401
```

Then watch the runner's logs adopt the observation on its next tick.

## What hosting does not change

- **The store contract is identical.** Revision-checked writes, artifact
  pinning, and the policy store behave the same hosted as local — one
  contract-test suite runs over filesystem, SQLite, and Postgres.
- **The authority firewall holds.** `serve` still exposes no steer / approve /
  adopt. A hosted fleet does not hand bots authority they don't have locally; a
  person (or the coordinator under its own ceilings) still decides what evidence
  means. The bearer token is a machine-to-machine boundary, not a login system —
  Weaver has no tenancy or orgs, hosted or not.
- **Secrets stay out of the database.** Credential *values* live in each host's
  environment; the store refuses any document that embeds a known secret value.

See also: [Hosted state](./hosted-state.md) · [Connecting bots](./bots.md) ·
[Configuration](./configuration.md).
