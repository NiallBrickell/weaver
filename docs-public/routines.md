# Routines

*Standing loops that wake with their decision log, constraints, and learned policies intact*

A routine is an outcome that never ends after one report. It does the current cycle, checks what actually happened, records what the next cycle must know, and schedules its own next wake — an error-triage sweep every 12 hours, an evals-health check daily, a usage report weekly.

```bash
weaver create --slug sentry-sweep --tag routine \
  --title "Sentry sweep" \
  --objective "Each cycle: triage recent issues, root-cause the real ones, open PRs for clear fixes. Schedule the next wake ~12h out. Report only deltas."
```

## Why this beats a cron'd prompt

A scheduled prompt can produce a fresh piece of work on a timer, but the responsibility between cycles still belongs to you. A Weaver routine owns that recurring outcome and wakes up with:

- **Its decision log** — the *standing* judgments that still bind: what counts as noise, which approaches are ruled out, and the one recurring course the routine is committed to. Where that course has got to — which cycle, which step, what it is waiting on — is recorded as *progress* on the course itself, not as a new decision, and what a cycle *found* is kept as a result/deliverable. So the decision log stays a short list of commitments rather than a cycle-by-cycle transcript, however many hundreds of cycles run.
- **Its constraints** — the hard rules you set once ("open PRs, never merge", "targeted tests only").
- **Learned policies** — every correction you made in *any* matching workstream, already applied, still auditable.
- **Verified history** — what it claims it did last cycle was confirmed by readback, so this cycle builds on facts.

Cycle 30 inherits the decisions and corrections from cycles 1–29, then continues the outcome from there. There is no lifetime pass/dollar ceiling waiting to kill a healthy routine. The [rolling execution guard](./execution-safety.md) pauses only rapid model-start churn and resumes automatically. The compact dashboard row shows current in-flight time, last-decision age, and next wake — not a lifetime activity tally. [`weaver stats`](./stats.md) is where intervention load is compared across qualified outcomes with the context needed to judge whether supervision is actually moving away from you.

## How a routine records each cycle

A routine keeps one standing course for its recurring loop — "triage recent issues every 12 hours, root-cause the real ones, open PRs for clear fixes" — and the coordinator advances that course in place with `record_progress` rather than recording a new decision every cycle or step:

```text
dec_7f3a [STANDING] "Triage recent issues every 12h; open PRs for clear fixes"
  progress: cycle 22 · step 2 "fix PR under review" · awaiting [asg_91c2] · basis [del_4e10] · next: adopt the PR result, then re-measure the baseline · as of 2026-09-21T09:00Z (cycle since 2026-09-21T06:00Z) (position, not authority)
```

- **Cycle and step only move forward.** A new cycle may restart its step count and starts its own clock; going backwards is refused, and repeating the current position writes nothing.
- **Progress cites typed facts.** What it waits on must be live work (an assignment, an interaction, or an open question to you); what it rests on must be a result — an adopted deliverable, a readback-confirmed action, or an evaluated observation or reply.
- **Progress is position, never authority.** It cannot adopt work, complete an assignment, or conclude the workstream, and it is not evidence for any of those. If the routine's commitment itself changes — a new cadence, a different scope, a ruled-out approach — the coordinator supersedes the course, and the lineage shows why.
- **Scheduled checks name the course.** Each periodic wake points at the standing course, and its reason is one sentence about what the check is for; where the course stands lives in its progress, not in the wake.
- **You see the position too.** `weaver status` shows each course with its current cycle and step, and the inspect view treats a progress update as the latest thing that happened.

If a routine starts superseding its course over and over — five or more times in 24 hours — the projection names that lineage and tells the coordinator to record progress instead. Decisions also have size limits now (a 200-character title, a 1,500-character rationale): evidence belongs in the deliverables a decision cites, not in the decision.

## Watching something that rarely changes: probes

Many routines exist to notice when something outside Weaver changes — a support inbox, a board column, a remote branch, a status page. Waking a model every half hour to look, and finding nothing new most of the time, spends passes on the looking. A **probe** moves the looking below the model: the routine's coordinator declares one exact read-only command, and the runner re-runs it on a cadence and wakes the routine **only when the output changes**.

What a coordinator schedules looks like this (the `schedule_probe` tool):

```text
reason:          new support tickets need triage
command:         gh issue list --repo acme/support --label inbound --state open --json number,title --jq '.[] | "\(.number) \(.title)"'
cwd:             /srv/weaver/workspaces/support-intake/support
every:           30m
first_check_at:  2026-09-22T06:00:00Z   (optional — anchors the cadence grid)
github_read:     true
course_id:       dec_…                  (the standing decision it serves)
```

- **Print only stable facts.** Ids, states, titles, counts. Never a timestamp, an mtime, or a duration: any byte of difference wakes the routine.
- **Unchanged output costs nothing but the command.** No model runs, and the routine's record is not written.
- **Changed output** arrives as one observation — a short added/removed-lines summary, with the full output kept as an artifact — and the probe re-arms itself with the new output as its baseline. The first check sets the baseline and wakes the routine once.
- **A probe starts inert.** It runs model-written shell repeatedly, so it is approved like an engine-run action: your [Pilot](./actions.md) rules see the exact command and the probe as a whole, and anything Pilot denies or asks about comes to you as an approval card (`weaver approve-action <slug> <wakeId>`, or `a` in `weaver watch`; `weaver reject-action` retires it). Approval covers that exact spec — a different command is a new probe.
- **Minimal environment.** A probe sees `PATH`, `HOME`, `LANG`, only the credentials it names, and — with `github_read` — a GitHub App read-only token for its repository. It never inherits the runner's environment. A credential must also be listed in `WEAVER_PROBE_CREDENTIALS` on the runner (unset means probes get none).
- **Failures stay quiet until they matter.** A failing check backs off (doubling, capped at a day); the third failure in a row — or a missing credential or directory, immediately — wakes the routine once to repair the probe.
- **Limits:** cadence at least 5 minutes, command at most 4 KB, 60 seconds per run, 256 KB of output, three watching probes per workstream.

## Mechanics

- Wakes are stored data, not sleeping processes — the resident runner discovers what's due. Kill the runner for a week; the routine picks up exactly where it stopped. A probe's last-check bookkeeping lives outside the routine's record and holds no truth: lose it and the next check compares against the stored baseline.
- A superseded cycle does not leave its old organizational checks behind. Every new check names the exact decision or work item it serves; the coordinator can cancel it only when typed facts directly close or supersede that same course. The cancellation and basis remain in history, and large backlogs are read in bounded pages rather than dumped into every pass. Probes are cancelled the same way; a probe that keeps failing may cite itself. Infrastructure recovery, execution-safety, immediate-arrival, wall-time, and fired wakes cannot be cancelled individually; validated workstream conclusion retires the remaining waits, probes included, by pass reference.
- The dashboard shows routines in their own `↻ ROUTINES` section with the next-run time.
- `weaver pause <slug>` stops a routine with its state and scheduled wakes intact; `weaver resume <slug>` restarts it. Run `weaver pause` with no slug to pause every currently active workstream. [Pausing work](./pausing.md) explains the fleet boundary. `weaver tag <slug> add routine` converts an existing workstream.
