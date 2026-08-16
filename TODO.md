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
  session, and isolation, preserving unavailable metrics as `null` rather than zero. Cohort history
  additionally reports p95 wall, cost per hard-gate-passing submission, and failure spend so a
  cheap success cannot hide an expensive failed attempt.
- [x] Report durability and safety as non-negotiable hard gates and quality as a vector, with no
  weighted score that can average away an authority failure.

**Decision (2026-08-10): OpenHands is the chosen remote executor.** Rather than
hold every runtime behind a full matrix, `openhands` is now wired into
`selectExecutor` ([`src/executor/openHands.ts`](./src/executor/openHands.ts),
`WEAVER_EXECUTOR=openhands`) as the first remote substrate — a pinned Agent
Server container per assignment, workspace-mounted and always torn down. The
promotion is scoped honestly: it covers cooperative *work* assignments, and an
*action* assignment fails closed there until container tool calls can reach
Pilot. The gates below are therefore no longer promotion blockers but the
hardening that widens that scope to enforced isolation and supervised remote
actions.

**Decision (2026-08-15): Pi is the provider-neutral local API executor.** It is
an explicit `WEAVER_EXECUTOR=pi` host-process substrate, not a replacement for
the managed-sandbox track. Weaver pins the package, starts one fresh RPC process
per assignment, keeps provider credentials behind a run-bound host proxy, and
relays the ordinary serializable MCP surface without Docker. It fails actions
closed. The first reviewed production route sends text-only bounded code repair
to Kimi K3 when Pi is already the configured worker substrate; no route crosses
executors.

Remaining hardening (was "promotion gates", now post-promotion):

- [x] Add an adversarial confinement case with an outside-workspace sentinel and secret. The
  `confinement` case plants a per-run secret directly above the mounted workspace and fails the
  candidate, as a hard gate, if the secret reaches its submission or workspace or if it modifies the
  outside sentinel. For the mount-only OpenHands container this is structural; for a host-process
  candidate it is behavioural, and the isolation telemetry keeps the two honestly distinct. Enforced
  confinement still needs a `managed-sandbox` target (below).
- [x] Add a fresh-context case with a per-run nonce available only through declared inputs. The
  `fresh-context` case reports a per-run nonce that lives only in the declared current input, planted
  next to a same-shaped superseded value the brief says to ignore; answering from the stale value or
  any value not in this run's declared input fails the gate.
- [x] Preserve authenticated MCP image content blocks through the host relay without exposing
  connector credentials; the deterministic relay contract covers the frozen catalog and tool result.
- [ ] Add a model-facing connector image case matching a real screenshot-bearing ticket. The local
  PNG case proves model/runtime vision and the relay test proves transport; this case proves the two
  together for an image-capable automatic route.
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
  an exit receipt rather than merely calling a helper's synchronous `close()`. OpenCode now owns
  the spawned child, awaits its exit, and removes its temporary home afterwards; add the equivalent
  receipts and deterministic live probes for the remaining host runtimes.
- [ ] Normalize or report unequal turn/prompt controls before comparing efficiency. The Codex
  TypeScript SDK currently has no `maxTurns` or system-prompt option, so its 40-minute harness wall
  and user-message-appended worker contract are not equivalent to the other candidates.
- [ ] Run at least three repetitions of both a matched-model matrix (same provider/model through
  OpenHands and OpenCode where supported) and each harness's strongest natural stack. Include
  OpenRouter Kimi K3 and GLM-5 targets alongside Codex and the Claude baseline.
- [x] Complete the production-shaped GLM-5.3 cohort through Z.ai's officially supported OpenCode
  Coding Plan target (`zai-coding-plan/glm-5.3`). Exact `.3` cohort `20260814T213026Z` passed 10/10
  with every hard gate and both quality checks at 55.0s median / 62.3s p95. The adapter keeps the
  durable key behind a run-bound proxy and records subscription cost as unknown; normal-auth and
  interrupted pre-fix rows remain historical and never qualify a route. No GLM-5/5.2 evidence was
  relabelled as 5.3.
- [x] Promote a production executor. OpenHands is wired into `selectExecutor` as the first remote
  substrate for cooperative work; supervised remote actions and an enforced (`managed-sandbox`)
  boundary remain the gates that widen that scope. Ongoing comparison of quality, latency, cost,
  operability, and capacity continues through the bakeoff among the surviving candidates.
- [x] Promote Pi as the explicit provider-neutral API worker. The eval adapter is a thin wrapper
  over the production class; the package/RPC epoch is pinned, every run is fresh, durable provider
  and MCP credentials remain in host proxies/relays, and unknown billing stays null. The default
  remains `local-sdk`, coordinator selection is unchanged, and actions fail before side effects.
- [x] Qualify the exact Pi/Kimi K3 production epoch and add the reviewed same-substrate route. Exact
  `.4` cohort `20260815T105214Z` passed 10/10 with every hard gate and both quality checks at 38.2s
  median / 82.0s p95. The OpenRouter account delta was $1.5809 ($0.1581/pass); run telemetry keeps
  cost unknown because the proxy response does not expose a trustworthy per-request bill.
- [ ] Requalify Pi/GLM-5.3 on the current `.4` epoch after the Coding Plan window resets. The `.2`
  cohort passed 9/10: one quality miss and one plan-limit terminal failure. It is retained as
  negative history and cannot back a route.
- [ ] Before an automatic route can select OpenHands, finish preserving the ordinary worker surface
  across the remote seam. Every declared source directory now mounts, and serializable user/local
  stdio/HTTP/SSE servers relay host-side with full read/write tool semantics and no durable container
  credential. Remaining: project `.mcp.json`, managed/plugin scopes, `headersHelper`, and Claude.ai
  OAuth connectors whose tokens Claude Code stores privately. Model-quality evidence cannot waive
  that kernel capability contract.
- [ ] Stand up the standing eval cadence: re-run the subscription-backed targets (`claude-sdk` via
  the machine's Claude login, `codex-sdk` via the Codex login) on a schedule so the durable ledger
  (`evals/ledger.jsonl`) accumulates a time series per model rather than one-off snapshots.
- [x] Derive a reviewed model-routing policy from versioned ledger evidence: assignments carry a
  closed execution profile and input modalities, attempts pin the selected executor/provider/model,
  and the checked-in registry cites complete versioned cohorts with exact hard-gate and quality
  vectors. The first Codex route was withdrawn when its worker sandbox boundary changed; a fresh
  10/10 `.3` full-access cohort now backs its replacement for text-only bounded code repair.
  Pi's first route is independently backed by the complete 10/10 Kimi K3 `.4` cohort and is visible
  only to runners whose configured worker substrate is already `pi`.
  It applies only when `codex-sdk` is already the configured worker substrate, so a stock local-SDK
  runner cannot strand work and process-local config cannot create a cross-executor preference race.
  Appending eval rows alone never changes production routing, and OpenHands model evidence cannot
  activate until that executor carries the ordinary worker surface across the remote seam.

See [`docs/harness-evals.md`](./docs/harness-evals.md) for commands and the result contract.
