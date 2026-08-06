# The harness: how Weaver implements the continuity contract

This doc explains the shape of the MVP — what is durable, what is disposable, and where each kernel invariant lives in code. Read [README.md](../README.md) first for the thesis.

## The split

The **durable layer** is a single typed document per workstream (`state/<slug>/workstream.json`, schema in [`src/types.ts`](../src/types.ts)) plus content-addressed artifacts (`state/<slug>/artifacts/`). It holds direction (decisions with supersession lineage), work (assignments with attempt history and adoption state), deliverables (with pinned content hashes), interactions (draft → approval → send → receipt → reply as separate facts), results (evaluated observations and replies), waits (wakes as stored data), human steering, the needs-you queue, and provenance (pass records, a bounded event tail). Every organizational write bumps a revision. Append-only printout sidecars retain exact before/after operator history without becoming coordinator input or changing that revision.

The **disposable layer** is the Claude Agent SDK. A coordinator pass ([`src/coordinator.ts`](../src/coordinator.ts)) is one fresh `query()` whose entire input is the projection and whose only write path is a set of in-process MCP mutation tools; it persists and exits. A worker run ([`src/worker.ts`](../src/worker.ts)) is one fresh `query()` over a briefing plus declared inputs, whose only write path is `submit_result`. Neither gets built-in tools by default (`permissionMode: 'dontAsk'`), neither persists a session (`persistSession: false`), and session ids are stored as provenance only — nothing ever resumes them. The one deliberate exception is **action workers** (below), which get real tools inside an approval gate.

## Actions: touching the real world

There is no channel/adapter layer. A kind-`action` assignment is the single way anything real happens: the worker gets Bash (sandboxed to its approved `cwd`), the operator's real CLIs, and — because an approved action acts *as the operator* — the MCP servers the operator registered for the directories the action touches (`operatorMcpServers` in [`src/worker.ts`](../src/worker.ts), same stored auth as their own sessions).

The lifecycle enforces "the system cannot grade its own homework":

1. **Gated**: created `state: 'gated'` with a mandatory plain-language `approval_ask`; it cannot run until a human approves (structurally checked in both the engine's scheduler and the worker itself).
2. **Executed**: by the worker — or, when a human authored the exact command (`exec.run`), by the ENGINE verbatim with no model in the loop (models judge, humans decide, code executes).
3. **Read back**: `exec.verify` is a shell command the engine runs deterministically; its exit status is the only thing that can call the effect real. Worker prose settles nothing.
4. **Adopted**: both the coordinator's `adopt_submission` tool and the human `weaver adopt` override refuse an action whose readback hasn't run or failed — adoption cannot outrank physics.
5. **Crashed?** A stale action attempt is failed and *read back*, never re-queued — re-inspecting the world is always safe; re-doing the act is not.

## Secrets: names for models, values for shells

Credential values live in `0600` env files under the state dir (global + per-workstream overlay, [`src/secrets.ts`](../src/secrets.ts)). Models — coordinator and workers — only ever see *names* (projection §2, action briefings). The engine injects values into action-worker environments and `exec.run`/`exec.verify` shells, and `redactSecrets` scrubs values from every captured output, artifact, and submission. The structural backstop lives at the single write path: `writeAtomic` refuses any document write that embeds a known secret value, so no ingress (steer, reply, observe, coordinator tool, TUI) can persist one even if its own guard is forgotten. Spawned SDK processes also get `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` stripped — Weaver uses one ambient operator principal from the local Claude Code login. It never mints, extracts, stores, pools, or rotates Claude auth tokens, and it never cycles accounts around provider limits. Operator MCP header values are replaced with Claude Code's supported environment placeholders before the Agent SDK serializes `--mcp-config`; the values travel only in the child environment, never process arguments ([`src/mcpConfig.ts`](../src/mcpConfig.ts)).

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
| Printout deltas survive waits | `mutate()` centrally diffs every typed collection into an immutable sidecar per revision, including eventless writes and exact intermediate before/after values. The sidecar is committed before the matching head and a delivery acknowledgement lives outside organizational revision state. Fleet scope also journals global policy mutations. Authoritative claims are rebuilt from assignment, deliverable, interaction, pass, and action-readback state; the bounded run tail can add best-effort “looked at” observations but can never prove an external effect |
| Conclusions cannot invent outcomes | `conclude_workstream` resolves every cited id through `conclusionEvidenceLabels`: only an adopted deliverable, readback-confirmed action, or standing closure decision is accepted. The durable conclusion stores those ids, never free-form evidence prose |

## The tick, the runner, and the dashboard

`weaver tick` is the entire runtime: recover crashed attempts → resolve unknown sends by readback → execute approved sends (egress checks) → execute human-authored actions → run queued workers whose dependencies settled → run action readbacks → coalesce due wakes into one coordinator pass → repeat until quiescent (bounded). Wake delivery is at-least-once and coalesced: firing marks the wakes, and anything lost to a crash is repaired by the next reconciliation because the underlying facts (submissions, replies, steering) are in typed state regardless.

Ticks are **cross-process exclusive** per workstream (a pid lockfile; a dead holder is reclaimed) so a resident runner plus a manual tick can never double-dispatch a real-world act. `weaver run` is the resident runner: it polls every active workstream (concurrently, default 10) and holds zero state — kill and restart it any time. Budgets are a *runaway backstop*, not spend management: caps default high, workers stop launching past the cap, and one budget attention tells the human.

Agent SDK capacity failures are a separate control path. A coordinator or worker result that reports credit exhaustion, session/rate limiting, overload, or invalid authentication updates the model-indexed `WorkstreamDoc.capacity` field and records a typed infrastructure-backoff wake; it does not fail intended work, immediately retry, contribute a failure strike, or consume the logical coordinator-pass budget. Capacity state, not pass-summary or wake-reason prose, controls dispatch and runner recovery. Credit/auth failures raise one deduped `kind: 'capacity'` card after 3 consecutive backoffs; session/rate/other failures wait 12 before escalating. The runner performs bounded, model-specific capacity probes periodically and when the Claude credential file's metadata changes; a successful probe expedites and clears active backoffs for that model. Only metadata is observed — Weaver never reads or copies the credential. No process or SDK session remains alive while waiting.

Since June 15, 2026, Agent SDK usage on eligible paid Claude plans draws from a separate monthly SDK credit rather than interactive plan limits. Max 20's credit is per-user and non-poolable after a one-time claim; supported overflow is operator-enabled usage credits with Anthropic-side spend caps. That provider billing decision is deliberately outside the runner: Weaver waits and tells the operator how to recover, but never opts into spend or selects another account. Shared production automation belongs on Anthropic's Platform API path, not Weaver's single-operator subscription path. Public contract and official sources: [`docs-public/claude-capacity.mdx`](../docs-public/claude-capacity.mdx).

`weaver watch` is the interactive dashboard (Ink): the needs-you queue first — every item answerable with one keypress (approve/reject/resolve/steer), approval cards in plain language with the actual commands extracted from the briefing — then workstreams and `↻ ROUTINES` (tag `routine`) with next-run times. Everything rendered is a projection of typed state: no transcript parsing, no idle-timer liveness guessing, and an unreadable doc renders as a loud failure, never an empty screen. Human keypresses call the same first-class mutations as the CLI ([`src/humanActs.ts`](../src/humanActs.ts)) so the two write paths cannot drift; a worker failing without a submission goes back to the coordinator to retry and reaches the human only if the coordinator judges it truly stuck.

The dashboard owns the embedded runner's lifetime as well as its alternate screen: `q` aborts future polls, restores the terminal, and exits the disposable process so a non-abortable in-flight SDK call cannot pin it. The singleton lock is released by the process-exit handler only when that process is actually gone; durable attempt recovery handles interrupted work on the next tick.

Uppercase `P` opens the same selection-scoped printout available as `weaver printout [slug]`: a selected item or workstream scopes it locally, while the fleet header scopes it across all workstreams and the global policy store. Preparing the report is a read; only after Ink confirms the frame flushed (or CLI stdout flushes) does a monotonic sidecar cursor acknowledge delivery. That cursor never changes the Workstream revision, while concurrent arrivals beyond the frozen revision remain for the next report. The full-screen view scrolls by line or page, copies the complete unwrapped text with uppercase `C`, and closes with `Escape`; lowercase `p` remains pause. Legacy gaps are labeled; complete sidecar windows are exact.

## Deliberate MVP simplifications

Real acme owns these properly; Weaver simplifies without faking the invariant:

- **One JSON doc per workstream, whole-doc compare-and-swap** instead of per-domain services with their own stores. The revision contract is identical in shape; the granularity is not.
- **The lease is trusted locally** (single machine, expiry only) — no fencing tokens.
- **The provider is a directory** (`world/outbox`). Its job is to be a source of truth that *isn't* Weaver's state, so readback is a real read of a foreign record.
- **Workers run sequentially** in the tick, and worker completion wakes are immediate — parallelism is an engine concern the MVP doesn't need to prove continuity.
- **Evaluators are the coordinator itself** (`evaluate_reply` / `evaluate_observation`) rather than declared evaluator runs.

## Surprises worth knowing

- **Agent SDK `mcpServers` are serialized into the child process's `--mcp-config` argument.** Passing literal HTTP/SSE Authorization headers therefore exposes them to same-user process listings. Hoist static header values into generated environment variables before calling `query()`; Claude Code officially expands `$VAR` / `${VAR}` in MCP headers. Diagnostics must match process names only and never print arguments.
- **The Agent SDK works with the machine's Claude Code login** — no `ANTHROPIC_API_KEY` is required when the CLI is authenticated. As of June 15, 2026, paid-plan SDK usage has its own claimed monthly credit rather than consuming interactive limits; exhaustion can arrive as an SDK error result instead of a thrown exception, so both result and exception paths must enter the same durable backoff. Weaver's local subscription mode deliberately remains one ambient operator principal; shared CI or production automation belongs on the Platform API path.
- `settingSources` defaults to none in SDK v0.3.x, so passes are hermetic by default — no user/project settings or CLAUDE.md leak into coordinator context. That hermeticity is load-bearing: the projection must be the whole position.
- Yarn 4 + the `typescript` package: bare `yarn add -D typescript` resolved to the TS 7 native preview, which broke Yarn's patch protocol. Pinned to `^5.9.0`.
