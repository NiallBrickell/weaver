# Pausing work

*Stop one workstream or the active fleet without losing its durable position*

Pause one workstream when its outcome should stay intact but no new work should start. Resume also reopens a concluded outcome when later evidence shows that more work is required:

```bash
weaver pause fix-onboarding
weaver resume fix-onboarding
```

Reopening is explicit and revision-checked. Weaver removes the current
completion claim, retains the former conclusion and its evidence in history,
and schedules an immediate fresh coordinator pass. A repeated resume while the
stream is already active is a read-only no-op.

Pause every workstream that is active when you run the command by omitting the slug:

```bash
weaver pause
```

Already paused and done workstreams are left as they are by the fleet-wide pause. A workstream created after the fleet pause starts active; there is no ambient global pause mode. Resume paused workstreams—or explicitly reopen a concluded one—individually with `weaver resume <slug>`.

## When you meant "this one matters more"

Pausing the fleet to get one urgent outcome moving is the blunt version of a
rank. The runner grants a fixed number of slots per poll, so a saturated fleet
makes the urgent stream queue behind background sweeps — but pausing them stops
legitimate work too, and somebody has to remember to resume each one.

```bash
weaver priority nobe-parc-feedback high
```

A stream ranked `high` does not merely go first: while it is due, the runner
reserves most of its slots for the high band, so the urgent stream's own
multi-step work is not competing with a full width of background polls for the
machine. The rest of the fleet keeps a floor of slots rather than none, so a
`low` stream still progresses — more slowly — and nothing is left permanently
starved behind work that runs for hours. The reservation lifts by itself the
moment no high stream is due, which is why ranking is worth reaching for before
pausing: there is nothing to undo. Ranking is a human act — `weaver priority
<slug> normal` returns a stream to the ordinary band.

## What pause preserves

Pause changes the workstream's durable lifecycle state. It does not cancel or discard its assignments, submissions, decisions, waits, due wakes, or needs-you items. On resume, the runner reads that typed position and continues from it with fresh coordinator and worker runs. No model context, Agent SDK session, or sleeping process is retained to bridge the pause.

The fleet command applies that same revision-checked transition to each workstream that was active at invocation. It is deliberately not one cross-fleet transaction or a flag outside the workstreams: each outcome remains independently durable and inspectable. The command names every changed and unchanged stream; if one record is unreadable, healthy streams still pause and the command exits non-zero with the failed slug instead of silently omitting it.

## The in-flight boundary

Pause prevents subsequent runner polls and manual ticks from advancing the workstream. The engine re-reads lifecycle state at worker, coordinator, and egress boundaries, so once pause is recorded an in-flight tick starts no next worker, pass, send, or action. A disposable step that was already running may finish and record its result; pausing does not abruptly kill a model call or leave a half-recorded transition. `weaver resume <slug>` makes the stream active again.
