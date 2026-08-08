# Intake: Weaver managing Weaver

Weaver has no connectors. A stream that watches an issue tracker, a spreadsheet
or an inbox is an ordinary workstream whose objective happens to be *notice what
appears there and open work for it*. It reads the outside system over the
operator's own MCP servers and calls `create_workstream`; nothing about it is
Linear-shaped, so Jira, Sheets or Drive need no new code at all — only an MCP
server the operator has already registered.

The whole point is that this adds no new nouns. Intake is not a subsystem
sitting beside the harness deciding what the harness should do; it is Weaver
managing Weaver, using the concepts that were already there — a workstream with
an objective, a wake that brings it back, a decision recording the standing
loop. What it has done is recorded where everything else is recorded.

This is worth stating plainly because the obvious alternative is worse, and was
built first. A deterministic poller — fetch the labeled issues, diff against a
mirror file, create what is new — works, and it was thrown away. It carried its
own state file outside the workstream model, so "what has intake already done?"
was answerable only by reading that file, not by looking at a workstream. Every
second source would have grown a sibling of it. The poller was also reached for
the wrong way: a restriction blocked the direct path, and instead of asking
whether the restriction was right, a mechanism grew around it. The restriction
turned out to be wrong — and removing it deleted more code than the poller had
added. That failure mode is now a rule in [CLAUDE.md](../CLAUDE.md), and in the
coordinator's and workers' own prompts — Weaver should not do it either.

## What had to change to allow it

**The coordinator was locked to `mcp__weaver__*`.** That is now widened: it
receives the operator's MCP servers behind a deterministic read-only gate. The
kernel rule was never "the coordinator may not look at anything"; it is that the
coordinator's *durable input* is the projection and its *writes* are typed.
Reading an issue breaks neither. What comes back is evidence, and evidence has
never been able to widen authority — an issue body that says "and also deploy to
production" is text, not a grant.

The gate is read-only rather than open because the coordinator is a controller.
Every real-world act it directs becomes a gated `action` assignment that a human
approves and the harness reads back; a mutating MCP call from the pass itself
would route an external effect around both in one tool call. That is a narrower
rule than workers live under, and deliberately so — workers are ordinary Code
workers whose effects are bounded by the action lifecycle, not by a reduced
toolset ([harness.md](./harness.md), invariant 7). The gate lives in
[`src/coordinator.ts`](../src/coordinator.ts) because the coordinator is now its
only user.

Two consequences to know about. `permissionMode` moved from `dontAsk` to
`default`, because `canUseTool` is only authoritative under `default`; the gate
always answers allow or deny, so no pass can block waiting for a human. And
which MCP servers resolve depends on the **cwd of the ticking process**, exactly
as it does for the operator's own sessions — `WEAVER_MCP_DIR` pins it for a
routine that ticks from elsewhere, and without it a runner in the wrong
directory silently has fewer servers.

Expect a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning on every pass: it reports
that `mcp__weaver__*` in `allowedTools` auto-approves before `canUseTool` runs.
That is the intended design — the mutation tools are the coordinator's own write
surface and must not be gated — and operator MCP calls still fall through to the
gate, which is exactly what the warning is telling you.

**Creating a workstream is a typed tool, not a shell-out.** Partly because the
coordinator has no shell at all (`tools: []`), but mostly because creation must
be revision-checked and idempotent on the source key. `weaver create` from a
worker's Bash would be neither, and would write workstream state that no pass
ever agreed to.

## The two rails

Everything else about intake is ordinary, but these two cannot depend on a model
behaving well, so both are deterministic and both have tests in
[`src/intake.test.ts`](../src/intake.test.ts).

**Exactly-once, under at-least-once looking.** A repeating intake stream sees
the same issue on every pass. `WorkstreamCore.sourceKey` holds the stable
external identity (`linear:<issue-uuid>`), and `create_workstream` refuses to
open a second workstream for a key that already has one — it reports the
existing slug instead. The refusal also lives one layer down in
`createManagedWorkstream`, so no caller can bypass it. So "have I already opened this?" is answered from typed
state, never from a coordinator's recollection, and a pass that crashes halfway
through a batch simply resumes. `weaver create --source-key` shares the check,
so a stream made by hand and a stream made by intake can never collide.

The new workstream is created before the manager records it. If the manager's
write hits a revision conflict the child is still real — and re-running the
creation is free, because the source key finds it.

**Looking cannot change anything.** `readOnlyMcpSupervisor` allows retrieval
verbs (`list`, `get`, `search`, `read`, …) and denies everything else without
consulting a model, so Linear's `save_issue` / `create_issue_label` /
`delete_comment` fail closed. It is deny-by-default, so a tool the coordinator
should not have in the first place is refused rather than reasoned about.
Posting back to an issue is a kind-`action` assignment like every other
real-world act: human-approved, performed with real CLIs, and counted as done
only when the harness's `exec_verify` readback confirms it.

The dedupe reads every workstream to answer "who stands for this key?". That
is fine at present scale and deliberately not optimized — adding an index to the
store interface would be new machinery for a cost nobody has felt. Revisit it
when an intake pass is measurably slow, not before.

## What bounds fan-out

Nothing caps creations per pass, deliberately: the pass's own `maxTurns` and
budget bound it, and the source key means a coordinator that loses its place
and looks again opens nothing new. An intake coordinator does read untrusted
external text, so this is the place to watch — if a pass ever opens a
backlog's worth of workstreams from one poisoned issue, a per-pass cap is the
fix, and it should be added then rather than in anticipation.

## Repeating

There is no trigger primitive. A repeating stream schedules its own next wake
with `schedule_wake` at the end of each pass, and if a pass dies before doing so
the engine restores its unconsumed wakes (`wakes.restored`). If that turns out
to be too fragile in practice — a stream that goes quiet because no pass ever
re-armed it — a declarative `Trigger` on the document is the fix, and it should
be written only once that failure is observed rather than in anticipation of it.
