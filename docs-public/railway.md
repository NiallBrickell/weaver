# Hosting the team workspace on Railway

Railway is a good home for Weaver's shared Postgres and browser workspace. The
first production shape keeps execution on an already-provisioned host rather
than pretending a bare web container has the repositories, model identity,
MCP connections, CLI logins, and Pilot supervision needed to finish engineering
work safely.

```text
                         Railway project
team browsers ──TLS──► operator UI ──┐
                                     ├──► Postgres = durable fleet truth
existing bots ───────► serve (opt.) ─┘          ▲
                                                │
                         always-on execution host
                         weaver run + repos + Pilot
```

Postgres is the shared knowledge layer. It contains Workstreams, Decisions,
Assignments, Observations, results, conclusions, content-addressed artifacts,
and the global learned-policy store. There is no separate knowledge daemon.

## Why the runner stays on an execution host first

The browser and database are ordinary hosted services. The runner is a coding
machine: a useful one needs the real source checkouts, repository instructions,
model identity, MCP/CLI authentication, and Pilot-backed supervision for
irreversible effects. A Railway runner with only `WEAVER_STORE` can coordinate
and write reports, but it cannot honestly claim it can fix and ship the target
product.

Keep the current always-on runner (or use the documented VM deployment) and
point it at Railway Postgres. Move the runner into Railway only after its
persistent volume contains the required checkouts and machine configuration,
its executor identity is deliberately registered, and its Pilot endpoint and
egress readbacks are reachable. The authority boundary does not change merely
because the process moved to the cloud.

For the execution-host option, the supported first deployment is Railway for
the UI/database and an isolated GCP VM for `weaver run`. The VM carries no GCP
service account and accepts no public ingress; it reaches Railway through the
database's public TCP proxy. The [GCP runner commands](./hosting.md#deploying-the-runner-on-a-gcp-vm)
install that URL over hidden SSH stdin and leave the process stopped until the
operator performs the explicit final start.

## 1. Apply the checked-in Railway infrastructure

The repository owns the Railway project shape in [`.railway/railway.ts`](../.railway/railway.ts):
one dedicated `Postgres` database, its `Postgres-PITR` recovery bucket, and one
`ui` service. It pins the Dockerfile, UI start command, health check, restart
and draining behavior, one EU West replica, the Postgres region, and the private
database reference. Do not reuse an application database: a dedicated database
gives fleet history its own backup, access, and failure boundary.

Railway's current Infrastructure-as-Code flow requires CLI 5.42.1 or newer;
the compatible TypeScript SDK is pinned in `package.json`. Link the intended
project and inspect the revision-checked plan before applying it:

```bash
railway upgrade --yes
railway link --project weaver --environment production
railway config plan
railway config apply
```

The resource names are deliberate. A project bootstrapped before its first IaC
apply must contain exactly `Postgres`, `Postgres-PITR`, and `ui`, so the plan
binds those existing resources instead of creating parallel ones. Do not apply
an existing project's plan if it proposes creating or deleting any of them;
fix the link or names and plan again. On an empty project, creating all three is
the expected first plan.

This file is the whole project definition: an omitted service is deletion
intent. Add any later Railway service to the same file before applying it.
Legacy `railway.json` and `railway.toml` service manifests are deliberately not
used because new Railway services cannot opt into that deprecated system.

Railway provides both private and public connection URLs. Services inside the
project use a reference to the private URL:

```text
WEAVER_STORE=${{Postgres.DATABASE_URL}}
```

The existing execution host uses the public URL when it cannot join Railway's
private network. Treat that URL as a secret; `weaver link` redacts it when
reporting configuration.

Weaver uses session-scoped Postgres advisory locks for cross-runner exclusion.
Do not place it behind transaction-mode PgBouncer. A standard Railway Postgres
public URL is direct; if Railway connection pooling is enabled later, give
Weaver `DATABASE_PUBLIC_UNPOOLED_URL`, or configure the pooler in session mode.

Production runners commonly use the documented five-second interval. They poll
a narrow `(slug, revision)` head list before each logical fleet scan and retain
a disposable, revision-validated document cache. A cold runner loads every
current document once; later polls transfer only documents
whose durable revision changed, while deletions and unreadable heads are
evicted. This preserves the same fresh-head and revision-CAS semantics without
retransmitting the full knowledge base every few seconds. Keep runners current:
older builds that list and reload every document on every poll can turn a large
fleet's public-database traffic into the dominant Railway cost.

The browser's four-second change detector uses that same head list plus current
runner presence. It does not render or transfer Workstream documents until the
revision changes and the browser requests a real board/workspace page. Thus a
board left open in a tab costs a narrow metadata poll, not one full fleet
download every four seconds.

Enable scheduled database backups before cutover. For a production fleet,
enable point-in-time recovery and periodically prove a logical restore outside
the project as well.

## 2. Copy an existing filesystem fleet

Changing `WEAVER_STORE` does not move existing data. `weaver link` is
deliberately read-only, so pointing it at a new database would otherwise show
an empty fleet.

Stop every process writing the filesystem fleet, then copy it with the store
command below. Omitting the URL keeps it out of shell history and prompts for
it with hidden input:

```bash
WEAVER_STORE=fs weaver store copy-to-postgres
# paste the public Railway Postgres URL when prompted
```

The command refuses a live runner, locks all filesystem writers, and preserves
exact Workstream documents and revisions, adoption pins, artifact bytes and
hashes, and the full policy store. It never overwrites a non-empty destination;
if a previous invocation committed the full snapshot but stopped before its
fresh readback, retrying succeeds only after the locked source and destination
verify as exactly equal. The source fleet data remains untouched throughout.

Machine-local activity tails, printout receipts, pid/heartbeat files, secrets,
and repository checkouts are not database state and are not copied. Generate a
final local printout before cutover if that host-local receipt history matters.

After the copy succeeds:

```bash
weaver link "$RAILWAY_PUBLIC_DATABASE_URL"
weaver link                    # proves the shared fleet is readable
weaver run --interval 5
```

Restart resident processes after linking because each process snapshots its
store configuration at launch.

For the GCP execution host, do not put the URL on the command line. Run:

```bash
bin/weaver-gcp.sh stop
bin/weaver-gcp.sh create --external-store
bin/weaver-gcp.sh set-store   # hidden prompt
bin/weaver-gcp.sh push-env    # merges config; does not restart
bin/weaver-gcp.sh start
bin/weaver-gcp.sh status
```

`set-store`, `push-env`, and `update` never restart by default. `push-env`
installs both portable service configuration and the runner's canonical
`0600` executor-identity store. This keeps the database copy, identity
delivery, and the first runner start as separate, inspectable facts.

## 3. Deploy the operator UI

The checked-in IaC creates one service from the Weaver repository and uses the
repository Dockerfile. Its start override is shell-wrapped because Railway
replaces Docker `ENTRYPOINT`/`CMD`, and Docker-image overrides need a shell for
`$PORT` expansion:

```text
/bin/sh -c "exec node bin/weaver.mjs ui --host 0.0.0.0 --port $PORT"
```

IaC owns the private database reference and preserves the operator-supplied
identity and intake values without writing them to source. Set them on the
`ui` service:

```text
WEAVER_STORE=${{Postgres.DATABASE_URL}}
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<the Clerk publishable key>
CLERK_SECRET_KEY=<the Clerk secret key>
WEAVER_UI_ALLOWED_EMAIL_DOMAINS=<the exact company email domain>
# Optional on Railway; set only when a custom UI domain is canonical.
WEAVER_UI_PUBLIC_ORIGIN=https://<the custom UI domain>
WEAVER_HOUSE_JSON={"repoMap":"Primary application: /absolute/path/on-the-runner","tags":["application"]}
```

The Clerk identity values are atomic: a partial configuration fails startup
rather than falling back. By default Weaver derives the canonical HTTPS origin
from Railway's provider-owned `RAILWAY_PUBLIC_DOMAIN`; an explicit
`WEAVER_UI_PUBLIC_ORIGIN` overrides it for a custom domain and becomes Clerk's
`authorizedParties` boundary and must match the URL teammates open. The secret
key stays in Railway's server-side variables; only the publishable key is sent
to the browser. Signed-in users are accepted only when Clerk reports a verified
email on the exact configured domain.

`WEAVER_HOUSE_JSON` uses the same shape as `WEAVER_HOME/house.json`. It lets a
stateless UI attach the canonical repository map and policy tags to new work
without a model pass. Do not put credentials in it.

The checked-in service contract pins:

- health-check path: `/healthz`;
- restart policy: **Always**;
- Serverless: **off**;
- one replica in Railway EU West (`europe-west4-drams3a`) for the initial
  rollout;
- deployment draining time: at least 30 seconds;
- public or custom domain: enabled only for this UI service.

`/healthz` proves the configured store answers a real read and returns no fleet
facts. Railway health checks gate deployment; they are not continuous runner
monitoring.

Railway terminates the public domain with TLS. The UI presents the normal Clerk
sign-in screen and records the verified email as request attribution. An
off-domain or unverified account reaches an access-restricted page and cannot
read fleet state or submit input.

## 4. Keep intake and execution context aligned

Set the same `WEAVER_HOUSE_JSON` on the UI and execution host, or keep an
equivalent `house.json` under the runner's `WEAVER_HOME`. A browser request is
stored immediately and model-independently; the repository map is appended to
its durable objective so a fresh coordinator can name the correct source
directory after any wait.

The path in that map must be the path **on the execution host**, not a laptop
path meaningful only to the person submitting the ticket.

## 5. Optional machine ingress

Deploy `weaver serve` only when bots need the JSON create/observe/status API.
Add it to `.railway/railway.ts` before applying—the file owns the complete
project, so a service created only in the dashboard would be deletion intent on
the next apply. It is a separate service and token:

```text
node bin/weaver.mjs serve --host 0.0.0.0 --port $PORT

WEAVER_STORE=${{Postgres.DATABASE_URL}}
WEAVER_SERVE_TOKEN=<a different long random token>
```

Do not give bots browser-session credentials. Neither surface exposes Steering,
approval, adoption, merge, deploy, spend, or send authority.

## What remains local to each execution host

Postgres intentionally does not contain:

- provider and action secret values;
- Claude/Codex/MCP/CLI login files;
- `house.json` and repository checkouts;
- runner pid locks, local heartbeat, activity tail, and printout receipts;
- neutral worker workspaces unless the host places them on its own persistent
  disk with `WEAVER_WORKSPACE_ROOT`.

That division is the safety boundary: organizational truth is shared;
capability and identity remain explicit properties of the machine executing
the work.

## Later: a fully hosted runner

When the runner is moved to a persistent host or Railway volume, set:

```text
WEAVER_HOME=/var/lib/weaver
WEAVER_WORKSPACE_ROOT=/var/lib/weaver/workspaces
```

Register model credentials through `weaver login` or `weaver secret set …
--executor` inside that volume. Ambient provider environment variables are
deliberately not a substitute. Provision repository access and Pilot before
calling the host capable of PR or deployment work, and keep it at one replica
until the executor substrate itself has been reviewed for horizontal use.

Railway references: [Postgres](https://docs.railway.com/databases/postgresql),
[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code),
[IaC reference](https://docs.railway.com/infrastructure-as-code/reference),
[connection pooling](https://docs.railway.com/guides/connection-pooling-pgbouncer),
[private networking](https://docs.railway.com/networking/private-networking/how-it-works),
[reference variables](https://docs.railway.com/variables),
[health checks](https://docs.railway.com/deployments/healthchecks),
[restart policies](https://docs.railway.com/deployments/restart-policy),
[deployment lifecycle](https://docs.railway.com/deployments/reference),
[volumes](https://docs.railway.com/volumes), and
[custom domains](https://docs.railway.com/networking/domains/working-with-domains).
