# The harness

*Where each continuity invariant lives — durable typed state, disposable model runs*

The durable layer is a single typed document per workstream plus content-addressed artifacts. The disposable layer is the Claude Agent SDK: every coordinator pass and worker run is a fresh session that exits. These invariants are the kernel — code that blurs them is wrong even when it works:

| Invariant | Enforcement |
|---|---|
| The conversation is never the container | Sessions never persist or resume; the projection is assembled from typed state only — a fresh pass gets no transcript access at all |
| Writes are revision-checked | Every mutation verifies the revision it read; a conflicting arrival (steering, completion, reply) fails the write and forces reconciliation from newer state |
| Single-flight coordination | A stored lease means one coordinator pass at a time; a pid lockfile makes ticks cross-process exclusive, so a resident runner plus a manual tick can never double-dispatch a real-world act |
| Adoption ≠ completion | A worker finishing yields a proposal; only coordinator (or human) adoption makes it authoritative, pinning an immutable content hash — and for actions, adoption structurally requires a passing readback |
| Capability is not authority | Every assignment has the normal Code toolset, including the operator's MCP servers used read AND write — keeping the systems a brief names in sync (a tracker's status, a comment, a label) is ordinary reversible work. `submit_result` is the only way a worker proposes Workstream state; only *irreversible* egress uses a separate action lifecycle |
| Authority revalidated at egress | Sends execute in the engine, never inside a model run — approval, pinned-hash match, and artifact integrity are re-checked immediately before egress |
| Unknown result → readback, never re-send | A crash after egress leaves `unknown`; the next tick asks the provider what actually happened. Exactly-once effects via at-least-once delivery plus idempotent design |
| Replies are untrusted input | An inbound reply can wake the workstream and supply evidence; it cannot grant authority, complete work, or supersede direction by itself |
| Summaries cannot mutate truth | A pass's summary is stored as provenance; nothing reads it back into state — the projection is rebuilt from typed collections every pass |
| Wakes are stored data | No process sleeps; the runner discovers what became due. Kill everything, restart, nothing is lost |
| Runaway activity self-parks | Every model start is claimed against durable pass/attempt timestamps. At 30 starts in a rolling physical hour, intended work stays pending behind one typed wall-time wake and resumes automatically; SDK dollar estimates never gate execution. [Execution safety](./execution-safety.md) |
| Infrastructure outages cost waiting, not strikes | A coordinator or worker hitting plan/session/rate limits, overload, or auth failure writes executor/provider/model-scoped `WorkstreamDoc.capacity` state and parks only that target behind a typed backoff wake; workers keep moving and the coordinator uses one configured fallback while available. The dashboard says `WAITING` only when this blocks the next intended transition. Auth surfaces one recovery card immediately; other capacity failures get 12 backoffs to self-clear. Weaver retries at the provider reset, probes only local Claude SDK targets on Claude credential-metadata change, or makes the wait due after explicit `weaver capacity retry`. Fresh provider-reported headroom may appear in the fleet header; missing telemetry stays unknown. [Recovery stays single-principal](./claude-capacity.md): Weaver never changes billing, handles tokens, or cycles accounts |
| Action authority is explicit | A worker has two lifecycles: `work` (bounded, reversible, proposes a result — MCP servers used read and write to keep trackers in sync are ordinary work) and `action`. The line is consequence, not tool: only *irreversible* egress — sending a message to a person, spending, or pushing/merging/deploying code — is directed through a gated, Pilot-supervised action and becomes fact only after deterministic readback |

## The projection

Every coordinator pass receives the same nine-part view assembled from state: objective and constraints → authority and execution safety → current operating state → standing decisions (with lineage and any matching learned policies) → assignments → open loops (needs-human, unconsumed steering, live interactions) → what arrived since the last pass → a bounded narrative tail (context, never authority) → versions. If a coordinator seems to "forget" something, the bug is in the schema or projection — never fixed by resuming a session.

## Tests

Durability and authority rails are covered by a deterministic suite with no model calls — model quality can never make a durability test pass or fail. The live acceptance proof exercises the model-driven layer: fresh coordinators across waits, adoption pinning, readback-never-resend, revision conflicts.
