# Does each outcome need you less often?

*Track recorded human interventions beside quality and authority signals, with the denominator stated honestly*

`weaver stats` renders a single self-contained HTML page of fleet-wide metrics — no server, no dependencies, safe to keep open in a tab and regenerate whenever you want a fresh read.

The product target is simple: **over comparable successful outcomes, how often did a person have to step in?** A falling count is encouraging only if the work remains good and the authority boundary stays put.

Today's curve uses **adopted work products**, not completed Workstreams, as its denominator. Adoption is valuable evidence, but it is not completion. The chart is therefore a leading indicator of whether Weaver is absorbing routine supervision, not proof that successful outcomes need less of you. Rejections, approval paths, policy evidence, and per-workstream detail sit beside it so you can judge the trend rather than merely admire it.

## What's on it

- **The intervention curve** — cumulative recorded human interventions per adopted work product. A sustained fall across comparable work is evidence that Weaver may be absorbing more routine supervision; it is not proof by itself.
- **Work products vs interventions per day** — the same series uncompressed: adopted work products beside recorded human touches.
- **Who approves the real world** — gated actions per day, split into pilot auto-approvals (within your standing rules) and explicit human keypresses. This ratio is *not* learned: it moves only when you widen the pilot's rules, because authority is structurally excluded from learning.
- **Policy population** — every policy starts `shadow` (unproven) and earns `active` through an intervention-free matching workstream; wrong ones are superseded with lineage. Watching active accumulate while shadow drains is watching the system earn trust the slow way.
- **Whose rules accumulate evidence** — policies split by provenance: seeded from your pre-Weaver rules and transcripts vs learned live from corrections. Both earn active status the same way — intervention-free matching work — while rules that do not earn evidence stay in shadow and outgrown ones are superseded.
- **Who absorbs the interruptions** — interventions split by named actor (`WEAVER_ACTOR`): the founder at the keyboard, agent sessions steering on their behalf, teammates. Agents-on-agents is the intended shape — a Claude session absorbing routine interruptions is cheap, while founder keypresses are the scarce resource the curve should drive down first. The pilot never appears here: auto-approval is delegated authority, not an interruption.
- **Per workstream** — passes, adoptions, rejections, interventions, auto-approval ratio, and cost, per stream. The fleet trend is the signal; this table is where to look when it moves.

Every chart has a table view underneath, and the range presets (7d / 30d / 90d / all) scope everything at once.

## Where the numbers come from

Everything is computed from durable typed records — steering timestamps, gate approvals, adoption pins, pass records, policy evidence. Nothing is parsed from transcripts, and nothing comes from the bounded event tail (a trend computed from a rolling log would fabricate convergence as old events fall off the end).

Three honesty rules are built in:

- **Adoption ≠ completion.** The current denominator counts a work product only when a coordinator adopted it and pinned its revision. The dashboard does not relabel those adoptions as completed outcomes.
- **Undated interventions are reported, not hidden.** A few intervention kinds (budget and config edits) increment the lifetime counter without leaving a durable timestamp; the dashboard shows them as an explicit remainder instead of silently dropping them from the timeline.
- **One keypress counts once, and only human keypresses count.** An approval that auto-resolves its attention card is one act, not two. Resolutions stamped by system actors (`pilot`, `coordinator`) are never interventions, and legacy records that predate actor attribution fall into the undated remainder rather than being guessed at.

Like every output surface, the rendered page passes through secret redaction before it touches disk.
