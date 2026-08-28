# Where workers run

A Weaver worker is disposable: one fresh run advances one bounded assignment,
publishes a result through Weaver's `submit_result` surface, and exits. *Where*
that run's model loop executes is a substrate choice — it does not change the
durable Workstream contract. `WEAVER_EXECUTOR` is the explicit fallback for
general work; reviewed capability routes may select a different exact target
for an assignment whose typed requirements match proven eval evidence.

The harness always keeps the durable half: it builds the brief, loads the
environment, supervises declared actions, and accepts a submission only through
its own callback. The executor owns only the disposable half — the model loop
and the ordinary coding-agent tools.

Workers have a sleep-aware 40-minute safety wall. Weaver tells each worker to
stop optional investigation at minute 30, append the evidence already
established, and submit during the reserved final ten minutes. If the hard wall
still interrupts between an `append_section` checkpoint and `submit_result`,
Weaver preserves those sections as an explicitly incomplete candidate. A fresh
coordinator can inspect and reject that checkpoint before dispatching only the
missing work, but it cannot adopt the checkpoint as a completed result.

A complete submission must contain non-whitespace content, but Weaver does not
use byte or line count as a quality gate. A one-byte flag, a short identifier,
or a byte-exact fixture can be the whole requested deliverable. It remains only
a `proposed` candidate until a fresh coordinator checks it against the typed
acceptance criteria; padding a short result would make that review less honest,
not more complete.

## The substrates

| `WEAVER_EXECUTOR` | Where the loop runs | Containment |
| --- | --- | --- |
| `local-sdk` *(default)* | The local Claude Agent SDK `query()` in this process's environment | Host process — the launching machine is the boundary |
| `codex-sdk` | A fresh local Codex SDK thread using the machine's ChatGPT login | Host process — the launching machine is the boundary |
| `pi` | A fresh RPC process from the pinned Pi package using one provider-qualified API target | Host process — the launching machine is the boundary |
| `openhands` | A pinned OpenHands Agent Server container, one per assignment | Agent server — the primary directory is mounted at `/workspace`, independent declared sources at `/weaver-sources/N`; the container is `--rm` and always torn down |

An unknown value fails hard before the attempt starts, on purpose: a silent
fallback to local execution would make a misconfigured remote fleet look healthy.

## Evidence-backed routing

The coordinator declares a closed execution profile and input modalities on
new work — requirements such as `bounded-code-repair` plus `text`, never a model
name inferred from briefing prose. Weaver selects the target once before the
attempt claim and stores executor, provider, and model on that attempt.
The full story — the three typed facts, the resolution order, and why profiles
without routes today are still declared — is in [Model routing](./model-routing.md).

The same typed requirements carry a complexity tier. Work the coordinator
declares `complexity: high` — acceptance depending on deep multi-file
reasoning, design judgment, or hard debugging — takes the operator's
`WEAVER_WORKER_MODEL_COMPLEX` seat instead of `WEAVER_WORKER_MODEL`, on the
same configured executor with its provider re-derived. The requirement selects
the seat; the operator's config supplies the model, and with no complex tier
configured the work simply runs on the standard worker model. Reviewed
evidence-backed routes and the explicit `WEAVER_WORKER_FALLBACKS` ladder are
unchanged by the tier, and actions never enter routing at all.

The checked-in registry contains a text-only `bounded-code-repair` preference
for `codex-sdk:gpt-5.6-sol`, backed by a clean 10-run cohort from the full-access
worker epoch. It applies when `codex-sdk` is already `WEAVER_EXECUTOR`; automatic
routing changes models inside that configured substrate, never the substrate
itself. This keeps a stock local-SDK runner from reserving Codex work and avoids
making cross-executor preference depend on process-local configuration. General,
image-bearing, and other unmatched work still uses the configured fallback.
Matching targets form an explicit preference order followed by that fallback.
A route enters the checked-in registry only after a complete cohort of its
declared minimum runs (each active route declares ten) passes every hard gate
and every named quality check in the same adapter and case versions; the
auditor enforces each route's declared minimum, not a global count. The append-only
ledger is evidence, not configuration: adding a result cannot silently change
production routing.

Capacity is scoped to that exact target. If a preferred pool is limited, the
next reviewed target can take a fresh attempt; the exact executor/provider/model
it used is pinned on that attempt while the earlier wait remains honest history.
Unknown provider cost remains unknown; route preference is an explicit reviewed
choice, never a claim that missing cost telemetry means free.

## The capacity ladder

`WEAVER_WORKER_FALLBACKS` extends that order with an explicit operator-owned
capacity ladder: comma-separated `executor:model` seats tried, in order, after
the configured `WEAVER_EXECUTOR`/`WEAVER_WORKER_MODEL` seat when every earlier
target holds an active typed backoff. Unlike automatic eval routes, the ladder
may cross executors — it is machine configuration the operator wrote, the same
trust class as `WEAVER_EXECUTOR` itself, not an inference the router made. Each
entry splits on its first colon, so provider-qualified models keep their
slashes (`pi:openrouter/moonshotai/kimi-k3`); an unknown executor fails hard
rather than silently dropping a seat. Every executor the ladder names joins the
runner's default capability declaration, and its credentials must be present on
each host that may claim the work. The coordinator has the same shape of chain
via `WEAVER_COORDINATOR_FALLBACKS` — see
[Configuration](./configuration.md).

## Runner capability declaration

A runner claims only work it says it can execute. Without
`WEAVER_RUNNER_EXECUTORS`, that declaration is the union of its configured
worker and action executors plus every executor named in the coordinator
fallback chain and the worker capacity ladder. A performance route does not
implicitly add a substrate merely because its adapter is present in the build.

Declare extra capable substrates on a host explicitly:

```dotenv
WEAVER_RUNNER_EXECUTORS=codex-sdk,openhands,local-sdk
```

The declaration gates the first capacity-available target before dispatch and
is checked again inside the revision-checked worker-attempt or coordinator-lease
claim. Missing host capability never makes the next preference eligible;
otherwise model choice would depend on which Postgres runner won the tick lock.
A host without the selected substrate therefore leaves that target queued for
another runner. Only a typed backoff on the preferred pool advances selection
to the next reviewed target or configured fallback. Status shows the local
executor wait separately from provider capacity because it has no honest retry
timestamp. Unknown or empty declarations fail at runner startup.

An assignment may also carry one exact `runner_id` when its acceptance truly
depends on a specific execution host — for example a daemon that exists only
on a named workstation. `WEAVER_RUNNER_ID` names the current host (falling back
to its OS hostname for ordinary local use). An unmatched runner leaves that
assignment queued without an attempt or any state mutation; a matching attempt
pins the runner ID beside executor/provider/model provenance. Omitted placement
keeps the existing fleet-wide behavior.

For a machine scheduler that must service only these explicitly placed exact
actions, set both `WEAVER_RUNNER_ID=<stable-name>` and
`WEAVER_RUNNER_PLACEMENT_ONLY=1`, then invoke:

```bash
weaver tick <workstream> --engine-only
```

That lane reconciles crashed/legacy one-shot actions, executes only already
approved matching `exec.run` commands, and runs their deterministic readback.
It never sends, asks Pilot for approval, starts a model worker, or runs a
coordinator. Placement-only mode is deliberately refused by `weaver run`; it
is not a partial resident runner.

Passing model-quality gates is necessary but not sufficient for an automatic
route. OpenHands now mounts every declared source directory and relays the
serializable user/local MCP entries discoverable in `~/.claude.json` through
authenticated host endpoints. It does not yet carry project `.mcp.json`,
managed or plugin servers, `headersHelper`, or Claude.ai/OAuth connectors whose
tokens Claude Code keeps privately. It therefore remains an explicit
cooperative-work target until that complete ordinary worker surface crosses the
remote seam; the router does not infer that a narrowly scoped brief needs fewer
tools.

Cross-executor automatic preference remains closed until Weaver stores that
execution policy durably with the Workstream. An environment-only switch would
let configuration skew turn model choice into a Postgres tick-lock race.

### Credential-bearing GCP hosts

The repository's GCP helper applies a narrower deployment profile than the
general capability declaration above. A hosted runner carrying operator/model
identities must use OpenHands for its ordinary worker and every worker fallback;
host-process Pi, Codex, and local-login Claude workers are refused before
systemd can start or restart the runner. Coordination uses the separate
tool-restricted Claude SDK seam against OpenRouter's supported Anthropic API
surface, with an organization API key from executor-only storage and a fresh
empty Claude config directory for every pass. The resulting declaration is
explicit:

```dotenv
WEAVER_EXECUTOR=openhands
WEAVER_WORKER_FALLBACKS=
WEAVER_COORDINATOR_MODEL=openrouter/~anthropic/claude-opus-latest
WEAVER_COORDINATOR_EXECUTOR=local-sdk
WEAVER_COORDINATOR_FALLBACKS=local-sdk:openrouter/~anthropic/claude-sonnet-latest
WEAVER_ACTION_EXECUTOR=local-sdk
WEAVER_PILOT_URL=http://127.0.0.1:9721
WEAVER_RUNNER_EXECUTORS=openhands,local-sdk
```

The `local-sdk` capability is solely the supervised action seat; worker and
worker-fallback validation above prevents it becoming ordinary work. The GCP
helper claims it only after proving Pilot has authenticated ingress that an
ordinary worker container cannot reach. A liveness probe alone is not an
authority boundary. The gate requires a separate `weaver-pilot` service
account, an active `weaver-pilot.service`, exactly one loopback listener owned
by that unit, and an executor-only `WEAVER_PILOT_TOKEN`; an invalid bearer must
receive 401 and the registered bearer 204. Finally, the installed
`/usr/local/bin/weaver pilot-auth-check` must succeed as the service user. That
last check exercises the exact shared bearer client used by engine and worker
actions; a parallel curl implementation cannot substitute for it.
The helper also provisions a service-user-owned rootless Docker daemon and
requires it in the same preflight, avoiding the root-equivalent Docker group.
It refuses `~/.codex/auth.json` and never copies personal CLI/device state.
The OpenRouter Agent SDK environment follows the provider's documented
[Anthropic Agent SDK integration](https://openrouter.ai/docs/guides/community/anthropic-agent-sdk),
but Weaver supplies it per pass rather than trusting ambient shell variables.
See [Hosting Weaver](./hosting.md#deploying-the-runner-on-a-gcp-vm).

Prime Agent remains available only in the harness-eval vocabulary. Pi is a
production worker substrate but not a coordinator or action substrate. It is
explicitly selected; within that configured substrate, text-only bounded code
repair selects the reviewed Kimi K3 route backed by the complete production
adapter cohort. No route changes the configured executor.

## Running locally with Codex

Codex can fill both disposable seats without using Claude-plan capacity for
ordinary implementation work:

```dotenv
WEAVER_COORDINATOR_EXECUTOR=codex-sdk
WEAVER_COORDINATOR_MODEL=gpt-5.6-sol
WEAVER_COORDINATOR_FALLBACKS=codex-sdk:gpt-5.6-sol
WEAVER_EXECUTOR=codex-sdk
WEAVER_WORKER_MODEL=gpt-5.6-sol
# Actions remain on the supervised defaults: local-sdk / sonnet.
```

Run `codex login` once first. Weaver deliberately removes ambient OpenAI API
keys and forces the ChatGPT login path, so a stray exported credential cannot
silently change the account or billing route. Every worker starts a new thread;
history persistence is disabled, and its session id is provenance only and is
never resumed.

An ordinary Codex worker deliberately starts with `danger-full-access`. The
executor is declared as a host-process substrate, so it must provide the same
ordinary coding-agent surface as the local Claude worker, including Git
metadata, host daemons, and caches. Codex's `workspace-write` mode still makes
`.git` and resolved worktree gitdirs recursively read-only, and writes outside
its configured roots remain unavailable; see OpenAI's
[protected-path documentation](https://learn.chatgpt.com/docs/agent-approvals-security#protected-paths-in-writable-roots).
This is not presented as filesystem containment. Weaver's authority boundary
remains the assignment lifecycle: reversible `work` gets the ordinary agent
surface, while irreversible egress must be an `action` supervised by Pilot.
Codex refuses those actions until its SDK exposes the required per-tool
supervision callback.

The coordinator is stricter than a worker. Each pass gets a new temporary
`CODEX_HOME` containing only a link to the local login, no operator MCP servers,
skills, rules, hooks, or previous sessions. Shell, file changes, web search,
network, and non-Weaver MCP calls are disabled and audited fail-closed. Its only
capabilities are the same revision-checked Weaver mutation tools used by the
Claude coordinator, reached through a per-pass authenticated localhost bridge.

`weaver do` still uses its deterministic intake fallback if its separate Claude
brief-derivation call is unavailable. `weaver ask` remains a Claude-backed
read-only helper; it is not part of the controller or worker execution path.

> **Action boundary:** performance routes never match `action`. Actions use
> `WEAVER_ACTION_EXECUTOR` / `WEAVER_ACTION_MODEL`, defaulting to supervised
> `local-sdk` / `sonnet`, independently of the volume-work fallback. Codex's
> current TypeScript SDK has no per-tool authority callback and refuses an
> action before launch if explicitly selected; it never runs irreversible
> egress without Pilot supervision.

## Running API-backed workers with Pi

Pi is the smallest local API substrate: Weaver packages version `0.84.2`, starts
one fresh `--no-session` RPC process per assignment, and never depends on a
global Pi install. It requires Node 22.19 or newer and no container runtime.

Store the provider key, then select a provider-qualified target:

```bash
# Z.ai general API credits
weaver secret set ZHIPU_API_KEY --executor
export WEAVER_EXECUTOR=pi
export WEAVER_WORKER_MODEL=zai/glm-5.3

# Or OpenRouter
weaver secret set OPENROUTER_API_KEY --executor
export WEAVER_WORKER_MODEL=openrouter/moonshotai/kimi-k3
```

Pi's native `ZAI_API_KEY` name is accepted as an alias. The separate
`zai-coding-plan/glm-5.3` target uses Z.ai's Coding Plan endpoint; keeping that
prefix distinct ensures plan capacity never clears or blocks general API
credits. Provider-specific model names are never guessed or silently changed.

The durable provider key remains in Weaver's host-side inference proxy. The Pi
process receives a random model-pinned bearer, and the sole run-bound extension
erases that bearer-bearing environment record before the ordinary Bash tool can
run. The same extension exposes Weaver's submission tools and every supported
operator MCP tool through authenticated host relays. Upstream commands, URLs,
headers, environments, and durable credentials do not enter Pi's configuration.
A configured operator server that cannot be reached at launch (expired login,
upstream outage) degrades the same way it does for codex-sdk and local-sdk
workers: the run proceeds without it, the unavailable server is named in the
launch log and in the worker's system prompt, and one dead server never blocks
unrelated assignments.

Pi keeps repository context files so a project's `AGENTS.md`/`CLAUDE.md`
instructions apply, but disables personal extensions, skills, prompt templates,
themes, sessions, and provider configuration. Declared additional source paths
remain normal absolute host paths. This is deliberately reported as
`host-process`, not filesystem containment.

The actual upstream response must state a model id before Weaver records a
resolved target. Run cost remains unknown because the custom run-bound provider
does not expose a trustworthy bill; unknown is never rewritten as `$0.00`.
Pi has no Pilot per-tool supervision callback, so any action-shaped request is
refused before a key, proxy, relay, bridge, temporary home, or child process is
created. Keep `WEAVER_ACTION_EXECUTOR=local-sdk`.

The reviewed `pi@0.84.2-weaver.4` cohort routes text-only bounded code repair to
`openrouter/moonshotai/kimi-k3` when `WEAVER_EXECUTOR=pi`; general and image work
still use `WEAVER_WORKER_MODEL`. Every Pi runner in a shared fleet must therefore
hold executor-only credentials for both its configured fallback and each active
Pi route. The executor declaration is intentionally not a provider capability
negotiation layer.

## Running workers in OpenHands

Store the provider key in Weaver's executor-only scope, then select the target:

```bash
weaver secret set OPENROUTER_API_KEY --executor  # value is read from stdin
export WEAVER_EXECUTOR=openhands
export WEAVER_WORKER_MODEL=openrouter/moonshotai/kimi-k3
```

OpenRouter uses its official `https://openrouter.ai/api/v1` endpoint by
default. Set `WEAVER_OPENHANDS_BASE_URL` only for another OpenAI-compatible
endpoint. `--executor` is deliberately different from a global or
workstream secret: its name and value are never projected to a coordinator,
worker, action, or exec shell.

Requirements:

- **A Docker-compatible container runtime** must be available. On macOS the
  supported local path is OrbStack; Weaver uses its compatible `docker` CLI to
  run the pinned Agent Server image and cleans it up after every assignment.
  Containers carry an owner-process label; a later run removes labeled orphans
  whose owner died before its `finally` cleanup could execute.
- The worker reaches Weaver's submission surface over an ephemeral,
  bearer-authenticated HTTP bridge advertised to the container as
  `host.docker.internal` — nothing durable is written by the container directly.
- Every declared source directory must already exist. The primary directory is
  mounted read-write at `/workspace`; independent additional directories get
  stable `/weaver-sources/N` paths, nested and symlink-equivalent sources are
  deduplicated, and host paths in the brief are rewritten to their runtime paths.
- Serializable stdio, Streamable HTTP, and legacy SSE user/local MCP entries
  from `~/.claude.json` stay on the host. Per-run authenticated relays expose
  their complete tool lists and read/write calls to the container; commands,
  URLs, headers, environment values, and durable credentials never enter its
  configuration. Unsupported OAuth and dynamic-header variants fail before
  container launch rather than silently dropping tools. A configured server
  that cannot be reached at launch (expired login, upstream outage) degrades:
  the run proceeds without it, the unavailable server is named in the launch
  log and in the worker's brief, and it never blocks unrelated work — the
  same behavior codex-sdk and local-sdk workers already had.
- The durable provider key never enters the container. A host-side proxy holds
  it in memory and gives the run a random, inference-only bearer, then closes
  with the container. The proxy accepts only chat-completion/response calls for
  the selected model, caps calls to the run's turn budget plus two, aborts live
  upstream calls during teardown, scrubs provider responses, and records the
  model id stated by the actual
  upstream response; missing identity evidence fails qualification instead of
  treating requested configuration as resolved fact.
- Each run also gets fresh Agent Server and submission keys. All per-run keys
  and every executor-only value join submission, tail, artifact, printout,
  telemetry-error, and typed-store redaction before anything is persisted.
- **Provider billing is configured at the provider.** Weaver's rolling
  model-start guard bounds rapid churn but is not a monetary stop. When this
  executor uses API credits, set the real spending ceiling with that provider.
- **Capacity visibility follows provider evidence.** The local Claude
  subscription SDK can report fresh plan-window utilization for the dashboard.
  OpenHands providers such as OpenRouter/Kimi currently expose no equivalent
  proactive signal through this seam, so Weaver reports their headroom as
  unknown. A rejected request still becomes a provider-scoped durable backoff;
  Weaver never converts tokens or estimated cost into a made-up quota bar.

## What it does and does not guarantee today

- **Real host-filesystem scoping, not an enforced hostile boundary.** Only the
  assignment's declared directories are mounted at the documented runtime
  paths. This is useful isolation for a cooperating worker; it is not yet a
  multi-tenant or adversarial sandbox. That harder guarantee is tracked as a
  future managed-sandbox target.
- **Agent Server credentials stay conversation-local.** Weaver never writes a
  provider credential into an OpenHands settings/profile store. The pinned
  server redacts a conversation's LLM key from its API, but its session bearer
  is otherwise a trusted server client; the host proxy means even a terminal
  that inspects every local API and runtime file can recover only a disposable
  inference bearer, never the durable OpenRouter key.
- **Actions use a separate supervised target.** A declared action needs live,
  per-call Pilot supervision, which Codex, Pi, and the container path cannot route
  yet. The default action target remains local Claude regardless of the work
  fallback or performance routes. Explicitly selecting an unsupported action
  executor fails closed — capability is never authority.

The evidence path behind this choice — the same assignment and adoption
boundary, run against several candidate runtimes under deterministic durability,
confinement, and quality gates — is described in
[Harness evaluations](./harness-evals.md).
