# Harness bakeoff

Weaver's durable Workstream layer should not depend on one disposable agent loop, and Weaver must
not become a sandbox implementation. This bakeoff evaluates maintained runtimes at the existing
`WorkerExecutor` seam ([`src/executor/types.ts`](../src/executor/types.ts)) before any of them is
allowed into production selection.

This is the *remote-execution* half of the same seam story the rest of the harness already tells.
The durable brain is now genuinely shareable across machines — the knowledge layer lives behind
`StateStore` (plain Postgres via `WEAVER_STORE`), and a fleet of disposable bots keeps its memory in
one Weaver over the network-ingress seam (`weaver serve`, [`src/ingress.ts`](../src/ingress.ts)).
What is *not* yet pluggable is where a worker's model loop actually runs: `selectExecutor()` still
only knows `local-sdk`. Choosing a remote execution vehicle is choosing what fills that slot, and
this bakeoff is how that choice earns its evidence instead of arriving by anecdote.

The candidates are:

- `claude-sdk`: the current production baseline, wrapped only to collect eval telemetry;
- `codex-sdk`: the official TypeScript SDK, one fresh thread per assignment, with
  `workspace-write` and `approvalPolicy: never`;
- `opencode`: the current OpenCode SDK and local server, one fresh server and session per
  assignment; and
- `openhands`: the pinned official OpenHands Agent Server Docker image, one fresh container and
  conversation per assignment.

These adapters live under [`src/evals/`](../src/evals/). They are intentionally absent from
`selectExecutor` ([`src/worker.ts`](../src/worker.ts)): an eval result cannot silently change how
real Workstreams execute.

## What is being tested

Every scenario creates an ordinary Workstream and queued assignment, invokes the real
`runWorker`, and accepts output only through Weaver's authenticated `submit_result` bridge. The
common hard gates prove that a harness-owned candidate deliverable exists, the assignment is
`awaiting_review`, and adoption remains `proposed` and unpinned. The initial corpus adds four
deterministic task-quality probes:

1. `code-repair`: fix an adoption-state selection bug and pass hidden cases while changing one
   allowed file;
2. `evidence-synthesis`: reconcile contradictory typed records without promoting a retracted
   hypothesis;
3. `ui-build`: produce one self-contained responsive and accessible page whose submitted artifact
   exactly matches the file; and
4. `image-understanding`: inspect a PNG Linear ticket whose randomized incident facts exist only in
   raster pixels, then return the exact identifier, stalled percentage, browser, owner, and error in
   a structured JSON artifact.

There is no model judge and no composite winner score. Safety and durability are hard gates;
quality remains a vector so that one failure cannot be hidden by unrelated strengths.
Image understanding is part of the base matrix, not a specialist bonus: Weaver regularly receives
screenshots and image-bearing tickets, so exact extraction is a hard gate and a text-only candidate
cannot be promoted.
The initial visual case uses a local PNG to isolate model/runtime vision. A second promotion gate in
[`TODO.md`](../TODO.md) will deliver the screenshot as an authenticated MCP image content block,
matching the path from a Linear ticket and testing the connector transport separately.
The target model must itself support image input. A text-only model is expected to fail this case
and can still remain a candidate for text-only routes once the model router records modalities
explicitly.

## Running it

List the available candidates and cases:

```bash
yarn eval:harness --list
```

Run one or more explicit targets:

```bash
yarn eval:harness \
  --target codex-sdk=gpt-5.6-sol \
  --target opencode=openrouter/moonshotai/kimi-k3 \
  --target opencode=openrouter/z-ai/glm-5 \
  --repeat 3
```

OpenCode uses its normal provider authentication; run `opencode auth login` once for the selected
provider. The Codex SDK uses the existing Codex login or OpenAI API configuration. The Claude
baseline uses the existing Claude Code login.

The local OpenHands target needs Docker and an explicit provider key:

```bash
WEAVER_OPENHANDS_API_KEY=... yarn eval:harness \
  --target openhands=openrouter/moonshotai/kimi-k3
```

Set `WEAVER_OPENHANDS_BASE_URL` when the provider requires a custom OpenAI-compatible base URL.
The suite never substitutes another model or executor when a target cannot start.
The example slugs are OpenRouter's current
[Kimi K3](https://openrouter.ai/moonshotai/kimi-k3-20260715) and
[GLM-5](https://openrouter.ai/z-ai/glm-5) identifiers; targets stay explicit because a moving
"latest" alias would make results irreproducible.

Each suite writes an ignored directory under `eval-results/` containing `results.json`, a stable
schema with raw nullable telemetry and grader detail, and `report.md`, a human-readable vector
report. Missing tokens or cost stay `null`/`—`; they are never reported as free.

## What this does not prove yet

Local Agent Server isolation means one fresh OpenHands container with only the evaluation workspace
mounted. `host-process` means the Codex, OpenCode, or Claude process relies on the environment that
launched Weaver. Neither label is a claim of production-grade hostile or multi-tenant containment.
The telemetry already carries a third `managed-sandbox` isolation value
([`src/evals/types.ts`](../src/evals/types.ts)) reserved for the managed-runtime trials that a real
remote fleet would run on; no candidate reports it yet. The production choice remains blocked on the
confinement and supervised-action cases in [`TODO.md`](../TODO.md), followed by those managed-runtime
trials.

The important architectural finding so far is that task capability and action authority remain
orthogonal. Codex, OpenCode, and OpenHands can be evaluated for ordinary work, but their current
adapters reject action assignments before launch because they do not yet expose Weaver's live Pilot
supervision contract. Fail-closed is an honest missing capability; silently allowing the action
would invalidate the bakeoff.

## Implementation surprises

- A harness-neutral prompt matters. Calling every candidate a "Claude Code worker" biases tool use,
  so the shared worker contract names a generic coding-agent runtime while the production Claude
  adapter still supplies its normal Code preset.
- The shared `WorkerExecutor` boundary is injectable but not yet fully provider-neutral: its system
  prompt/settings shapes originate in the Claude SDK. Eval adapters consume the narrow fields they
  can honor; production promotion should first replace those leaked types with Weaver-owned shapes.
- Codex's official TypeScript SDK exposes fresh threads, streaming usage, sandbox mode, approval
  policy, and remote MCP configuration, but not a per-tool authority callback. The eval adapter uses
  a required bearer-authenticated MCP bridge and rejects supervised actions.
- The Codex TypeScript SDK also exposes neither the other candidates' turn cap nor a distinct system
  prompt field. Its worker contract is appended to user input and the 40-minute Weaver wall is the
  outer bound; efficiency results are not normalized until that limitation is resolved or reported
  as a capability dimension.
- OpenCode's official server helper inherits raw `process.env` and its `close()` is not an awaited
  process-exit receipt. The eval adapter fails closed when that inheritance would reintroduce
  credentials Weaver stripped; production promotion still needs an observed subprocess-exit test.
- A local quality run is not a sandbox proof. The OpenHands adapter invokes the maintained Agent
  Server image and Docker lifecycle; it does not implement a container runtime or filesystem jail in
  Weaver. Agent Server persistence is directed to container-only `/tmp` paths so its own traces do
  not contaminate the graded workspace.
- Startup telemetry is candidate-native, not a cross-harness benchmark: Codex reports thread start,
  OpenCode reports server readiness, and OpenHands reports Agent Server health. Time to submission,
  by contrast, records only a submission Weaver actually accepted; refused stubs do not win on
  latency.
