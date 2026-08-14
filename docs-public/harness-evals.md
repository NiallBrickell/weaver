# Harness evaluations

Weaver owns the durable Workstream, not the agent loop underneath it. Before replacing the current
Claude Agent SDK worker — or adding a remote one — Weaver runs candidate runtimes through the same
real assignment, submission, and adoption boundary.

The durable side of that boundary is already portable: your fleet's memory can live in one plain
Postgres database ([Hosted state](./hosted-state.md)) and disposable bots in any language share it
over the network ([Connecting bots](./bots.md)). The remaining question is *where the worker's model
loop runs*, and this bakeoff is how a new runtime earns that place with evidence rather than
anecdote.

The bakeoff supports six explicit targets: the Claude SDK baseline, Codex SDK, OpenCode,
OpenHands, Pi, and Prime Agent. Running the suite never changes production configuration. Codex
and OpenHands run through the same executor classes available to real Workstreams; OpenCode, Pi,
and Prime Agent remain eval-only.

## Run the suite

```bash
yarn eval:harness --list

yarn eval:harness \
  --target codex-sdk=gpt-5.6-sol \
  --target opencode=openrouter/moonshotai/kimi-k3 \
  --target pi=openrouter/moonshotai/kimi-k3 \
  --target prime-agent=openrouter/z-ai/glm-5 \
  --target opencode=zai-coding-plan/glm-5.3 \
  --repeat 3
```

Every target is explicit. Weaver never falls back to another model or runtime when one fails to
start. OpenCode uses an executor-only provider key behind a run-bound host proxy, not its normal
plaintext provider-auth file:

```bash
weaver secret set ZHIPU_API_KEY --executor
yarn eval:harness --target opencode=zai-coding-plan/glm-5.3 --case code-repair
```

Each case gets a fresh OpenCode home and a minimal child environment with no operator home, Weaver
state path, provider key, SSH agent, or unrelated ambient credential. Weaver waits for the server
process to exit before deleting that home. The server sees only disposable inference and
submission bearers; it remains an explicitly labelled `host-process`, not a managed sandbox.
Subscription-backed Codex and Claude use their existing local logins. Pi and Prime targets require
`provider/model` names. Each runs with a fresh empty harness home and uses only the selected
provider's key from executor-secret scope:

```bash
weaver secret set OPENROUTER_API_KEY --executor
yarn eval:harness --target pi=openrouter/moonshotai/kimi-k3
```

Each Pi/Prime case starts one invocation-local RPC process with `--no-session`. Prime's public CLI
normally delegates RPC sessions to its daemon, so Weaver calls Prime's public embedding entrypoint
inside the fresh child; a process-local no-op extension factory selects the documented in-process
runtime and adds no tool or state. Weaver disables extension, skill, prompt, theme, and context-file
discovery and explicitly loads only its authenticated submission extension. Prime Agent is never
launched with a goal, autonomous mode, a schedule, a daemon socket, continue, resume, or fork. Its
process and RPC state are torn down after the assignment, so none of Prime's session machinery can
become Workstream memory; its RPC session identifier is not recorded in the worker outcome or eval
telemetry.

The local OpenHands target invokes the pinned official Agent Server image through a Docker-compatible
runtime (OrbStack on macOS) and needs an executor-only model-provider key:

```bash
weaver secret set OPENROUTER_API_KEY --executor
yarn eval:harness \
  --target openhands=openrouter/moonshotai/kimi-k3
```

The real key remains behind an ephemeral host proxy; the container receives only a random per-run
inference bearer. OpenHands telemetry calls a model resolved only when the upstream response itself
reports that model id — requested configuration alone is not identity evidence.

Results are written under `eval-results/` (gitignored) as machine-readable `results.json` and a
readable `report.md`.

The examples pin OpenRouter's current [Kimi K3](https://openrouter.ai/moonshotai/kimi-k3-20260715)
and [GLM-5](https://openrouter.ai/z-ai/glm-5) slugs plus Z.ai Coding Plan's exact
[`glm-5.3`](https://docs.z.ai/guides/llm/glm-5.3) model. The suite avoids a moving "latest" alias so
a result can be reproduced later.

## Longitudinal ledger

Suite directories are throwaway; the durable record is `evals/ledger.jsonl` — one JSON line per
case result, checked into git so results survive reclones, travel between machines with the repo,
and land as a reviewable diff. It is append-only, and a `merge=union` attribute keeps appends from
different machines from ever conflicting.

Every fully graded repetition atomically replaces each suite file and appends its ledger row before
the next run starts. If a long cohort is interrupted, its completed prefix remains valid and
ingestable instead of disappearing. Those three writes are deliberately not described as one
cross-file transaction: `results.json` is written first and is the repair source for `--ingest` if
ledger persistence itself is interrupted. Two commands work on the ledger without making any model calls:

```bash
# Replay an existing suite's results.json into the ledger; ingesting the same
# file twice is a no-op (dedupe on suite run, target, case, and repetition).
yarn eval:harness --ingest eval-results/<run>/results.json

# Per cohort x exact adapter epoch x case version: runs, hard-gate pass rate,
# named grade vectors, median/p95 wall time, known cost, cost per passing
# submission, failure spend, and last-run date.
yarn eval:harness --history
```

Missing scores and costs stay excluded from the aggregates — a run whose provider reported no cost
is marked, never counted as free. Cost per pass includes the spend of failed attempts and is shown
only when every run reported cost; failure spend is likewise unknown when any failed run omitted
cost. This table is descriptive, not an automatic routing gate: the
append-only ledger intentionally retains pre-fix failures, and a mean can erase which exact gate
failed. A production routing commitment uses raw versioned adapter/case evidence, at least three
exact repetitions from one cited cohort, and complete hard-gate plus named-quality vectors. That
commitment is a reviewed checked-in registry entry; appending ledger rows alone never changes
routing.

Cost policy: the standing eval cadence runs subscription-backed targets through the machine's
existing Claude Code, Codex, and Z.ai Coding Plan access rather than presenting catalog zeroes as
per-token billing. Their ledger cost remains unknown unless the provider reports a real bill.
OpenRouter targets are confined to cheap open-weight models, and Claude-family models are never
routed through OpenRouter.

The current bounded code-repair comparison is outcome-aware; failed-run spend stays in cost per
successful result:

| Exact target and cohort | Hard-gate passes | Median / p95 wall | Total cost | Cost per pass | Failure spend |
| --- | ---: | ---: | ---: | ---: | ---: |
| `codex-sdk:gpt-5.6-sol` `.3` (`20260814T145942Z`) | 10/10 | 114.0s / 166.9s | — | — | — |
| `opencode:zai-coding-plan/glm-5.3` `.3` (`20260814T213026Z`) | 10/10 | 55.0s / 62.3s | — | — | — |
| `openhands:openrouter/z-ai/glm-5.2` (`20260814T145843Z`) | 10/10 | 33.3s / 42.5s | $0.3025 | $0.0303 | — |
| `openhands:openrouter/z-ai/glm-5` (`20260814T133601Z`) | 10/10 | 75.7s / 82.1s | $0.3240 | $0.0324 | — |
| `openhands:openrouter/moonshotai/kimi-k2.6` (`20260814T133601Z`) | 10/10 | 81.8s / 126.9s | $0.3164 | $0.0316 | — |
| `openhands:openrouter/moonshotai/kimi-k2.7-code` (`20260814T145842Z`) | 8/10 | 58.1s / 95.3s | $0.3551 | $0.0444 | $0.1094 |
| `openhands:openrouter/moonshotai/kimi-k3` (`20260814T125803Z`) | 2/3 | 111.9s / 382.0s | $0.4144 | $0.2072 | $0.2517 |

Codex and Z.ai Coding Plan do not expose a per-run subscription bill, so `—` is unknown rather than
zero. GLM-5.3 passed the full vector 10/10 at a 55.0s median, 52% below Codex's 114.0s median.
OpenHands/GLM-5.2 remains the fastest clean cohort at 33.3s and the cheapest measured OpenRouter
cohort at $0.0303/pass. These compare runtime-plus-model targets, not models in isolation: OpenCode
is a trusted host process while OpenHands is a local container. Kimi K2.7 Code and Kimi K3 both
repaired code in failed repetitions but exited without a valid `submit_result`; those complete
cohorts remain negative routing evidence.

The Codex `.3` cohort qualifies the reviewed text-only bounded-repair route when Codex is already
the configured worker substrate. The OpenHands rows above were collected under the older `.2`
single-mount/submission-only epoch. OpenHands `.3` adds plural mounts and a credential-isolating
host relay for serializable user/local MCP entries, making those rows stale for route qualification;
no OpenRouter model is automatically routed until a fresh `.3` cohort exists and the remaining
project/plugin/managed and Claude.ai/OAuth connector surface is implemented and proven separately.
GLM-5.3 is evaluated through the officially supported OpenCode Coding Plan target, not a guessed
OpenRouter alias. Its provider reports subscription quota rather than a dollar bill, so Weaver
records cost as unknown instead of `$0.00`. OpenCode remains eval-only: model-quality evidence does
not by itself supply the ordinary operator MCP surface or a remote managed-sandbox boundary.
The initial normal-auth canary and interrupted `.2` cohort remain as pre-hardening history; only
`.3` combines the host provider proxy, fresh child home, minimal environment, and awaited exit.

## What passes

Every scenario creates a normal Weaver assignment and accepts the candidate's answer only through
Weaver's `submit_result` surface. Deterministic graders currently cover bounded code repair,
grounded evidence synthesis, a responsive accessible UI build, a Linear-style PNG screenshot whose
facts are randomized per run and exist only in raster pixels, workspace confinement — a secret
planted just above the workspace that the candidate must neither leak nor change while doing a benign
in-workspace task — and fresh-context grounding, a per-run nonce that lives only in the declared
current input, so a candidate must read this run's input rather than resume a prior session or answer
from a superseded value. The visual result must be exact structured JSON. Image understanding is a base requirement because real Weaver assignments
regularly include screenshots and image-bearing tickets; exact extraction is therefore a hard gate
rather than an optional quality point.

The initial visual case uses a local PNG so it measures model/runtime vision directly. The `.3`
relay has a deterministic authenticated MCP image-block transport test, including credential
confinement. An automatic image-capable remote route additionally requires a model-facing
authenticated connector case matching a real screenshot-bearing ticket; text-only route evidence
does not need to pretend the model can consume images.

The selected model must support image input. A text-only model may remain useful for text routes,
but it cannot pass an image assignment; the planned model router records that modality instead of
guessing or silently retrying another model.

Durability and safety are hard gates: a submitted deliverable must exist as a proposal, adoption
must remain separate, and the runtime must report a clean completion. Quality is shown as a vector,
not collapsed into a winner score that could average away a safety failure. Missing usage or cost
data is reported as unavailable, never as zero.

> **A local task-quality result is not proof of production containment.** Host-process candidates
> rely on the environment that launched Weaver, and a local OpenHands container is not a managed
> multi-tenant sandbox. OpenHands is an available production remote executor
> (`WEAVER_EXECUTOR=openhands`, see [Where workers run](./executors.md)), but that promotion is
> scoped to explicitly configured cooperative work assignments: its container mounts only the declared assignment directories, and an
> action assignment fails closed there. Enforced multi-tenant isolation and supervised remote actions
> are what the still-open confinement and supervised-action gates widen it to.

Weaver does not implement its own sandbox for this work. The evals exercise maintained SDKs and
CLIs plus the official OpenHands Agent Server runtime; production containment remains the chosen
runtime provider's responsibility. Pi and Prime also reject action assignments before starting a
bridge or process because neither adapter exposes live Pilot supervision. Their fresh homes hide
personal harness logins and unrelated provider keys, but the selected key is still present in the
host child process for provider authentication; use these candidates only with the frozen trusted
eval corpus until an inference proxy or isolated runtime removes that key from model tool reach.
