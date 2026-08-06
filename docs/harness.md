# The harness: how Weaver implements the continuity contract

This doc explains the shape of the MVP — what is durable, what is disposable, and where each kernel invariant lives in code. Read [README.md](../README.md) first for the thesis.

## The split

The **durable layer** is a single typed document per workstream (`state/<slug>/workstream.json`, schema in [`src/types.ts`](../src/types.ts)) plus content-addressed artifacts (`state/<slug>/artifacts/`). It holds direction (decisions with supersession lineage), work (assignments with attempt history and adoption state), deliverables (with pinned content hashes), interactions (draft → approval → send → receipt → reply as separate facts), results (evaluated observations and replies), waits (wakes as stored data), human steering, the needs-you queue, and provenance (pass records, a bounded event tail). Every write bumps a revision.

The durable layer has two interchangeable backends behind the `StateStore` interface ([`src/store/types.ts`](../src/store/types.ts)): the fs reference ([`src/store/fs.ts`](../src/store/fs.ts), layout above) and plain Postgres ([`src/store/pg.ts`](../src/store/pg.ts), selected via `WEAVER_STORE=postgres://…`) for hosting the knowledge layer centrally. The revision CAS runs inside a transaction there, tick exclusion is a session-scoped advisory lock (holder death releases it — that's why the pg backend has no pid file), and the same contract-test suite in [`src/store.test.ts`](../src/store.test.ts) runs over both (`WEAVER_TEST_PG_URL`). Machine-local things deliberately stay on fs on both backends: secrets env files, the runner pid lock, the tail's jsonl feed, watch/TUI polling, and the simulated world's outbox.

The **disposable layer** is the Claude Agent SDK. A coordinator pass ([`src/coordinator.ts`](../src/coordinator.ts)) is one fresh `query()` whose entire input is the projection and whose only write path is a set of in-process MCP mutation tools; it persists and exits. A worker run ([`src/worker.ts`](../src/worker.ts)) is one fresh model loop over a briefing plus declared inputs, whose only write path is `submit_result`. Neither gets built-in tools by default (`permissionMode: 'dontAsk'`), neither persists a session (`persistSession: false`), and session ids are stored as provenance only — nothing ever resumes them. The one deliberate exception is **action workers** (below), which get real tools inside an approval gate.

Where the worker's loop *runs* is a substrate choice behind the `WorkerExecutor` seam ([`src/executor/types.ts`](../src/executor/types.ts), selected by `WEAVER_EXECUTOR`; the reference is the local SDK `query()` in [`src/executor/localSdk.ts`](../src/executor/localSdk.ts)). The seam moves only the disposable part: the harness computes every authority-bearing input (tool ceilings, auto-allow list, cwd confinement, sandbox, env) and supplies the two callbacks — live tool supervision and the submit surface — as closures it owns. An executor cannot widen a worker's write surface because it never constructs one; the only path into durable state any executor receives is the harness's `submit` callback. An unknown `WEAVER_EXECUTOR` fails hard before the attempt starts — a silent local fallback would make a misconfigured remote fleet look healthy.

## Actions: touching the real world

There is no channel/adapter layer. A kind-`action` assignment is the single way anything real happens: the worker gets Bash (sandboxed to its approved `cwd`), the operator's real CLIs, and — because an approved action acts *as the operator* — the MCP servers the operator registered for the directories the action touches (`operatorMcpServers` in [`src/worker.ts`](../src/worker.ts), same stored auth as their own sessions).

The lifecycle enforces "the system cannot grade its own homework":

1. **Gated**: created `state: 'gated'` with a mandatory plain-language `approval_ask`; it cannot run until a human approves (structurally checked in both the engine's scheduler and the worker itself).
2. **Executed**: by the worker — or, when a human authored the exact command (`exec.run`), by the ENGINE verbatim with no model in the loop (models judge, humans decide, code executes).
3. **Read back**: `exec.verify` is a shell command the engine runs deterministically; its exit status is the only thing that can call the effect real. Worker prose settles nothing.
4. **Adopted**: both the coordinator's `adopt_submission` tool and the human `weaver adopt` override refuse an action whose readback hasn't run or failed — adoption cannot outrank physics.
5. **Crashed?** A stale action attempt is failed and *read back*, never re-queued — re-inspecting the world is always safe; re-doing the act is not.

## Secrets: names for models, values for shells

Credential values live in `0600` env files under the state dir (global + per-workstream overlay, [`src/secrets.ts`](../src/secrets.ts)). Models — coordinator and workers — only ever see *names* (projection §2, action briefings). The engine injects values into action-worker environments and `exec.run`/`exec.verify` shells, and `redactSecrets` scrubs values from every captured output, artifact, and submission. The structural backstop lives at the single write path: the shared store layer ([`src/store.ts`](../src/store.ts) `mutate`/`createWorkstream`, in front of every `StateStore` backend) refuses any document write that embeds a known secret value, so no ingress (steer, reply, observe, coordinator tool, TUI) can persist one even if its own guard is forgotten — and a future non-fs backend inherits the refusal for free. Spawned SDK processes also get `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` stripped — Weaver rides the local subscription login and a stray exported key must not silently switch billing.

## Where each invariant lives

| Invariant | Enforcement |
|---|---|
| Conversation is never the container | `persistSession: false`; the projection ([`src/projection.ts`](../src/projection.ts)) is assembled from typed state only; a fresh pass gets no transcript access at all |
| Revision-checked writes | `mutate(slug, expectedRevision, fn)` in [`src/store.ts`](../src/store.ts); every coordinator tool call advances a tracked revision, and any external arrival in between makes the next tool call fail with an instruction to finish the pass |
| Single-flight coordinator | `lease` field on the doc; a second pass refuses to start while a live lease exists |
| Adoption ≠ completion | Workers set `state: awaiting_review, adoption: proposed`; only the coordinator's `adopt_submission` sets `accepted`, verifying artifact integrity and pinning `contentHash` at that moment |
| Side-effect-free workers | The worker's tool surface is exactly `submit_result`; drafts are deliverables, sending is a separate interaction lifecycle |
| Authority revalidated at egress | Sends execute in the engine ([`src/engine.ts`](../src/engine.ts)), not in any model run: approval, pinned-hash match, and artifact integrity are re-checked immediately before `providerSend` |
| Unknown result → readback, never re-send | `WEAVER_SEND_UNKNOWN=1` simulates a crash after egress; the interaction goes to `unknown` and the next tick resolves it via `providerLookup` — re-queueing happens only when the provider provably has no record |
| Replies are untrusted | A reply wakes the workstream and is listed as unevaluated input; only `evaluate_reply` (a coordinator act) turns it into a result |
| Summaries cannot mutate truth | `finish_pass` stores the coordinator's summary on the pass record; nothing reads it back into state — the projection is rebuilt from typed collections every pass |
| Wakes are stored data | [`src/clock.ts`](../src/clock.ts) + the `wakes` collection; `weaver advance 5d` moves a persistent offset and `weaver tick` discovers what became due — no process ever sleeps |

## The tick, the runner, and the dashboard

`weaver tick` is the entire runtime: recover crashed attempts → resolve unknown sends by readback → execute approved sends (egress checks) → execute human-authored actions → run queued workers whose dependencies settled → run action readbacks → coalesce due wakes into one coordinator pass → repeat until quiescent (bounded). Wake delivery is at-least-once and coalesced: firing marks the wakes, and anything lost to a crash is repaired by the next reconciliation because the underlying facts (submissions, replies, steering) are in typed state regardless.

Ticks are **cross-process exclusive** per workstream (a pid lockfile; a dead holder is reclaimed) so a resident runner plus a manual tick can never double-dispatch a real-world act. `weaver run` is the resident runner: it polls every active workstream (concurrently, default 10) and holds zero state — kill and restart it any time. Budgets are a *runaway backstop*, not spend management: caps default high, workers stop launching past the cap, and one budget attention tells the human.

`weaver watch` is the interactive dashboard (Ink): the needs-you queue first — every item answerable with one keypress (approve/reject/resolve/steer), approval cards in plain language with the actual commands extracted from the briefing — then workstreams and `↻ ROUTINES` (tag `routine`) with next-run times. Everything rendered is a projection of typed state: no transcript parsing, no idle-timer liveness guessing, and an unreadable doc renders as a loud failure, never an empty screen. Human keypresses call the same first-class mutations as the CLI ([`src/humanActs.ts`](../src/humanActs.ts)) so the two write paths cannot drift; a worker failing without a submission goes back to the coordinator to retry and reaches the human only if the coordinator judges it truly stuck.

## Deliberate MVP simplifications

Real erdo owns these properly; Weaver simplifies without faking the invariant:

- **One JSON doc per workstream, whole-doc compare-and-swap** instead of per-domain services with their own stores. The revision contract is identical in shape; the granularity is not.
- **The lease is trusted locally** (single machine, expiry only) — no fencing tokens.
- **The provider is a directory** (`world/outbox`). Its job is to be a source of truth that *isn't* Weaver's state, so readback is a real read of a foreign record.
- **Workers run sequentially** in the tick, and worker completion wakes are immediate — parallelism is an engine concern the MVP doesn't need to prove continuity.
- **Evaluators are the coordinator itself** (`evaluate_reply` / `evaluate_observation`) rather than declared evaluator runs.

## Surprises worth knowing

- **The Agent SDK works with the machine's Claude Code login** — no `ANTHROPIC_API_KEY` required when the CLI is authenticated (the docs imply the env var is mandatory; empirically the spawned CLI resolves its own credentials). CI/headless will still want the env var.
- `settingSources` defaults to none in SDK v0.3.x, so passes are hermetic by default — no user/project settings or CLAUDE.md leak into coordinator context. That hermeticity is load-bearing: the projection must be the whole position.
- Yarn 4 + the `typescript` package: bare `yarn add -D typescript` resolved to the TS 7 native preview, which broke Yarn's patch protocol. Pinned to `^5.9.0`.
