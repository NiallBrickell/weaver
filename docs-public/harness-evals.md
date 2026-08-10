# Harness evaluations

Weaver owns the durable Workstream, not the agent loop underneath it. Before replacing the current
Claude Agent SDK worker — or adding a remote one — Weaver runs candidate runtimes through the same
real assignment, submission, and adoption boundary.

The durable side of that boundary is already portable: your fleet's memory can live in one plain
Postgres database ([Hosted state](./hosted-state.md)) and disposable bots in any language share it
over the network ([Connecting bots](./bots.md)). The remaining question is *where the worker's model
loop runs*, and this bakeoff is how a new runtime earns that place with evidence rather than
anecdote.

The initial bakeoff supports four explicit targets: the Claude SDK baseline, Codex SDK, OpenCode,
and OpenHands. They are evaluation adapters only; running the suite does not change the executor
used by real Workstreams.

## Run the suite

```bash
yarn eval:harness --list

yarn eval:harness \
  --target codex-sdk=gpt-5.6-sol \
  --target opencode=openrouter/moonshotai/kimi-k3 \
  --target opencode=openrouter/z-ai/glm-5 \
  --repeat 3
```

Every target is explicit. Weaver never falls back to another model or runtime when one fails to
start. OpenCode uses its normal provider login; Codex and Claude use their existing local login or
API configuration.

The local OpenHands target invokes the pinned official Agent Server image and needs Docker plus an
explicit model-provider key:

```bash
WEAVER_OPENHANDS_API_KEY=... yarn eval:harness \
  --target openhands=openrouter/moonshotai/kimi-k3
```

Results are written under `eval-results/` as machine-readable `results.json` and a readable
`report.md`.

The examples pin OpenRouter's current [Kimi K3](https://openrouter.ai/moonshotai/kimi-k3-20260715)
and [GLM-5](https://openrouter.ai/z-ai/glm-5) slugs. The suite avoids a moving "latest" alias so a
result can be reproduced later.

## What passes

Every scenario creates a normal Weaver assignment and accepts the candidate's answer only through
Weaver's `submit_result` surface. Deterministic graders currently cover bounded code repair,
grounded evidence synthesis, a responsive accessible UI build, and a Linear-style PNG screenshot
whose facts are randomized per run and exist only in raster pixels. The visual result must be exact
structured JSON. Image understanding is a base requirement because real Weaver assignments
regularly include screenshots and image-bearing tickets; exact extraction is therefore a hard gate
rather than an optional quality point.

The initial visual case uses a local PNG so it measures model/runtime vision directly. Promotion
also requires an authenticated MCP image-block case matching a screenshot attached to a Linear
ticket; that separately tests connector transport and credential handling.

The selected model must support image input. A text-only model may remain useful for text routes,
but it cannot pass an image assignment; the planned model router records that modality instead of
guessing or silently retrying another model.

Durability and safety are hard gates: a submitted deliverable must exist as a proposal, adoption
must remain separate, and the runtime must report a clean completion. Quality is shown as a vector,
not collapsed into a winner score that could average away a safety failure. Missing usage or cost
data is reported as unavailable, never as zero.

> **A local task-quality result is not proof of production containment.** Host-process candidates
> rely on the environment that launched Weaver, and a local OpenHands container is not a managed
> multi-tenant sandbox. No candidate can enter production selection until confinement and
> supervised-action cases pass as well.

Weaver does not implement its own sandbox for this work. The evals exercise maintained SDKs and the
official OpenHands Agent Server runtime; production containment remains the chosen runtime
provider's responsibility.
