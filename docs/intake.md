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

## Nothing in the harness had to change for it

Intake needs no new capability anywhere. The coordinator has **no tools onto the
outside world** and needs none: reading a tracker is ordinary worker work. A pass
dispatches a work assignment ("list the open issues in project X, in priority
order, report what each one asks for, and move the ones now in flight or shipped
to their right status"), the worker reads AND writes Linear over the
operator's own MCP servers with the ordinary Code toolset, and submits what it
found. The next pass adopts that submission and calls `create_workstream` for
what is new. Two passes instead of one, and the extra pass is the point: the read
arrives as an adopted deliverable with provenance rather than as raw external
text a coordinator swallowed inline, so "what did we see, and when" is answerable
from typed state like everything else.

This was got wrong once, and the way it went wrong is worth keeping. The first
attempt gave the coordinator the operator's MCP servers directly, behind a
`canUseTool` gate that allowed tool names beginning with a retrieval verb
(`list`, `get`, `search`, …) and denied the rest. It worked, and it was still
wrong. The tell came almost immediately: Linear's `extract_images` — the only way
to actually see a screenshot on a ticket — begins with `extract`, so it was
denied, and the instinct was to add `extract` to the list. A gate whose failure
mode is *silently not seeing the picture* and whose repair is *guess more verbs*
is not a safety mechanism. It contained nothing structurally either: a tool named
`get_and_delete` would have passed it. [PR #27](https://github.com/NiallBrickell/weaver/pull/27)
had already deleted the same heuristic for workers, for the same reason.

So the gate is gone, along with `canUseTool`, the `permissionMode` change, the
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning and `WEAVER_MCP_DIR`. The coordinator
is back to `tools: []`, `permissionMode: 'dontAsk'`, and the weaver mutation
tools — which is what a controller should be. **A restriction that needs an
allowlist to be usable is usually the wrong restriction; the thing to move is the
work, not the boundary.**

**Creating a workstream is a typed tool, not a shell-out**, because creation must
be revision-checked and idempotent on the source key. `weaver create` from a
worker's Bash would be neither, and would write workstream state that no pass
ever agreed to.

## Images are content, not decoration

People put the specifics in the picture — a screenshot of the broken hero image
says what "wrong resolution" means far better than the sentence next to it. A
brief that names a ticket by identifier lets the worker open its images
(`extract_images` on the description or comment body); a brief that paraphrases
the ticket has already thrown them away. Both the coordinator and worker prompts
say this explicitly, and it is the durable reason the coordinator names sources
rather than summarizing them: a summary cannot carry a picture.

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

**How much a manager may take on is a typed fact.** A manager that works its
backlog N-at-a-time has to know how many of its children are still running. §6 of
the projection carries that directly — every managed workstream with its live
status, and the active count stated — derived by `listManagedBy` at pass start.
It deliberately does not come from the notice tail beside it: notices are a
record of things that *happened*, and reconstructing a current position by
replaying history is exactly what a projection exists to prevent. One level only;
a child's own children never appear.

The dedupe reads every workstream to answer "who stands for this key?". That
is fine at present scale and deliberately not optimized — adding an index to the
store interface would be new machinery for a cost nobody has felt. Revisit it
when an intake pass is measurably slow, not before.

## What bounds fan-out

The harness caps nothing per pass, deliberately: the source key means a
coordinator that loses its place and looks again opens nothing new, so the
failure mode fan-out protects against is duplication, and that is already
structural. How *many* a manager runs at once is a property of the workstream —
"keep three in flight, top up as they conclude" is an objective and a standing
decision, read against the live child count in §6, not a harness setting. That
keeps the pacing where the human can change it by steering rather than by
editing code.

An intake coordinator does read untrusted external text (by way of an adopted
worker submission), so this is still the place to watch: if a pass ever opens a
backlog's worth of workstreams from one poisoned issue, a per-pass cap is the
fix, and it should be added then rather than in anticipation.

## Repeating

There is no trigger primitive. A repeating stream schedules its own next wake
with `schedule_wake` at the end of each pass, and if a pass dies before doing so
the engine restores its unconsumed wakes (`wakes.restored`). When a standing
cycle or cadence is superseded, the coordinator cancels each exact obsolete
ordinary wake only when typed basis directly closes its stored course, then
schedules the replacement against the exact new decision or work item; a
bounded read tool pages any backlog by exact id. Harness-owned waits are not
individually coordinator-controlled. If that turns out
to be too fragile in practice — a stream that goes quiet because no pass ever
re-armed it — a declarative `Trigger` on the document is the fix, and it should
be written only once that failure is observed rather than in anticipation of it.
