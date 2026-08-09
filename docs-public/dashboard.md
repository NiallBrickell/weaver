# The dashboard

*See every outcome, what changed, what needs your judgment, and whether it is actually done*

`weaver watch` opens the interactive terminal dashboard. It shows whole outcomes rather than a collection of current agent sessions: what is moving, what changed, what is waiting, what needs you, and what has enough evidence to be called done. Weaver absorbs the routine transitions between research, implementation, review, verification, and retry; your turns are reserved for judgment.

## ⚡ NEEDS YOU

The queue at the top holds exactly three kinds of item:

- **Gated actions** — a workstream wants to touch the real world, and [Pilot](https://github.com/NiallBrickell/pilot) judged it beyond routine-safe. The card is written in plain language (what approving allows, why, blast radius), with the actual commands extracted and shown before anything else. `a` approves, `x` rejects. Routine-safe commands are approved by Pilot itself, on the record as `by:pilot` — what reaches this queue is only what genuinely needs your judgment.
- **Sends** — an outbound message awaits approval. `a` / `x`.
- **Attention** — a verdict, a blocker only you can unblock, or a question. `d` opens a one-line prompt for an optional answer: enter with text resolves the card **with your note** (the coordinator reads it as the actual answer on its next pass), enter on an empty field is a plain dismiss, and esc backs out without touching the card. Resolving a blocker or budget card also wakes the stream immediately — your resolution is the unblock signal, so the work resumes without waiting for a scheduled check. `enter` expands the full text (scroll with `[` and `]`).

One decision renders as exactly one row — coordinator commentary about an approvable item folds into the item. Pressing `s` on anything opens a steering prompt: type a sentence, and it becomes durable direction the workstream acts on next tick.

Worker failures never appear here. A worker that flakes goes back to the coordinator to retry; it reaches you only if the coordinator itself concludes the assignment is genuinely stuck.

Pilot keeps routine tool decisions from interrupting a live agent run. Weaver keeps completed or failed runs from turning into project-management work for you: it reviews the result, updates the outcome, and starts whatever comes next. A worker finishing is therefore not, by itself, a needs-you event.

## The fleet

Below the queue: every workstream with a colored status dot — red `NEEDS YOU`, cyan `WORKING`, bright-blue `QUEUED` (in line for the runner), blue `WAITING` (scheduled later), dim `IDLE`, green reserved for `DONE ✓` alone — plus a spend-estimate bar, pass count, and `you N×`: how many times you've intervened. [Routines](./routines.md) render in their own `↻ ROUTINES` section with next-run times.

Finished work earns 12 hours on the board (`WEAVER_DONE_LINGER_HOURS` overrides), then leaves it: a concluded workstream lingers long enough for you to see the outcome land, then drops off the list, replaced by one dim tally line. Nothing is deleted — knowledge pages, printouts, and `weaver status` read the same typed state — and the header's done count keeps the full total.

`you N×` is this workstream's local score: how many recorded human interventions it needed. [`weaver stats`](./stats.md) compares that across work and keeps rejections and approval boundaries beside the trend, so a quieter system cannot claim success merely by lowering the bar.

A `DONE` row answers "so what did it actually do?" in place: select it and its detail lines show the coordinator's informational account, its separately validated typed evidence IDs, and the hard tallies (readback-verified actions, adopted deliverables, passes, interventions), with `i` for the full record. The account cannot make an outcome true; the cited typed facts do that. Outcomes live where you already are, not behind a CLI.

## Catch up with a printout

Press uppercase `P` to write and open an HTML report of everything recorded since the last printout. Like `i`, it follows the cursor: an attention item or workstream selects that workstream; move above the first row to the highlighted `W E A V E R` header for every workstream plus global policy activity. Lowercase `p` remains pause/resume.

The report is a narrow, long-form engineering document. Every selected workstream and its detailed typed mutation timeline is already present in the page's normal reading flow—there are no cards or collapsed sections to open. The page button or uppercase `C` copies the complete plain-text report. Every published window remains linked under **Printouts** in the HTML knowledge inspector opened by `i`. See [Printouts](./printouts.md) for the checkpoint and truth contract, or run `weaver printout [slug]` outside the dashboard. (`weaver watch --plain` has no hotkey, but the CLI command opens the same page.)

## Knowledge, scoped to the selection

`i` opens the knowledge inspector — decision lineage, adoptions with their pinned hashes, the actions audit, the policies in play, and a durable link to every published printout — rendered as HTML from typed state.

What it opens follows the cursor. With a workstream selected, `i` is that workstream's page. Press `↑` past the top row and nothing is selected — the `W E A V E R` header highlights instead, and `i` opens the fleet page: every workstream plus the global policy store. Both directions link to each other, so you can enter at either end.

Everything rendered is a projection of typed state. No transcript parsing, no idle-timer liveness heuristics; a workstream whose state can't be read renders as a loud failure, never an empty screen.

## Watching a run work: `weaver tail`

The dashboard shows the outcome spanning many agent runs. Sometimes you want to inspect one of those disposable runs while it happens: `weaver tail <slug>` prints the recent feed and then follows it live — every tool call a worker makes (the command, the file), snippets of what it's saying, and the run's result line. `--all` adds coordinator passes to the feed.

The feed is observability, never truth: it's an append-only file next to the workstream's state, redacted against known secrets before anything touches disk, and nothing in the harness reads it back as authority. Printouts may include these best-effort tool observations to show what a worker looked at, but only typed adoption and deterministic readback can claim that a PR, merge, deploy, or production check actually happened. Session ids remain recorded per attempt as provenance, so `claude --resume <sessionId>` replay is unaffected.
