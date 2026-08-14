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

## The substrates

| `WEAVER_EXECUTOR` | Where the loop runs | Containment |
| --- | --- | --- |
| `local-sdk` *(default)* | The local Claude Agent SDK `query()` in this process's environment | Host process — the launching machine is the boundary |
| `codex-sdk` | A fresh local Codex SDK thread using the machine's ChatGPT login | Host process — the launching machine is the boundary |
| `openhands` | A pinned OpenHands Agent Server container, one per assignment | Agent server — the host working directory is bind-mounted at `/workspace`; the container is `--rm` and always torn down |

An unknown value fails hard before the attempt starts, on purpose: a silent
fallback to local execution would make a misconfigured remote fleet look healthy.

## Evidence-backed routing

The coordinator declares a closed execution profile and input modalities on
new work — requirements such as `bounded-code-repair` plus `text`, never a model
name inferred from briefing prose. Weaver selects the target once before the
attempt claim and stores executor, provider, and model on that attempt.

The checked-in registry contains a text-only `bounded-code-repair` preference
for `codex-sdk:gpt-5.6-sol`, backed by a clean 10-run cohort from the full-access
worker epoch. It applies when `codex-sdk` is already `WEAVER_EXECUTOR`; automatic
routing changes models inside that configured substrate, never the substrate
itself. This keeps a stock local-SDK runner from reserving Codex work and avoids
making cross-executor preference depend on process-local configuration. General,
image-bearing, and other unmatched work still uses the configured fallback.
Matching targets form an explicit preference order followed by that fallback.
A route enters the checked-in registry only after at least
three exact repetitions in one complete cohort pass every hard gate and every
named quality check in the same adapter and case versions. The append-only
ledger is evidence, not configuration: adding a result cannot silently change
production routing.

Capacity is scoped to that exact target. If a preferred pool is limited, the
next reviewed target can take a fresh attempt; the exact executor/provider/model
it used is pinned on that attempt while the earlier wait remains honest history.
Unknown provider cost remains unknown; route preference is an explicit reviewed
choice, never a claim that missing cost telemetry means free.

## Runner capability declaration

A runner claims only work it says it can execute. Without
`WEAVER_RUNNER_EXECUTORS`, that declaration is the union of its configured
coordinator, fallback-coordinator, worker, and action executors. A performance
route does not implicitly add a substrate merely because its adapter is present
in the build.

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

Passing model-quality gates is necessary but not sufficient for an automatic
route. The current OpenHands adapter mounts one working directory and exposes
Weaver's submission MCP, but it does not yet transport every operator-configured
MCP server or multiple declared source directories. It remains an explicit
cooperative-work target until that ordinary worker surface crosses the remote
seam; the router does not infer that a narrowly scoped brief needs fewer tools.

Cross-executor automatic preference remains closed until Weaver stores that
execution policy durably with the Workstream. An environment-only switch would
let configuration skew turn model choice into a Postgres tick-lock race.

Pi and Prime Agent are available only in the harness-eval vocabulary. They are
not accepted values for `WEAVER_EXECUTOR`, cannot coordinate a Workstream, and
cannot run actions. Their fresh RPC adapters must first pass a complete reviewed
cohort before any separate production-promotion change is considered.

## Running locally with Codex

Codex can fill both disposable seats without using Claude-plan capacity for
ordinary implementation work:

```dotenv
WEAVER_COORDINATOR_EXECUTOR=codex-sdk
WEAVER_COORDINATOR_MODEL=gpt-5.6-sol
WEAVER_COORDINATOR_FALLBACK_EXECUTOR=codex-sdk
WEAVER_COORDINATOR_FALLBACK_MODEL=gpt-5.6-sol
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
- The worker reaches Weaver's submission surface over an ephemeral,
  bearer-authenticated HTTP bridge advertised to the container as
  `host.docker.internal` — nothing durable is written by the container directly.
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

- **Real filesystem containment, not an enforced hostile boundary.** Only the
  assignment's working directory is mounted, so work stays inside `/workspace`.
  This is the right isolation for a cooperating worker; it is not yet a
  multi-tenant or adversarial sandbox. That harder guarantee is tracked as a
  future managed-sandbox target.
- **Agent Server credentials stay conversation-local.** Weaver never writes a
  provider credential into an OpenHands settings/profile store. The pinned
  server redacts a conversation's LLM key from its API, but its session bearer
  is otherwise a trusted server client; the host proxy means even a terminal
  that inspects every local API and runtime file can recover only a disposable
  inference bearer, never the durable OpenRouter key.
- **Actions use a separate supervised target.** A declared action needs live,
  per-call Pilot supervision, which Codex and the container path cannot route
  yet. The default action target remains local Claude regardless of the work
  fallback or performance routes. Explicitly selecting an unsupported action
  executor fails closed — capability is never authority.

The evidence path behind this choice — the same assignment and adoption
boundary, run against several candidate runtimes under deterministic durability,
confinement, and quality gates — is described in
[Harness evaluations](./harness-evals.md).
