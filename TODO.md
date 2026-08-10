# Product TODOs

## Goal-first invocation

Starting a Workstream should feel like stating an outcome, not filling in its database record.

Target interaction:

```bash
weaver "find and fix why production syncs are unhealthy" \
  --workspace ~/work/product
```

The command should:

- derive a stable slug and useful title from the goal;
- accept repeatable `--workspace` paths as initial operating context, without requiring a follow-up
  `steer` command;
- apply ordinary defaults for tags, constraints, and runaway backstops;
- create the durable Workstream and queue its first reconciliation in one operation; and
- leave `weaver create` available as the explicit, automation-friendly form.

The everyday path is successful when a person can start useful work by supplying only the outcome
and, when Weaver cannot infer them, the relevant working directories. This is invocation simplicity,
not a different Workstream model: Weaver is already goal-first internally.

## Harness bakeoff

Choose Weaver's disposable worker runtime from evidence, without turning Weaver into an agent
harness or sandbox project. This is the remote-execution half of the seam story: the durable brain
already spans machines over Postgres and `weaver serve`, so the open question is what runtime fills
the still-`local-sdk`-only `selectExecutor` slot.

The initial eval surface is complete:

- [x] Run every candidate through the real `runWorker` boundary and Weaver-owned `submit_result`
  surface; no toy benchmark-only API and no production selector changes.
- [x] Compare the Claude Agent SDK baseline, Codex SDK, OpenCode, and OpenHands with explicit
  executor/model targets and no silent fallback.
- [x] Grade bounded code repair, grounded evidence synthesis, accessible responsive UI, and PNG
  screenshot understanding with deterministic checks; keep adoption proposed and unpinned after
  submission. Image facts exist only in raster pixels, and exact extraction is a hard gate, so
  text-only harnesses fail honestly.
- [x] Record wall time, startup, time-to-submission, usage, cost, provider/model, harness version,
  session, and isolation, preserving unavailable metrics as `null` rather than zero.
- [x] Report durability and safety as non-negotiable hard gates and quality as a vector, with no
  weighted score that can average away an authority failure.

The promotion gates are deliberately still open:

- [ ] Add an adversarial confinement case with an outside-workspace sentinel and secret. It must
  prove that neither can be read (the secret never reaches the submitted artifact) nor changed, and
  that Weaver state is not mounted into the runtime. This gate matters most for a *remote* vehicle:
  it is the difference between "ran the task" and "could be trusted with the task in isolation."
- [ ] Add a fresh-context case with a per-run nonce available only through declared inputs. A
  candidate fails if it resumes context or discovers undeclared state.
- [ ] Add a connector-delivered image case whose authenticated MCP tool returns an image content
  block, matching a screenshot attached to a Linear ticket. The local PNG case proves model/runtime
  vision; this case must also prove transport support without exposing connector credentials.
- [ ] Record model input modalities before launch and add the routing policy that sends image work
  only to a vision-capable target. A text-only GLM target should fail the image case without
  disqualifying GLM from text-only routes.
- [ ] Add the supervised-action matrix: Pilot allow, Pilot deny, provider readback, and unknown
  result recovery. An executor that cannot expose live tool supervision must continue to fail
  closed rather than run action assignments.
- [ ] Add managed production targets that report the reserved `managed-sandbox` isolation. OpenHands'
  local Agent Server container and the current host-process Codex/OpenCode/Claude runs measure task
  behavior; none proves a hostile or multi-tenant production boundary.
- [ ] Add a real subprocess lifecycle probe for every host runtime. In particular, promotion needs
  evidence that OpenCode's SDK-launched server process has exited, not merely that `close()` was
  called.
- [ ] Normalize or report unequal turn/prompt controls before comparing efficiency. The Codex
  TypeScript SDK currently has no `maxTurns` or system-prompt option, so its 40-minute harness wall
  and user-message-appended worker contract are not equivalent to the other candidates.
- [ ] Run at least three repetitions of both a matched-model matrix (same provider/model through
  OpenHands and OpenCode where supported) and each harness's strongest natural stack. Include
  OpenRouter Kimi K3 and GLM-5 targets alongside Codex and the Claude baseline.
- [ ] Promote a production executor only when every durability, confinement, and authority gate
  passes. Compare quality, latency, cost, operability, and capacity only among those survivors.

See [`docs/harness-evals.md`](./docs/harness-evals.md) for commands and the result contract.
