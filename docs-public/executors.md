# Where workers run

A Weaver worker is disposable: one fresh run advances one bounded assignment,
publishes a result through Weaver's `submit_result` surface, and exits. *Where*
that run's model loop executes is a substrate choice — it does not change the
durable Workstream contract. That seam is selected by `WEAVER_EXECUTOR`.

The harness always keeps the durable half: it builds the brief, loads the
environment, supervises declared actions, and accepts a submission only through
its own callback. The executor owns only the disposable half — the model loop
and the ordinary coding-agent tools.

## The substrates

| `WEAVER_EXECUTOR` | Where the loop runs | Containment |
| --- | --- | --- |
| `local-sdk` *(default)* | The local Claude Agent SDK `query()` in this process's environment | Host process — the launching machine is the boundary |
| `openhands` | A pinned OpenHands Agent Server container, one per assignment | Agent server — the host working directory is bind-mounted at `/workspace`; the container is `--rm` and always torn down |

An unknown value fails hard before the attempt starts, on purpose: a silent
fallback to local execution would make a misconfigured remote fleet look healthy.

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

## What it does and does not guarantee today

- **Real filesystem containment, not an enforced hostile boundary.** Only the
  assignment's working directory is mounted, so work stays inside `/workspace`.
  This is the right isolation for a cooperating worker; it is not yet a
  multi-tenant or adversarial sandbox. That harder guarantee is tracked as a
  future managed-sandbox target.
- **Actions fail closed.** A declared action needs live, per-call Pilot
  supervision, which the container path cannot route yet. Under
  `WEAVER_EXECUTOR=openhands` an action assignment refuses rather than running an
  unsupervised external effect — capability is never authority. Run action
  workstreams on `local-sdk` until supervised remote actions land.

The evidence path behind this choice — the same assignment and adoption
boundary, run against several candidate runtimes under deterministic durability,
confinement, and quality gates — is described in
[Harness evaluations](./harness-evals.md).
