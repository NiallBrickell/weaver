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

Within a band, slots go to the stream a runner served longest ago. That order
is read from each stream's own recorded passes and worker attempts, so it
survives a runner restart: a freshly started runner (the self-updater restarts
it on every release) resumes where the fleet left off instead of starting over
from the top of the alphabet.

## What pause preserves

Pause changes the workstream's durable lifecycle state. It does not cancel or discard its assignments, submissions, decisions, waits, due wakes, or needs-you items. On resume, the runner reads that typed position and continues from it with fresh coordinator and worker runs. No model context, Agent SDK session, or sleeping process is retained to bridge the pause.

An open needs-you item on a paused job remains visible inside that job, but it
does not stay in the fleet-wide **Needs you** queue. Pausing is an explicit
deferral; resuming the job makes any still-open decision interruptible again.

The fleet command applies that same revision-checked transition to each workstream that was active at invocation. It is deliberately not one cross-fleet transaction or a flag outside the workstreams: each outcome remains independently durable and inspectable. The command names every changed and unchanged stream; if one record is unreadable, healthy streams still pause and the command exits non-zero with the failed slug instead of silently omitting it.

## The in-flight boundary

Pause prevents subsequent runner polls and manual ticks from advancing the workstream. The engine re-reads lifecycle state at worker, coordinator, and egress boundaries, so once pause is recorded an in-flight tick starts no next worker, pass, send, or action. A disposable step that was already running may finish and record its result; pausing does not abruptly kill a model call or leave a half-recorded transition. `weaver resume <slug>` makes the stream active again.

## Closing work that should not continue

Pausing keeps a workstream's outcome open for later. When the outcome itself
should not be pursued, close it instead — anyone on the team can, at any point,
without waiting for a coordinator pass:

```bash
weaver close cache-rewrite not_worth_doing "the measured p95 gain was 3ms; not worth the migration"
weaver close onboarding-copy duplicate --duplicate-of onboarding-fix "same objective as the fix stream"
weaver close legal-review directed_closed "handled outside Weaver"
```

The disposition says how the workstream ended:

- `not_worth_doing` — the work is not worth its cost.
- `duplicate` — another existing workstream already owns this objective. `--duplicate-of` must name it; a workstream cannot be a duplicate of itself, and a name that matches no stored workstream is refused.
- `directed_closed` — you are closing it, with no further classification.

`delivered` and `no_change_needed` cannot be used here. They claim that work
was produced or investigated, and only the coordinator concludes that, on
adopted evidence — a person asserting delivery without it is exactly the
self-certification Weaver refuses a model.

Closing is one revision-checked write. Your reason is recorded as steering
attributed to you (`WEAVER_ACTOR` when an agent session acts on your behalf),
and the workstream is concluded through the same validated path a coordinator
conclusion takes, citing that steering as the direction that closed it. Every
pending wake and probe is retired, the stream's open needs-you items are
resolved by the same act, and it counts as one intervention. A workstream that
is already concluded is refused — resume it first if it should end differently.

Nothing in flight is thrown away: assignments, submissions, and approved but
unsent messages stay recorded exactly as they were, frozen the way a pause
freezes them. `weaver resume <slug>` reopens the stream with its history and
the former conclusion kept in lineage.

The [stats page](./stats.md) counts a closed workstream as **closed without
delivery**, never as a successful outcome. The hosted
[operator workspace](./operator-workspace.md) offers the same stop as
**Close as not worth doing** on each job's Activity tab.
