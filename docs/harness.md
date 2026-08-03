# The harness: how Weaver implements the continuity contract

This doc explains the shape of the MVP — what is durable, what is disposable, and where each kernel invariant lives in code. Read [README.md](../README.md) first for the thesis.

## The split

The **durable layer** is a single typed document per workstream (`state/<slug>/workstream.json`, schema in [`src/types.ts`](../src/types.ts)) plus content-addressed artifacts (`state/<slug>/artifacts/`). It holds direction (decisions with supersession lineage), work (assignments with attempt history and adoption state), deliverables (with pinned content hashes), interactions (draft → approval → send → receipt → reply as separate facts), results (evaluated observations and replies), waits (wakes as stored data), human steering, the needs-you queue, and provenance (pass records, a bounded event tail). Every write bumps a revision.

The **disposable layer** is the Claude Agent SDK. A coordinator pass ([`src/coordinator.ts`](../src/coordinator.ts)) is one fresh `query()` whose entire input is the projection and whose only write path is a set of in-process MCP mutation tools; it persists and exits. A worker run ([`src/worker.ts`](../src/worker.ts)) is one fresh `query()` over a briefing plus declared inputs, whose only write path is `submit_result`. Neither gets built-in tools (`tools: []`, `permissionMode: 'dontAsk'`), neither persists a session (`persistSession: false`), and session ids are stored as provenance only — nothing ever resumes them.

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

## The tick

`weaver tick` is the entire runtime: resolve unknown sends by readback → execute approved sends (egress checks) → run queued workers whose dependencies settled → coalesce due wakes into one coordinator pass → repeat until quiescent (bounded). Wake delivery is at-least-once and coalesced: firing marks the wakes, and anything lost to a crash is repaired by the next reconciliation because the underlying facts (submissions, replies, steering) are in typed state regardless.

## Deliberate MVP simplifications

Real acme owns these properly; Weaver simplifies without faking the invariant:

- **One JSON doc per workstream, whole-doc compare-and-swap** instead of per-domain services with their own stores. The revision contract is identical in shape; the granularity is not.
- **The lease is trusted locally** (single machine, expiry only) — no fencing tokens.
- **The provider is a directory** (`world/outbox`). Its job is to be a source of truth that *isn't* Weaver's state, so readback is a real read of a foreign record.
- **Workers run sequentially** in the tick, and worker completion wakes are immediate — parallelism is an engine concern the MVP doesn't need to prove continuity.
- **Evaluators are the coordinator itself** (`evaluate_reply` / `evaluate_observation`) rather than declared evaluator runs.

## Surprises worth knowing

- **The Agent SDK works with the machine's Claude Code login** — no `ANTHROPIC_API_KEY` required when the CLI is authenticated (the docs imply the env var is mandatory; empirically the spawned CLI resolves its own credentials). CI/headless will still want the env var.
- `settingSources` defaults to none in SDK v0.3.x, so passes are hermetic by default — no user/project settings or CLAUDE.md leak into coordinator context. That hermeticity is load-bearing: the projection must be the whole position.
- Yarn 4 + the `typescript` package: bare `yarn add -D typescript` resolved to the TS 7 native preview, which broke Yarn's patch protocol. Pinned to `^5.9.0`.
