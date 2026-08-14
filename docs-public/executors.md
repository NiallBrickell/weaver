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

The current reviewed route sends bounded text-only code repairs to
`codex-sdk:gpt-5.6-sol`; general, image-bearing, evidence, and UI work retain the
configured fallback. A route enters the checked-in registry only after at least
three exact repetitions in one complete cohort pass every hard gate and every
named quality check in the same adapter and case versions. The append-only
ledger is evidence, not configuration: adding a result cannot silently change
production routing.

Capacity is scoped to that exact target. A Codex limit parks matching repairs
without parking general work on Claude. Unknown provider cost remains unknown;
route preference is an explicit reviewed choice, never a claim that missing
cost telemetry means free.

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

Set the executor and give the container a provider key for the model:

```bash
WEAVER_EXECUTOR=openhands
WEAVER_MODEL_API_KEY=…        # or LLM_API_KEY
WEAVER_OPENHANDS_BASE_URL=…       # optional, for an OpenRouter-style endpoint
```

Requirements:

- **Docker** must be available; Weaver pulls and runs the pinned Agent Server
  image and cleans it up after every assignment.
- The worker reaches Weaver's submission surface over an ephemeral,
  bearer-authenticated HTTP bridge advertised to the container as
  `host.docker.internal` — nothing durable is written by the container directly.
- Each run gets a fresh session key; if the model ever echoes it into a
  submission, the harness redacts it before anything is stored.
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
- **Actions use a separate supervised target.** A declared action needs live,
  per-call Pilot supervision, which Codex and the container path cannot route
  yet. The default action target remains local Claude regardless of the work
  fallback or performance routes. Explicitly selecting an unsupported action
  executor fails closed — capability is never authority.

The evidence path behind this choice — the same assignment and adoption
boundary, run against several candidate runtimes under deterministic durability,
confinement, and quality gates — is described in
[Harness evaluations](./harness-evals.md).
