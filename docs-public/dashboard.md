# The dashboard

*See every outcome, what changed, what needs your judgment, and whether it is actually done*

`weaver watch` opens the interactive terminal dashboard. It shows whole outcomes rather than a collection of current agent sessions: what is moving, what changed, what is waiting, what needs you, and what has enough evidence to be called done. Weaver absorbs the routine transitions between research, implementation, review, verification, and retry; your turns are reserved for judgment.

## ⚡ NEEDS YOU

The queue at the top holds exactly three kinds of item:

- **Gated actions** — a workstream wants to touch the real world, and [Pilot](https://github.com/NiallBrickell/pilot) judged it beyond routine-safe. The card is written in plain language (what approving allows, why, blast radius), with the actual commands extracted and shown before anything else. `a` approves, `x` rejects. Routine-safe commands are approved by Pilot itself, on the record as `by:pilot` — what reaches this queue is only what genuinely needs your judgment.
- **Sends** — an outbound message awaits approval. `a` / `x`.
- **Attention** — a verdict, a blocker only you can unblock, or a question. `d` opens a one-line prompt for an optional answer: enter with text resolves the card **with your note** (the coordinator reads it as the actual answer on its next pass), enter on an empty field is a plain dismiss, and esc backs out without touching the card. Resolving a blocker also wakes the stream immediately — your resolution is the unblock signal, so the work resumes without waiting for a scheduled check. `enter` expands the full text (scroll with `[` and `]`).

One decision renders as exactly one row — coordinator commentary about an approvable item folds into the item. Each row leads with what kind of decision it is and ends with how long it has been waiting, and the queue is ordered the same way: a blocker first, then the things one keypress settles (an approval, a gated action, a pending send), then reviews, then the budget and capacity notices that usually clear themselves. Within a rank the oldest is on top, so nothing waits behind a newer card. A pending send shows no age — an interaction records when it was approved and when it went out, never when it was drafted, and an invented age would be worse than none. Pressing `s` on anything opens a steering prompt: type a sentence, and it becomes durable direction the workstream acts on next tick.

Worker failures never appear here. A worker that flakes goes back to the coordinator to retry; it reaches you only if the coordinator itself concludes the assignment is genuinely stuck.

Pilot keeps routine tool decisions from interrupting a live agent run. Weaver keeps completed or failed runs from turning into project-management work for you: it reviews the result, updates the outcome, and starts whatever comes next. A worker finishing is therefore not, by itself, a needs-you event.

## The fleet

Below the queue: every workstream has a state marker — red `NEEDS YOU`, cyan `WORKING`, bright-blue `QUEUED` (in line for the runner), blue `WAITING` (scheduled later), dim `IDLE`, and green reserved for `DONE ✓` alone. Rows show organizational state, not percentage complete. A working row carries honest activity age — for example `▶ sentry-sweep WORKING 12m in flight · decision 2h ago` — from the durable attempt/pass start and last decision timestamp. It is elapsed context, never an estimate of completion. A waiting row says when and what it is waiting for. A provider limit says `WAITING` only when it blocks the next configured coordinator or worker transition: a limited primary coordinator with a usable fallback is degraded, not waiting; an overdue retry or a record for a model no longer configured is history, not a live block. [Routines](./routines.md) render in their own `↻ ROUTINES` section with next-run times. Workstreams spawned by another workstream (`create_workstream` lineage) render nested under their manager with a `↳`, in the manager's section — a routine's fix-children sit visibly under the routine that opened them.

When the active provider reports a fresh plan window, the fleet header adds real headroom such as `⚠ Claude 5h 18% left · resets in 2h` (the warning mark comes from the provider). Weaver keeps the latest observation for 30 minutes, then removes it rather than displaying stale certainty. This signal is deliberately asymmetric: the Claude subscription SDK reports plan-window utilization, while OpenHands/Kimi and other configured providers may not. Missing telemetry means **unknown**, never 100% available, and tokens or SDK dollar estimates are never substituted for quota.

Finished work earns 12 hours on the board (`WEAVER_DONE_LINGER_HOURS` overrides), then leaves it: a concluded workstream lingers long enough for you to see the outcome land, then drops off the list, replaced by one dim tally line. Nothing is deleted — the visual work board, printouts, and `weaver status` read the same typed state — and the header's done count keeps the full total.

Turn counts are not used: they are terminal-only for some executors and unavailable from others, so they cannot be durable dashboard truth. SDK dollar estimates stay out of every operator-facing view because they are neither provider billing nor plan headroom. Coordinator passes and lifetime intervention counts stay out of compact rows; [`weaver stats`](./stats.md) compares human interventions across qualified successful outcomes with the quality and authority guardrails needed to interpret the number honestly.

A `DONE` row answers "so what did it actually do?" in place: select it and its detail lines show the coordinator's informational account, its separately validated typed evidence IDs, and the hard tallies (readback-verified actions, adopted deliverables, passes, interventions), with `i` for the full record. The account cannot make an outcome true; the cited typed facts do that. Outcomes live where you already are, not behind a CLI.

## Catch up with a printout

Press uppercase `P` to write and open an HTML report of everything recorded since the last printout. Like `i`, it follows the cursor: an attention item or workstream selects that workstream; move above the first row to the highlighted `W E A V E R` header for every workstream plus global policy activity. Lowercase `p` remains pause/resume.

The report is a narrow, long-form engineering document. Every selected workstream and its exact organizational mutation timeline is already present in the page's normal reading flow—there are no cards or collapsed sections to open. The page button or uppercase `C` copies the complete plain-text report. Every published window remains linked under **Catch up** in the visual work board opened by `i`. See [Printouts](./printouts.md) for the checkpoint and truth contract, or run `weaver printout [slug]` outside the dashboard. (`weaver watch --plain` has no hotkey, but the CLI command opens the same page.)

## The visual work board

`i` opens a self-contained, read-only browser view of the current typed state. What it opens follows the cursor: a selected workstream opens that workstream's home; moving above the first row to the highlighted `W E A V E R` header opens the fleet. `weaver inspect [slug]` opens the same pages outside the dashboard.

The fleet is a board of Workstreams, not agent sessions. Its four lanes are **Needs you**, **In motion**, **Waiting**, and **Ready**. Each card leads with the next consequential move, shows recent durable movement when there is any, and links to the outcome's own page. Search narrows the board; filters isolate recent movement and routines; long lanes are bounded rather than becoming an endless wall. Concluded Workstreams remain available under the folded **Done** list.

Inside a Workstream, the board changes level: cards are Assignments in **Planned**, **Working**, **Review**, and **Accepted**. An Assignment enters Accepted only when it is completed **and** its result was adopted. Attempts stay nested under their Assignment as execution history; a finished attempt cannot turn proposed work green. Failed, cancelled, rejected, superseded, and completed-but-unaccepted work stays inspectable in the archive.

Current direction, waits, pinned evidence, action readbacks, interactions, and relevant learned policies stay on the Workstream page without competing with the current work. The full policy store remains a separate **Learned** page. Everything rendered is a projection of typed state: no transcript parsing and no idle-timer liveness guesses. A workstream whose state cannot be read renders as a loud failure, never an empty screen.

Opening or regenerating the board does **not** claim that you read it and does not advance a catch-up cursor. Exact “since I last checked” accounting belongs to a successfully delivered [printout](./printouts.md), whose checkpoint is acknowledged only after browser handoff or stdout delivery succeeds.

## Watching a run work: `weaver tail`

The dashboard shows the outcome spanning many agent runs. Sometimes you want to inspect one of those disposable runs while it happens: `weaver tail <slug>` prints the recent feed and then follows it live — every tool call a worker makes (the command, the file), snippets of what it's saying, and the run's result line. `--all` adds coordinator passes to the feed.

The feed is observability, never truth: it's an append-only file next to the workstream's state, redacted against known secrets before anything touches disk, and nothing in the harness reads it back as authority. Printouts may include these best-effort tool observations to show what a worker looked at, but only typed adoption and deterministic readback can claim that a PR, merge, deploy, or production check actually happened. Session ids remain recorded per attempt as provenance, so `claude --resume <sessionId>` replay is unaffected.
