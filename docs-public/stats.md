# Does each outcome need you less often?

*Track recorded human interventions beside quality and authority signals, with the denominator stated honestly*

`weaver stats` renders a single self-contained HTML page of fleet-wide metrics — no server, no dependencies, safe to keep open in a tab and regenerate whenever you want a fresh read.

The product target is simple: **over comparable successful outcomes, how often did a person have to step in?** A falling count is encouraging only if the work remains good and the authority boundary stays put.

A **successful outcome** is a qualified typed Workstream conclusion — the coordinator declared the objective met and cited the adopted/verified/standing facts behind it. That is the success denominator for every per-outcome number here. **Adopted work products** are reported right beside it, but always as an explicit *leading indicator, not outcome success*: adoption is valuable evidence that Weaver is absorbing routine supervision, but it is not completion. Rejections, approval paths, policy evidence, and per-workstream detail sit alongside so you can judge the trend rather than merely admire it.

## What's on it

- **The intervention curve** — cumulative recorded human interventions with two lines: the primary divides by **successful outcomes** (qualified conclusions — the product target); the secondary divides by **adopted work products** (the leading indicator, never relabeled as success). A sustained fall across comparable work is evidence that Weaver may be absorbing more routine supervision.
- **Successful outcomes vs adopted work** — the headline tiles read qualified conclusions as success and adopted work products as the distinct leading indicator, so the two can never be conflated.
- **Cost per successful outcome** — total spend over qualified conclusions, with cost per adopted work product kept beside it as a leading indicator.
- **Worker reliability** — first-attempt completion rate (assignments that finished without needing a retry) and retry-recovery rate, from typed attempt history.
- **Coordinator pass health** — logical failures (a pass that ended in error/no-finish on its own merits) are separated from provider-capacity backoff (a pass parked by a capacity, rate, or auth outage — not the coordinator being wrong). A revision-conflict finish counts as neither: it is the revision check working.
- **Who approves the real world** — gated actions per day, split into pilot auto-approvals (within your standing rules) and explicit human keypresses. This ratio is *not* learned: it moves only when you widen the pilot's rules, because authority is structurally excluded from learning. A Pilot auto-approval is delegated authority — it is reported separately from learned-policy effects and never counts as a policy win.
- **Policy population** — every policy starts `shadow` (unproven) and earns `active` through an intervention-free matching workstream; wrong ones are superseded with lineage. Watching active accumulate while shadow drains is watching the system earn trust the slow way.
- **Whose rules accumulate evidence** — policies split by provenance: seeded from your pre-Weaver rules and transcripts vs learned live from corrections. Both earn active status the same way — intervention-free matching work — while rules that do not earn evidence stay in shadow and outgrown ones are superseded.
- **Who absorbs the interruptions** — interventions split into fixed actor buckets: the founder at the keyboard, agent sessions steering on their behalf (actor names carrying a session marker), and a legacy unattributed residual. Agents-on-agents is the intended shape — a Claude session absorbing routine interruptions is cheap, while founder keypresses are the scarce resource the curve should drive down first. The pilot never appears here: auto-approval is delegated authority, not an interruption.
- **Per workstream** — whether the stream reached a qualified conclusion, plus passes, adoptions, rejections, interventions, auto-approval ratio, and cost. The fleet trend is the signal; this table is where to look when it moves.

Every chart has a table view underneath, and the range presets (7d / 30d / 90d / all) scope everything at once.

## Where the numbers come from

Everything is computed from durable typed records — conclusions, steering timestamps, gate approvals, adoption pins, pass records, policy evidence. Nothing is parsed from transcripts, and nothing comes from the bounded event tail (a trend computed from a rolling log would fabricate convergence as old events fall off the end).

Five honesty rules are built in:

- **Adoption ≠ completion.** The success denominator counts a workstream only when it carries a qualified typed conclusion. Adopted work products are reported alongside as a leading indicator, never relabeled as completed outcomes.
- **Provider backoff is not coordinator failure.** A pass parked by a capacity, rate, or auth outage carries a typed infrastructure wait and is bucketed as backoff. Logical failure is reserved for error/no-finish with no such wait. A revision-conflict finish is counted as neither — it is the durability rail doing its job.
- **Pilot approvals are not policy wins.** A Pilot auto-approval is delegated standing authority; it is reported separately from learned-policy effects, so learning can never take credit for an approval it did not cause.
- **Undated interventions are reported, not hidden.** A few intervention kinds (budget and config edits) increment the lifetime counter without leaving a durable timestamp; the dashboard shows them as an explicit remainder instead of silently dropping them from the timeline.
- **One keypress counts once, and only human keypresses count.** An approval that auto-resolves its attention card is one act, not two. Resolutions stamped by system actors (`pilot`, `coordinator`) are never interventions, and legacy records that predate actor attribution fall into the undated remainder rather than being guessed at.

Like every output surface, the rendered page passes through secret redaction before it touches disk.
